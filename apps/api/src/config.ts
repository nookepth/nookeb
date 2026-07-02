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
