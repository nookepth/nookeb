import type { SupabaseClient } from '@supabase/supabase-js';
import sharp, { type Sharp } from 'sharp';

/**
 * Vault (ห้องนิรภัย) data access + view-side watermarking. Deliberately NOT
 * part of the files/spaces model — vault rows live in their own table
 * (migration 031) so no share/team/space code path can ever reach them.
 */

export interface VaultFileRecord {
  id: string;
  user_id: string;
  r2_key: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  dek_encrypted: string;
  iv: string;
  created_at: string;
  deleted_at: string | null;
}

/** The only shape that ever leaves the API — no r2_key / dek_encrypted / iv. */
export interface VaultFileDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export function toVaultFileDto(row: VaultFileRecord): VaultFileDto {
  return {
    id: row.id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    createdAt: row.created_at,
  };
}

export function buildVaultKey(userId: string, fileId: string): string {
  return `vault/${userId}/${fileId}.enc`;
}

export async function insertVaultFile(
  supabase: SupabaseClient,
  input: {
    id: string;
    userId: string;
    r2Key: string;
    originalFilename: string;
    mimeType: string;
    fileSize: number;
    dekEncrypted: string;
    iv: string;
  },
): Promise<VaultFileRecord> {
  const { data, error } = await supabase
    .from('vault_files')
    .insert({
      id: input.id,
      user_id: input.userId,
      r2_key: input.r2Key,
      original_filename: input.originalFilename,
      mime_type: input.mimeType,
      file_size: input.fileSize,
      dek_encrypted: input.dekEncrypted,
      iv: input.iv,
    })
    .select()
    .single();
  if (error) throw error;
  return data as VaultFileRecord;
}

export async function listVaultFiles(
  supabase: SupabaseClient,
  userId: string,
  page: number,
  limit: number,
): Promise<{ rows: VaultFileRecord[]; total: number }> {
  const from = (page - 1) * limit;
  const { data, error, count } = await supabase
    .from('vault_files')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);
  if (error) throw error;
  return { rows: (data ?? []) as VaultFileRecord[], total: count ?? 0 };
}

/** Live row, only if owned by `userId` — the ownership check for every view. */
export async function getVaultFile(
  supabase: SupabaseClient,
  userId: string,
  fileId: string,
): Promise<VaultFileRecord | null> {
  const { data, error } = await supabase
    .from('vault_files')
    .select('*')
    .eq('id', fileId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as VaultFileRecord | null) ?? null;
}

/** Soft delete (purge hard-deletes after retention). Returns false when there
 *  was no live row owned by this user — mapped to 404 by the route. */
export async function softDeleteVaultFile(
  supabase: SupabaseClient,
  userId: string,
  fileId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('vault_files')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', fileId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

// --- Watermarking ------------------------------------------------------------
// The vault's real anti-sharing mechanism is traceability, not prevention: a
// screenshot cannot be blocked in a browser, but a leaked one carries the
// viewer's name + timestamp. Tiled diagonally so no crop removes it.

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function watermarkTileSvg(text: string): Buffer {
  // White text with a faint dark stroke stays visible on both light and dark
  // images. NOTE: libvips renders this with system fonts — the deploy image
  // needs a Thai-capable font installed or Thai display names render as boxes.
  return Buffer.from(
    `<svg width="420" height="180" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="210" y="90" text-anchor="middle" transform="rotate(-24 210 90)" ` +
      `font-family="sans-serif" font-size="19" font-weight="600" ` +
      `fill="rgba(255,255,255,0.34)" stroke="rgba(0,0,0,0.18)" stroke-width="0.6">` +
      `${escapeXml(text)}</text></svg>`,
  );
}

/** Output format follows the source mime so the response Content-Type is honest. */
function watermarkOutput(pipeline: Sharp, mimeType: string): Sharp {
  switch (mimeType) {
    case 'image/png':
      return pipeline.png();
    case 'image/webp':
      return pipeline.webp({ quality: 88 });
    default:
      return pipeline.jpeg({ quality: 88, mozjpeg: true });
  }
}

/**
 * Burn "{display name} • {timestamp}" tiled across the whole image. Buffers
 * the decrypted image in memory (sharp needs the full input; vault images are
 * photos, capped by VAULT_MAX_FILE_SIZE_MB).
 */
export async function watermarkImage(
  input: Buffer,
  mimeType: string,
  viewerName: string,
): Promise<Buffer> {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const tile = watermarkTileSvg(`${viewerName} • ${stamp}`);
  const pipeline = sharp(input, { failOn: 'error' })
    .rotate() // honor EXIF orientation before compositing
    .composite([{ input: tile, tile: true }]);
  return watermarkOutput(pipeline, mimeType).toBuffer();
}
