# หนูเก็บ (nookeb) — Claude Code Context

## Project Overview
LINE-integrated file archiving SaaS. Users send files via LINE OA → stored permanently
in Cloudflare R2 → accessible via Next.js Web Dashboard. Supports folders/tags/search,
multi-page scan-to-PDF, LINE group shared spaces, team invites, image OCR, storage
quota + analytics, and an admin panel. (Google Drive export was removed — see
migration 017; rebuild securely later if ever needed.)

## Tech Stack (FIXED — do not change without asking)
- API: Node.js + TypeScript + Fastify 4.x
- Frontend: Next.js 14 App Router + TypeScript
- Database: PostgreSQL via Supabase (use Supabase client, NOT raw pg)
- Storage: Cloudflare R2 (S3-compatible, use @aws-sdk/client-s3)
- Queue: BullMQ + Redis (Upstash) — REDIS_URL must be `rediss://` (TLS) for Upstash
- Auth: LINE Login → app-signed JWT (HS256, `jsonwebtoken`)
- Images: `sharp` (thumbnails, page normalization) · PDF: `pdf-lib` · OCR: `tesseract.js` (tha+eng)

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
   (1 GB free tier — raised through referrals, see migration 010 / `referral.service`).
9. File-bearing jobs (`upload_file`, `add_scan_page`, `finalize_scan`) run with retry
   (`attempts: 3`, exponential backoff) because LINE CDN content has a ~1h TTL and the user
   was already told "received". Their handlers MUST stay safe to re-run: `finalize_scan`
   skips sessions not in `processing`, `add_scan_page` dedups by `line_message_id`, and any
   post-store step (thumbnail/OCR enqueue, confirm push) is best-effort (wrapped so it can
   never throw and trigger a duplicating retry).

## File Processing Flow (upload)
0. Normal uploads are BATCHED per user to avoid message spam: the webhook adds each
   image/file event to an in-memory per-user debounce queue (`services/upload-queue.ts`,
   sliding 1500ms window). When the window closes it sends ONE "progress" Flex card (via the
   first event's replyToken, falling back to push) and enqueues ONE `upload_batch` job. The
   worker processes the batch sequentially and sends ONE "summary" Flex card (Flex builders in
   `services/flex.service.ts` — NO emoji; status icons are native colored boxes because LINE
   Flex can't render SVG/data-URIs). Scan-mode images bypass the batch (see below).
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
`upload_batch` (normal uploads — see flow step 0) · `upload_file` (legacy single upload, kept
for compatibility) · `generate_thumbnail` · `ocr_image` · `add_scan_page` · `finalize_scan` ·
`purge_deleted` (daily repeatable, scheduled on worker startup via `scheduleRepeatableJobs`).
Retries: `add_scan_page`/`finalize_scan` get `attempts: 3` + exponential backoff (set at
enqueue in `webhook/line.ts`); `generate_thumbnail`/`ocr_image` retry too but are best-effort.
`upload_batch` does NOT use BullMQ attempts — it retries each file INTERNALLY (3 attempts,
backoff 1s→2s→4s) and never throws, so the batch is never re-run / double-stored. See
engineering rule 9 for the idempotency guarantees each retried handler must uphold.

## Database
- Always use the Supabase client with the service role key in API/workers.
- All content tables carry `space_id` for multi-tenant isolation.
- Migrations in `supabase/migrations/`:
  - `001_initial.sql` — users, spaces, space_members, folders, files, tags, file_tags,
    scan_sessions, scan_pages (+ indexes, RLS on files).
  - `002_google_accounts.sql` — per-user Google refresh token for Drive export.
    SUPERSEDED: the Drive feature was removed; migration 017 drops this table.
  - `003_reliability.sql` — atomic `increment_storage_used` RPC (see rule 8), `files.purged_at`
    tombstone marker + partial index (rule 6), and `users.storage_limit` default → 10 GB.
    NOT auto-applied; MUST be applied before deploying code that uses the RPC / `purged_at`.
- No direct DB (pg) connection / DDL access from tooling — schema changes go through
  migration files applied manually.

## Project Structure
- `apps/api` — Fastify API + LINE webhook + BullMQ workers
  - `src/routes/` — `webhook/line`, `auth`, `files`, `folders`, `tags`, `spaces`,
    `analytics`, `admin`
  - `src/services/` — `r2`, `line`, `file`, `space`, `scan`, `purge`, `flex`
    (Flex Message builders), `upload-queue` (per-user debounce batching)
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
- `DEFAULT_STORAGE_LIMIT` — free-tier quota in bytes (default 1 GB; raised via referral tiers)
- `REFERRAL_BONUS_BYTES` — one-time bonus for redeeming a referral code (default 0.5 GB)
- `PURGE_RETENTION_DAYS` — purge R2 objects of soft-deleted files after N days (default 5)
- `ADMIN_LINE_USER_IDS` — comma-separated LINE user ids granted admin access (no DB column)

## Status (built)
- Phase 1 — Core: LINE webhook, R2 upload worker, LINE Login, file list/download, bot reply.
- Phase 2 — Organize: folders, tags, rename/move, name+OCR search, thumbnails, rich menu.
- Phase 3 — Scan & Team: scan-to-PDF, LINE group shared spaces, team invites, image OCR.
- Phase 4 — SaaS (minus billing): storage quota + enforcement (1 GB free tier, referral
  tiers up to 10 GB — migration 010, `referral.service`), analytics/usage, admin panel,
  daily R2 purge of long-deleted files. (Google Drive export removed — migration 017.)

## Deferred / NOT built
- Plans / Billing / subscriptions (free tier only for now)
- Approval workflows, anything ERP-related
