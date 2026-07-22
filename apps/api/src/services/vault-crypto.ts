import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { config } from '../config';

/**
 * Vault envelope encryption (ห้องนิรภัย) — node crypto only, no extra deps.
 *
 * Key hierarchy:
 *   VAULT_MASTER_KEY (env, 32-byte hex)
 *     └─ per-user key  = scrypt(master, salt = userId, 32 bytes)
 *          └─ per-file DEK = randomBytes(32), wrapped with AES-256-GCM
 *
 * File format in R2 (`vault/{user_id}/{uuid}.enc`):
 *   AES-256-GCM ciphertext || 16-byte auth tag
 * The 12-byte file IV lives in `vault_files.iv` (base64); the wrapped DEK in
 * `vault_files.dek_encrypted` as base64(iv(12) || tag(16) || ciphertext(32)).
 *
 * Everything streams — the file body is never buffered here (rule 3). GCM's
 * auth tag can only be verified once the whole stream has been read, so a
 * consumer that stops early (e.g. an HTTP Range response) gets unverified
 * bytes; full reads fail loudly on tampering.
 */

const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Present iff VAULT_MASTER_KEY is configured — routes gate on this. */
export function isVaultConfigured(): boolean {
  return Boolean(config.VAULT_MASTER_KEY);
}

function masterKey(): Buffer {
  if (!config.VAULT_MASTER_KEY) {
    throw new Error('VAULT_MASTER_KEY is not set — vault crypto unavailable');
  }
  return Buffer.from(config.VAULT_MASTER_KEY, 'hex');
}

// scrypt (N=16384 default) costs tens of ms per call — cache derived keys so a
// grid of <img> view requests doesn't re-derive per request. Bounded: evicts
// oldest insertion once full (plenty for one process's active users).
const USER_KEY_CACHE_MAX = 500;
const userKeyCache = new Map<string, Buffer>();

/** Per-user wrapping key: scrypt(VAULT_MASTER_KEY, userId). */
export async function deriveUserKey(userId: string): Promise<Buffer> {
  const cached = userKeyCache.get(userId);
  if (cached) return cached;

  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(masterKey(), userId, DEK_BYTES, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
  if (userKeyCache.size >= USER_KEY_CACHE_MAX) {
    const oldest = userKeyCache.keys().next().value;
    if (oldest !== undefined) userKeyCache.delete(oldest);
  }
  userKeyCache.set(userId, key);
  return key;
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

// ---- generic secret box (non-vault callers) ----
//
// Small AES-256-GCM string box for secrets that must never sit in the DB as
// plaintext — currently the Google refresh token (migration 046; migration 002
// stored one in the clear and 017 dropped the table for exactly that reason).
//
// It shares VAULT_MASTER_KEY (one key to protect, one key to never rotate) but
// derives through a DISTINCT scrypt salt namespace, so a vault file key can
// never decrypt a secret and vice versa. Losing the master key loses these too.

const SECRET_SALT_PREFIX = 'nookeb:secret:v1:';
const secretKeyCache = new Map<string, Buffer>();

/** Per-namespace secret key: scrypt(VAULT_MASTER_KEY, 'nookeb:secret:v1:'+ns). */
export async function deriveSecretKey(namespace: string): Promise<Buffer> {
  const cacheKey = SECRET_SALT_PREFIX + namespace;
  const cached = secretKeyCache.get(cacheKey);
  if (cached) return cached;

  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(masterKey(), cacheKey, DEK_BYTES, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
  if (secretKeyCache.size >= USER_KEY_CACHE_MAX) {
    const oldest = secretKeyCache.keys().next().value;
    if (oldest !== undefined) secretKeyCache.delete(oldest);
  }
  secretKeyCache.set(cacheKey, key);
  return key;
}

/** Encrypt a UTF-8 secret → base64(iv || tag || ciphertext). */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Decrypt a secret produced by encryptSecret — throws on tampering/wrong key. */
export function decryptSecret(key: Buffer, packed: string): string {
  const raw = Buffer.from(packed, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function generateFileIv(): Buffer {
  return randomBytes(IV_BYTES);
}

/** Wrap a DEK under the user key → base64(iv || tag || ciphertext). */
export function wrapDek(userKey: Buffer, dek: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', userKey, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Unwrap `dek_encrypted` — throws on tampering (GCM tag mismatch). */
export function unwrapDek(userKey: Buffer, wrapped: string): Buffer {
  const raw = Buffer.from(wrapped, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', userKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypting readable for upload: emits ciphertext with the 16-byte GCM auth
 * tag appended at the end (matching the R2 file format above).
 */
export function encryptStream(source: Readable, dek: Buffer, fileIv: Buffer): Readable {
  const cipher = createCipheriv('aes-256-gcm', dek, fileIv);
  const out = new PassThrough();
  source.on('error', (err) => cipher.destroy(err));
  cipher.on('error', (err) => out.destroy(err));
  cipher.pipe(out, { end: false });
  cipher.on('end', () => {
    out.end(cipher.getAuthTag());
  });
  source.pipe(cipher);
  return out;
}

/**
 * Decrypting readable for a stored vault object: holds back the trailing
 * 16 bytes as the auth tag, sets it at end-of-stream, and emits plaintext.
 * A truncated/tampered object destroys the stream with an error.
 */
export function decryptStream(source: Readable, dek: Buffer, fileIv: Buffer): Readable {
  const decipher = createDecipheriv('aes-256-gcm', dek, fileIv);
  const out = new PassThrough();

  let tail = Buffer.alloc(0); // always the last ≤16 bytes seen so far
  const splitter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      const buf = Buffer.concat([tail, chunk]);
      if (buf.length > TAG_BYTES) {
        tail = Buffer.from(buf.subarray(buf.length - TAG_BYTES));
        callback(null, buf.subarray(0, buf.length - TAG_BYTES));
      } else {
        tail = buf;
        callback();
      }
    },
    flush(callback) {
      if (tail.length !== TAG_BYTES) {
        callback(new Error('vault object too short — missing GCM auth tag'));
        return;
      }
      try {
        decipher.setAuthTag(tail);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });

  source.on('error', (err) => splitter.destroy(err));
  splitter.on('error', (err) => out.destroy(err));
  decipher.on('error', (err) => out.destroy(err));
  source.pipe(splitter).pipe(decipher).pipe(out);
  return out;
}

/**
 * Byte-window transform for HTTP Range responses: skips `start` plaintext
 * bytes and passes through exactly `length` bytes, then ends its readable
 * side (EOF for the HTTP response). GCM cannot seek, so the caller always
 * decrypts from byte 0 and slices here; the caller is responsible for
 * tearing down the upstream once the window has been consumed (the tag is
 * never verified for partial reads — documented in the module header).
 */
export function byteRange(start: number, length: number): Transform {
  let skipped = 0;
  let sent = 0;
  let ended = false;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      let buf = chunk;
      if (skipped < start) {
        const toSkip = Math.min(start - skipped, buf.length);
        skipped += toSkip;
        buf = buf.subarray(toSkip);
      }
      if (buf.length > 0 && sent < length) {
        const toSend = buf.subarray(0, Math.min(length - sent, buf.length));
        sent += toSend.length;
        this.push(toSend);
      }
      if (sent >= length && !ended) {
        ended = true;
        this.push(null); // window complete — EOF; later writes are ignored
      }
      callback();
    },
  });
}
