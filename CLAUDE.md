# หนูเก็บ (nookeb) — Claude Code Context

## Project Overview
LINE-integrated file archiving SaaS. Users send files via LINE OA → stored permanently
in Cloudflare R2 → accessible via Next.js Web Dashboard. Supports folders/tags/search,
multi-page scan-to-PDF, LINE group shared spaces, team invites, image OCR, storage
quota + analytics, an admin panel, and Google Drive export.

## Tech Stack (FIXED — do not change without asking)
- API: Node.js + TypeScript + Fastify 4.x
- Frontend: Next.js 14 App Router + TypeScript
- Database: PostgreSQL via Supabase (use Supabase client, NOT raw pg)
- Storage: Cloudflare R2 (S3-compatible, use @aws-sdk/client-s3)
- Queue: BullMQ + Redis (Upstash) — REDIS_URL must be `rediss://` (TLS) for Upstash
- Auth: LINE Login → app-signed JWT (HS256, `jsonwebtoken`)
- Images: `sharp` (thumbnails, page normalization) · PDF: `pdf-lib` · OCR: `tesseract.js` (tha+eng)
- Google Drive: raw `fetch` to Google OAuth + Drive API (no googleapis dep)

## Key Engineering Rules
1. LINE Webhook MUST reply within 1 second → reply 200 immediately, process events in
   `setImmediate`, and enqueue async jobs for file ops.
2. Always verify LINE webhook signature (X-Line-Signature HMAC-SHA256) over the RAW body —
   a scoped `application/json` buffer content-type parser preserves the exact bytes.
3. Never store files locally — always stream directly to/from R2 (no temp files on disk).
4. Multi-tenant isolation is enforced in the API via `isSpaceMember` / `getMemberRole`
   checks. The API/worker use the Supabase SERVICE ROLE key, which BYPASSES RLS — so RLS
   policies are a backstop, not the primary guard. Every space-scoped route must check
   membership explicitly.
5. File downloads MUST use presigned URLs (expire 1 hour) — never proxy binary through the API.
6. Soft-delete only (set `deleted_at`) — never hard DELETE files rows. A daily purge job
   removes the R2 OBJECTS of files soft-deleted past the retention window, then stamps
   `files.purged_at` so later runs skip them; the row is kept as a tombstone.
7. BullMQ custom `jobId` must NOT contain `:` — sanitize with
   `` `${prefix}-${id.replace(/[^a-zA-Z0-9-_]/g, '-')}` `` (LINE message ids contain `:`).
8. Storage accounting: adjust `users.storage_used` ONLY via `adjustStorageUsed`, which calls
   the atomic `increment_storage_used(p_user_id, p_delta)` RPC (migration 003) — never do a
   read-modify-write (worker concurrency would race it). New users get `DEFAULT_STORAGE_LIMIT`
   (10 GB free tier).
9. File-bearing jobs (`upload_file`, `add_scan_page`, `finalize_scan`) run with retry
   (`attempts: 3`, exponential backoff) because LINE CDN content has a ~1h TTL and the user
   was already told "received". Their handlers MUST stay safe to re-run: `finalize_scan`
   skips sessions not in `processing`, `add_scan_page` dedups by `line_message_id`, and any
   post-store step (thumbnail/OCR enqueue, confirm push) is best-effort (wrapped so it can
   never throw and trigger a duplicating retry).

## File Processing Flow (upload)
1. LINE sends webhook (image/file message); API replies 200 immediately.
2. Worker resolves user + space. Files sent in a LINE GROUP go to that group's shared team
   space (`ensureGroupSpace`); otherwise the sender's personal space.
3. Quota check (skip + push "space full" message if over limit).
4. Worker downloads binary from LINE CDN (messageId + channel access token), streams to R2
   key `spaces/{space_id}/files/{file_id}/{name}`, sets `files.status = 'ready'`.
5. For images, enqueues `generate_thumbnail` (→ `spaces/{sid}/thumbnails/{fid}/thumb.webp`)
   and `ocr_image` (→ `files.ocr_text`) as separate best-effort jobs.
6. Worker sends a LINE push message to confirm. Steps 5–6 are wrapped best-effort — once the
   file is stored + charged the job is "done", so a failure there can't retry and re-store it.

## LINE Bot Commands (text or rich-menu message actions)
- `สแกน` / `scan` — start scan mode (creates a `scan_sessions` row, status `collecting`)
- images while collecting → `add_scan_page` (stored under `spaces/{sid}/scan-temp/...`)
- `เสร็จ` / `done` — `finalize_scan`: merge pages into one PDF (pdf-lib) → store as a file
- `ยกเลิก` / `cancel` — cancel the session
- `วิธีใช้` / `help` — usage text
- The webhook handles `message` and `join`/`follow` events. There is NO postback handler,
  so rich-menu buttons use `type: 'message'` actions (see `scripts/setup-rich-menu.ts`).

