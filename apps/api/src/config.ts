import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  APP_URL: z.string().url().default('http://localhost:3001'),
  WEB_URL: z.string().url().default('http://localhost:3000'),

  // LINE Messaging API
  LINE_CHANNEL_ID: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),

  // LINE Login (Web Dashboard)
  LINE_LOGIN_CHANNEL_ID: z.string().optional(),
  LINE_LOGIN_CHANNEL_SECRET: z.string().optional(),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().default('nookeb-files'),
  R2_PUBLIC_URL: z.string().url().optional(),

  // Redis — BullMQ ต้องใช้ TCP connection (redis:// หรือ rediss://)
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Security
  JWT_SECRET: z.string().min(32),

  // Quota — free tier default (bytes). 10 GB.
  DEFAULT_STORAGE_LIMIT: z.coerce.number().int().positive().default(10 * 1024 * 1024 * 1024),

  // Retention — R2 objects of soft-deleted files are purged after this many days
  PURGE_RETENTION_DAYS: z.coerce.number().int().positive().default(5),

  // Admin — comma-separated LINE user ids that get admin access (no DB column needed)
  ADMIN_LINE_USER_IDS: z.string().optional(),

  // Google Drive export (optional — feature is disabled until these are set)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

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

export const isDriveExportEnabled = Boolean(
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI,
);
