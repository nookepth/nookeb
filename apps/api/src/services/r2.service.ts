import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PassThrough, type Readable } from 'node:stream';
import { config } from '../config';

const PRESIGNED_URL_TTL_SECONDS = 3600; // 1 hour per engineering rules

export function createR2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });
}

export function buildFileKey(spaceId: string, fileId: string, name: string): string {
  return `spaces/${spaceId}/files/${fileId}/${name}`;
}

export function buildThumbnailKey(spaceId: string, fileId: string): string {
  return `spaces/${spaceId}/thumbnails/${fileId}/thumb.webp`;
}

export function buildScanPageKey(spaceId: string, sessionId: string, pageId: string): string {
  return `spaces/${spaceId}/scan-temp/${sessionId}/${pageId}.jpg`;
}

/** Stream download from R2 — used by the thumbnail worker, never buffers to disk. */
export async function getObjectStream(r2: S3Client, key: string): Promise<Readable> {
  const res = await r2.send(new GetObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key }));
  if (!res.Body) throw new Error(`R2 object has no body: ${key}`);
  return res.Body as Readable;
}

/** Thrown when a capped upload stream exceeds `maxBytes` mid-transfer. */
export class SizeLimitExceededError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`upload stream exceeded the ${limitBytes}-byte size limit`);
    this.name = 'SizeLimitExceededError';
  }
}

/**
 * Stream upload — never buffers the whole file in memory or on disk.
 * With `maxBytes` set, the transfer hard-aborts as soon as the byte count
 * passes the cap (throws SizeLimitExceededError); any partial R2 object is
 * cleaned up before rethrowing.
 */
export async function uploadStream(
  r2: S3Client,
  key: string,
  body: Readable,
  contentType: string,
  maxBytes?: number,
): Promise<{ size: number }> {
  // Count bytes through a PassThrough that is the *only* consumer of `body`, so
  // there's no risk of racing lib-storage for the source stream's data.
  let size = 0;
  const counter = new PassThrough();
  counter.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (maxBytes !== undefined && size > maxBytes) {
      counter.destroy(new SizeLimitExceededError(maxBytes));
    }
  });
  // Surface source-stream errors to the counter so `upload.done()` rejects.
  body.on('error', (err) => counter.destroy(err));
  body.pipe(counter);

  const upload = new Upload({
    client: r2,
    params: {
      Bucket: config.R2_BUCKET_NAME,
      Key: key,
      Body: counter,
      ContentType: contentType,
    },
  });
  try {
    await upload.done();
  } catch (err) {
    // Stop pulling from the source (aborts the LINE CDN download) and remove
    // whatever partial object may have landed. DeleteObject on a key that was
    // never written is a successful no-op, so this is safe on any failure.
    body.destroy();
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key }));
    } catch (cleanupErr) {
      console.error(`[r2] partial-object cleanup failed for ${key}:`, cleanupErr);
    }
    throw err;
  }
  return { size };
}

/** Presigned GET — expires in 1 hour. Downloads never proxy through the API. */
export async function presignedGetUrl(
  r2: S3Client,
  key: string,
  downloadName?: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
    ...(downloadName
      ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` }
      : {}),
  });
  return getSignedUrl(r2, command, { expiresIn: PRESIGNED_URL_TTL_SECONDS });
}

export async function deleteObject(r2: S3Client, key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key }));
}