## BullMQ Jobs (queue `nookeb-file-processing`, all handled in `workers/upload.worker.ts`)
`upload_file` · `generate_thumbnail` · `ocr_image` · `add_scan_page` · `finalize_scan` ·
`purge_deleted` (daily repeatable, scheduled on worker startup via `scheduleRepeatableJobs`).
Retries: the three file-bearing jobs get `attempts: 3` + exponential backoff (set at enqueue
in `webhook/line.ts`); `generate_thumbnail`/`ocr_image` retry too but are best-effort. See
engineering rule 9 for the idempotency guarantees each retried handler must uphold.

## Database
- Always use the Supabase client with the service role key in API/workers.
- All content tables carry `space_id` for multi-tenant isolation.
- Migrations in `supabase/migrations/`:
  - `001_initial.sql` — users, spaces, space_members, folders, files, tags, file_tags,
    scan_sessions, scan_pages (+ indexes, RLS on files).
  - `002_google_accounts.sql` — per-user Google refresh token for Drive export.
    NOT auto-applied; run via `supabase db push` or the Supabase SQL editor.
  - `003_reliability.sql` — atomic `increment_storage_used` RPC (see rule 8), `files.purged_at`
    tombstone marker + partial index (rule 6), and `users.storage_limit` default → 10 GB.
    NOT auto-applied; MUST be applied before deploying code that uses the RPC / `purged_at`.
- No direct DB (pg) connection / DDL access from tooling — schema changes go through
  migration files applied manually.

## Project Structure
- `apps/api` — Fastify API + LINE webhook + BullMQ workers
  - `src/routes/` — `webhook/line`, `auth`, `files`, `folders`, `tags`, `spaces`,
    `analytics`, `admin`, `integrations` (Google Drive)
  - `src/services/` — `r2`, `line`, `file`, `space`, `scan`, `purge`, `google`
  - `src/workers/` — `upload.worker` (all job handlers), `index` (entry + repeatable schedule)
  - `src/middleware/` — `auth` (JWT), `line-verify` (signature)
  - `scripts/` — `setup-rich-menu`, `backfill-quota`, `purge-deleted` (dry-run by default)
- `apps/web` — Next.js dashboard (`/dashboard`, `/admin`, `/join`, `/auth/callback`)
- `packages/shared` — TypeScript types + DTO mappers shared between apps
  (rebuild with `npm run build` after changing; API/web import the built `dist`)

## Running Locally
- `npm run dev` (root, turbo) — starts web + API + worker together. The API workspace `dev`
  script runs `dev:api` and `dev:worker` concurrently (`concurrently`). Turbo only runs each
  workspace's `dev` script, so the worker MUST stay bundled into `dev` (not a separate task).
- Production: `npm start` runs the API only — run `npm run start:worker` as a SEPARATE
  process/container so the worker scales independently.
- LINE needs a public HTTPS webhook (tunnel or deploy). Set the webhook URL to
  `<public>/webhook/line`, enable "Use webhook", and turn OFF LINE auto-reply/greeting.
- Redis: use the Upstash `rediss://` URL (TLS). Plain `redis://` to Upstash fails.

## Key Env Vars (see `.env.example`)
- Core: `LINE_CHANNEL_*`, `LINE_LOGIN_CHANNEL_*`, `SUPABASE_*`, `R2_*`, `REDIS_URL`, `JWT_SECRET`
- `DEFAULT_STORAGE_LIMIT` — free-tier quota in bytes (default 10 GB)
- `PURGE_RETENTION_DAYS` — purge R2 objects of soft-deleted files after N days (default 5)
- `ADMIN_LINE_USER_IDS` — comma-separated LINE user ids granted admin access (no DB column)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — Drive export;
  the feature stays disabled until all three are set AND migration 002 is applied.

## Status (built)
- Phase 1 — Core: LINE webhook, R2 upload worker, LINE Login, file list/download, bot reply.
- Phase 2 — Organize: folders, tags, rename/move, name+OCR search, thumbnails, rich menu.
- Phase 3 — Scan & Team: scan-to-PDF, LINE group shared spaces, team invites, image OCR.
- Phase 4 — SaaS (minus billing): 10 GB quota + enforcement, analytics/usage, admin panel,
  Google Drive export, daily R2 purge of long-deleted files.

## Deferred / NOT built
- Plans / Billing / subscriptions (free tier only for now)
- Approval workflows, anything ERP-related
