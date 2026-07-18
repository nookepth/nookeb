import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  APP_URL: z.string().url().default('http://localhost:3001'),
  WEB_URL: z.string().url().default('http://localhost:3000'),

  // Reverse-proxy assumption: dashboard traffic reaches this API through TWO
  // hops (Vercel /api-proxy rewrite → Railway ingress), while webhooks arrive
  // direct (one hop). index.ts therefore hardcodes `trustProxy: true` — a fixed
  // hop count cannot be right for both paths, and `1` resolves request.ip to
  // Vercel's shared egress IP, collapsing every user onto one rate-limit bucket
  // (see the full comment in index.ts before changing this).

  // LINE Messaging API
  LINE_CHANNEL_ID: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),

  // LINE Login (Web Dashboard)
  LINE_LOGIN_CHANNEL_ID: z.string().optional(),
  LINE_LOGIN_CHANNEL_SECRET: z.string().optional(),

  // LIFF app id for ระบบตามงาน (Task Manager). The MINI App migration was
  // REVERTED — the LIFF is hosted under the LINE Login channel again, so this id
  // is a LINE Login channel LIFF (liff.line.me domain). Format
  // `{channelId}-{suffix}`, e.g. 2010750761-abcd1234, where {channelId} is the
  // LINE Login channel id; endpoint URL `${WEB_URL}/liff/tasks`. Optional: when
  // unset, task links in LINE messages fall back to plain WEB_URL links (opens
  // the external browser instead of the in-app LIFF view).
  LINE_LIFF_ID: z.string().optional(),

  // Channel id that ISSUES the LIFF id token — i.e. the audience (`aud`) that
  // LINE stamps into the id token verified at POST /auth/liff. This is ALWAYS
  // the numeric prefix of LINE_LIFF_ID (the LIFF id's prefix IS its owning
  // channel id), which /auth/liff derives automatically and prefers over this
  // var. Kept only as an explicit override for a bare dev setup where
  // LINE_LIFF_ID is unset. IMPORTANT: after the MINI App revert, do NOT set this
  // to an old MINI App channel id — a stale value here is exactly what makes
  // every task page dead-end on "ต้องเชื่อมต่อ LINE" (401 aud mismatch). Leave
  // it UNSET so the LINE_LIFF_ID prefix (the Login channel) is used.
  LINE_LIFF_CHANNEL_ID: z.string().optional(),

  // Supabase
  SUPABASE_URL: z.string().url(),
  // Not used by the API (service-role key is used instead). Kept optional for
  // compatibility — safe to omit.
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().default('nookeb-files'),

  // Redis — BullMQ ต้องใช้ TCP connection (redis:// หรือ rediss://)
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Security
  JWT_SECRET: z.string().min(32),
  // Signs one-time download tokens (?dl_token=). Optional — falls back to a
  // string derived from JWT_SECRET so download tokens can never be confused
  // with session JWTs even if both secrets are the same base value.
  DOWNLOAD_TOKEN_SECRET: z.string().min(32).optional(),

  // Quota — free tier default (bytes). 1 GB (raise it by inviting friends —
  // see referral_tiers / referral.service).
  DEFAULT_STORAGE_LIMIT: z.coerce.number().int().positive().default(1 * 1024 * 1024 * 1024),

  // One-time storage bonus (bytes) granted to a user who redeems someone
  // else's referral code. 0.5 GB.
  REFERRAL_BONUS_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),

  // Retention — R2 objects of soft-deleted files are purged after this many days
  // (free tier; this is also how long a file stays restorable in the trash)
  PURGE_RETENTION_DAYS: z.coerce.number().int().positive().default(5),

  // Trash retention for pro/team-plan users (days). The daily purge keeps their
  // soft-deleted files restorable this much longer than the free default above.
  TRASH_RETENTION_DAYS_PRO: z.coerce.number().int().positive().default(30),

  // Admin — comma-separated LINE user ids that get admin access (no DB column needed)
  ADMIN_LINE_USER_IDS: z.string().optional(),

  // Upload hard cap per file (bytes). Default 1 GB.
  MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(1_073_741_824),

  // Per-user upload rate limits (rolling 1-hour window, in-memory per API instance)
  RATE_LIMIT_FILES_PER_HOUR: z.coerce.number().int().positive().default(50),
  RATE_LIMIT_BYTES_PER_HOUR: z.coerce.number().int().positive().default(5_368_709_120),

  // VirusTotal scanning (optional — scanning is disabled until the key is set)
  // Master on/off switch: even with a key set, scanning stays OFF unless this is
  // exactly 'true' (VT adds ~5-60s per file). Default: off.
  ENABLE_VIRUS_SCAN: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  VIRUSTOTAL_API_KEY: z.string().optional(),
  VIRUSTOTAL_MAX_SCAN_SIZE_BYTES: z.coerce.number().int().positive().default(33_554_432),

  // Scan-enhance pipeline (edge detection + perspective correction + bw/color
  // enhancement) — applies to SCAN (สแกน) session pages only; merge (รวมรูป)
  // pages are always stored plain. EMERGENCY KILL SWITCH: setting the exact
  // string 'false' makes scan sessions ship raw, unprocessed pages (the worker
  // warns per page), so leave it unset in normal operation. Default ON.
  SCAN_ENHANCE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Searchable-text OCR layer in the merged scan/merge PDF (finalize_scan →
  // buildScanPdf). Off by default: only the exact string 'true' enables it.
  SCAN_OCR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Google Document AI (optional high-accuracy OCR). All three DOCUMENT_AI_*
  // vars must be set for it to be used; otherwise tesseract.js is the OCR
  // engine. GOOGLE_APPLICATION_CREDENTIALS is the standard ADC key-file path
  // read by the Google client library itself.
  GOOGLE_DOCUMENT_AI_PROJECT: z.string().optional(),
  GOOGLE_DOCUMENT_AI_LOCATION: z.string().optional(),
  GOOGLE_DOCUMENT_AI_PROCESSOR_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Default color mode for new scan sessions ('bw' | 'color').
  SCAN_DEFAULT_MODE: z.enum(['bw', 'color']).default('bw'),

  // Mistral OCR — powers the "แปลงไฟล์" convert-to-Word feature. The feature is
  // DISABLED (command replies "not available") until the key is set. Pin the
  // model id for cost control: 'mistral-ocr-latest' tracks the newest (pricier)
  // release; OCR 3 is ~half the per-page price of OCR 4.
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_OCR_MODEL: z.string().default('mistral-ocr-latest'),
  // Per-source cap for convert-to-Word (bytes). Mistral OCR accepts up to
  // ~50 MB, but conversion buffers the source in worker memory — keep it small.
  DOCX_CONVERT_MAX_SOURCE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  // ไดอารี่ 365 วัน — per-photo size cap (bytes). Diary photos are buffered in
  // worker memory for validation + thumbnailing, so keep this small. 10 MB.
  DIARY_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  // ห้องนิรภัย (Vault) — PIN-protected encrypted file store (migration 031).
  // The feature is DISABLED (routes reply 503) until the master key is set.
  // Generate with: openssl rand -hex 32. ROTATING/LOSING THIS KEY MAKES EVERY
  // EXISTING VAULT FILE PERMANENTLY UNREADABLE — treat it like a database.
  VAULT_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes hex (openssl rand -hex 32)')
    .optional(),
  // Per-file upload cap for vault (MB). Vault images are buffered in API
  // memory once per view for watermarking, so keep this sane.
  VAULT_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(100),
  // Soft-deleted vault files are hard-purged (R2 object + DB row) after N days.
  VAULT_PURGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Storage warning thresholds (% of the uploader's storage_limit)
  STORAGE_WARN_THRESHOLD_LOW: z.coerce.number().int().min(1).max(100).default(80),
  STORAGE_WARN_THRESHOLD_HIGH: z.coerce.number().int().min(1).max(100).default(95),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  // In production a localhost base URL means the env var was never set —
  // it would leak into user-facing links (LINE messages, invite/join URLs).
  if (parsed.data.NODE_ENV === 'production') {
    for (const key of ['APP_URL', 'WEB_URL'] as const) {
      if (parsed.data[key].includes('localhost')) {
        throw new Error(`${key} is "${parsed.data[key]}" in production — set it to the deployed URL`);
      }
    }
  }
  return parsed.data;
}

export const config = loadConfig();

const adminLineUserIds = new Set(
  (config.ADMIN_LINE_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export function isAdminLineUser(lineUserId: string): boolean {
  return adminLineUserIds.has(lineUserId);
}
