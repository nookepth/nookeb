# หนูเก็บ (nookeb) — Claude Code Context

## Project Overview
LINE-integrated file archiving SaaS. Users send files via LINE OA → stored permanently
in Cloudflare R2 → accessible via Next.js Web Dashboard. Supports folders/tags/search,
multi-page scan-to-PDF, LINE group shared spaces, team invites, image OCR, storage
quota + analytics, and an admin panel. A public SEO landing page lives at `/` (see
`apps/web` below). (Google Drive export was removed — see migration 017; rebuild
securely later if ever needed.)

## Tech Stack (FIXED — do not change without asking)
- API: Node.js + TypeScript + Fastify 4.x
- Frontend: Next.js 14 App Router + TypeScript
- Database: PostgreSQL via Supabase (use Supabase client, NOT raw pg)
- Storage: Cloudflare R2 (S3-compatible, use @aws-sdk/client-s3)
- Queue: BullMQ + Redis (Upstash) — REDIS_URL must be `rediss://` (TLS) for Upstash
- Auth: LINE Login → app-signed JWT (HS256, `jsonwebtoken`)
- Images: `sharp` (thumbnails, page normalization) · PDF: `pdf-lib` · OCR: `tesseract.js` (tha+eng)

## LINE Messaging — Critical Rules

### NEVER use push messages — use reply only
- push = costs monthly quota → fails silently when quota runs out
- reply = always free, always works, no quota consumed
- This is a hard rule with no exceptions

### How reply works in async workers
When a worker finishes a long job (OCR, convert, scan merge etc.),
it cannot use the original replyToken (expired after ~30s).
Solution in this codebase:
- replyToken is saved into the BullMQ job payload when the job is queued
- Worker retrieves replyToken from the job payload
- Worker calls replyMessage() with the saved token
- If token expired/used → send to locker only, notify on next interaction

### Queue discipline
- Save replyToken at webhook time (it's valid for ~30s from receipt)
- Pass replyToken through job payload
- Worker uses it once, then discards
- Never store replyToken longer than the job TTL

### Quota-safe fallback
If replyToken is expired or missing:
- Complete the job (save file to locker)
- Do NOT push notify
- On next user interaction, bot surfaces "มีไฟล์ใหม่ในล็อคเกอร์น้า"
  (pending-notify flag in Redis, checked at webhook time and prepended
  to the next reply — see `services/pending-notify.service.ts`)
- User is never left with a broken experience

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
9. File-bearing jobs (`add_scan_page`, `finalize_scan`) run with retry (`attempts: 3`,
   exponential backoff) because LINE CDN content has a ~1h TTL and the user was already told
   "received". Their handlers MUST stay safe to re-run: `finalize_scan` skips sessions not in
   `processing` AND, once it has stored+charged the merged PDF, records `result_file_id` on the
   session (migration 018 / `setSessionResultFile`) so a retry recovers that file instead of
   re-storing it; `add_scan_page` dedups by `line_message_id`; and any post-store step
   (thumbnail/OCR enqueue, user notify) is best-effort (wrapped so it can never throw and
   trigger a duplicating retry). (The legacy single-file `upload_file` handler was removed —
   normal uploads go through `upload_batch`, which has its own internal-retry idempotency.)

## File Processing Flow (upload)
0. Normal uploads are BATCHED per user to avoid message spam: the webhook adds each
   image/file event to an in-memory per-user debounce queue (`services/upload-queue.ts`,
   sliding 1500ms window). When the window closes it sends ONE "progress" Flex card as a
   REPLY via the first event's replyToken (reply-only — no push fallback; if the token is
   gone it skips and logs) and enqueues ONE `upload_batch` job. The worker sends no summary:
   the progress card's button opens the live progress page, which flips to "เสร็จแล้ว" when
   the batch finishes. (Flex builders in `services/flex.service.ts` — NO emoji; status icons
   are native colored boxes because LINE Flex can't render SVG/data-URIs). Scan-mode images
   bypass the batch (see below).
1. LINE sends webhook (image/file message); API replies 200 immediately.
2. Worker resolves user + space. Files sent in a LINE GROUP go to that group's shared team
   space (`ensureGroupSpace`); otherwise the sender's personal space.
3. Quota check (skip + queue a "space full" notice via `pending-notify` if over limit).
4. Worker downloads binary from LINE CDN (messageId + channel access token), streams to R2
   key `spaces/{space_id}/files/{file_id}/{name}`, sets `files.status = 'ready'`.
5. For images, enqueues `generate_thumbnail` (→ `spaces/{sid}/thumbnails/{fid}/thumb.webp`)
   and `ocr_image` (→ `files.ocr_text`) as separate best-effort jobs.
6. No worker confirmation message (the reply-card's progress page covers it); rejection/
   quota notices defer via `pending-notify`. Steps 5–6 are wrapped best-effort — once the
   file is stored + charged the job is "done", so a failure there can't retry and re-store it.

## LINE Bot Commands (text or rich-menu message actions)
- `สแกน` / `scan` — start scan mode (creates a `scan_sessions` row, status `collecting`)
- images while collecting → `add_scan_page` (stored under `spaces/{sid}/scan-temp/...`)
- `เสร็จ` / `done` — `finalize_scan`: merge pages into one PDF (pdf-lib) → store as a file
- `ยกเลิก` / `cancel` — cancel the session
- `วิธีใช้` / `help` — usage text
- `แปลงไฟล์` / `word` — convert-to-Word mode (personal chat only; needs `MISTRAL_API_KEY`,
  else replies "not available"). Arms a one-shot Redis flag (`docx-convert.service`, TTL
  10 min, cleared by `ยกเลิก`); the NEXT image/PDF is OCR'd via Mistral OCR
  (`mistral-ocr.service`, markdown out) and rebuilt as an editable .docx
  (`docx-builder.service`) → stored as a normal personal-space file (quota-charged) →
  result Flex card delivered as a REPLY with the replyToken saved in the job payload (the
  webhook does NOT spend it on an ack); if the token is expired/spent, the card is deferred
  via `pending-notify.service` to the user's next interaction. The flag check runs BEFORE
  the scan-session image check.
- `ไดอารี่` / `diary` — 365-day photo-diary mode (personal chat only, migration 028). Same
  one-shot Redis flag pattern as แปลงไฟล์ (`diary-mode.service`, TTL 10 min, cleared by
  `ยกเลิก`): the NEXT image becomes today's (Bangkok calendar day) diary entry — stored via
  `create_diary_entry` under R2 `diary/{user_id}/{year}/...` (OUTSIDE the files table:
  `diary_entries`, quota-charged, one live entry per user+day enforced by partial unique
  index + arm-time/worker checks). Unprefixed text typed while armed is captured as the
  entry's caption (SET XX KEEPTTL — ยกเลิก and "หนูเก็บ…" commands still work). Result Flex
  card replies with the saved token (pending-notify fallback). Diary flag check runs BEFORE
  the docx-convert and scan-session image checks. Web: `/dashboard/diary` (365-grid +
  streak + scrapbook viewer). Reminders are Option-C IN-APP banners only (no push, ever) —
  `diary_notification_settings` stores the user's time; the web compares client-side.
- `หนูเก็บปิดแจ้งเตือน` / `หนูเก็บเปิดแจ้งเตือน` — group/room only: toggles the per-upload
  "บันทึกแล้วน้า ✓" confirmation reply for THAT group (migration 021,
  `group-settings.service`). Open to any member (Messaging API can't expose
  group-admin role). Default ON; OFF stores files silently (no reply at all).
- `ช่วยเหลือ` / `support` / `contact_support` / `ติดต่อหนูเก็บ` — replies with the contact-
  support text (links to `https://lin.ee/Z0ewNYb`). All four aliases hit the same handler.
- The webhook handles `message`, `join`/`follow`, and `postback` events. The postback
  handler exists for the onboarding-carousel taps — it routes each tap's `data` (a
  "หนูเก็บ…" text command) through the same `handleTextCommand` path as typed text. The
  A/B rich-menu switch taps also arrive as postbacks (`data: "switch"`) but are unprefixed/
  unrecognized, so they fall through to the quiet-chatter rule (silently ignored — the menu
  swap itself is done client-side by the LINE `richmenuswitch` action, no server work).
  Rich-menu buttons use `type: 'message'` actions (see `scripts/setup-rich-menu-ab.ts`).

## Rich Menu Policy (do NOT change without explicit approval)
Fixed two-page A/B design (2500×1686 each), registered ONLY by `scripts/setup-rich-menu-ab.ts`:
- Menu A = `richmenu_1.jpg` (หน้าแรก) — the default for all users; Menu B = `richmenu_2.jpg`
  (หน้าคำสั่ง). Linked via aliases `richmenu-alias-a` / `richmenu-alias-b` + `richmenuswitch`
  actions (the switch happens client-side; the postback `data: "switch"` is ignored server-side).
- NEVER run `setup-rich-menu-large.ts` (or `-menu.ts`) — they delete ALL menus, which once
  destroyed the A/B pair. Old-menu deletion in the A/B script is opt-in only (`CLEANUP_OLD_MENUS=1`).
- Every button's `message` text must map to a real handler in `webhook/line.ts` — keep in sync.
- Do not add/remove/rearrange button areas without approval.

## ห้องนิรภัย (Vault) — web-only, migration 031
PIN-protected, view-only, per-user ENCRYPTED file store at `/dashboard/vault`
(routes `apps/api/src/routes/vault.ts`). Structurally isolated like the diary:
own table (`vault_files`), own R2 prefix (`vault/{user_id}/{uuid}.enc`), no
LINE-webhook/worker write path, unreachable from every share/team/space flow.
- Crypto (`services/vault-crypto.ts`, unit-tested): AES-256-GCM per-file DEK,
  wrapped under a per-user scrypt key derived from `VAULT_MASTER_KEY` (env,
  32-byte hex — LOSING/ROTATING IT MAKES ALL VAULT FILES UNREADABLE). Files are
  stream-encrypted before R2 (rule 3 holds; ciphertext = plaintext + 16B tag).
- Access: DELIBERATE deviation from rule 5 — NO presigned URLs, NO download
  endpoint, ever. All bytes stream through `GET /vault/files/:id/view`, which
  re-checks ownership + unlock per request. Images are re-encoded with a tiled
  viewer-name+timestamp watermark (traceability — screenshots can't be blocked);
  video/GIF stream with Range support (GCM can't seek: decrypt-from-0 + slice,
  tag unverified on partial reads); PDF streams inline (TODO rasterize).
- PIN: 6 digits, argon2id in `users.vault_pin_hash`; a second factor ON TOP of
  the JWT session, safe only because of the per-USER (never per-IP) lockout:
  5 fails → 15-min lock, doubling per repeat within 24h (`vault-session.service`).
  Unlock opens a 15-min sliding Redis session bound to the JWT's session_version
  (bumping it kills open vaults too). DELETE re-verifies the PIN. No PIN
  change/reset flow yet — deliberate. Lock states are 403 + `code`
  (`VAULT_LOCKED` / `VAULT_PREMIUM_REQUIRED`), NOT 401 (web treats 401 = logout).
- Premium: `users.vault_plan` manual flag; setup-pin self-grants 'premium'
  until billing lands (so the setup state precedes the paywall CTA on the web).
- Vault files are NOT charged to `users.storage_used` (own cap instead:
  `VAULT_MAX_FILE_SIZE_MB`, default 100) — revisit when billing defines quota.
- Delete: soft-delete, then the daily purge HARD-deletes row + R2 object after
  `VAULT_PURGE_RETENTION_DAYS` (30) — vault-scoped deviation from rule 6
  (a vault filename is itself sensitive; nothing needs the tombstone).
- Upload is the app's ONLY web multipart endpoint (`@fastify/multipart`,
  registered only in the vault route scope).

## BullMQ Jobs (queue `nookeb-file-processing`, all handled in `workers/upload.worker.ts`)
`upload_batch` (normal uploads — see flow step 0) · `generate_thumbnail` · `ocr_image` ·
`add_scan_page` · `finalize_scan` · `convert_to_docx` (image/PDF → Mistral OCR → editable
.docx; attempts: 3, retry-safe via a `docx-<lineMessageId>` line_message_id marker row —
a failed store soft-deletes its row so the retry can re-insert) · `create_diary_entry`
(ไดอารี่ photo → validate jpg/png/webp ≤10MB → R2 `diary/…` → `diary_entries` row +
400px thumb; attempts: 3, retry-safe via the live-rows unique indexes on
`line_message_id` and user+entry_date — migration 028) · `purge_deleted` (daily
repeatable, scheduled on worker startup via `scheduleRepeatableJobs`; also sweeps
soft-deleted diary entries' R2 objects via `purgeDeletedDiaryEntries` and
hard-purges soft-deleted vault files via `purgeDeletedVaultFiles`). (The legacy `upload_file` handler was removed — it had
no size cap / virus scan / atomic quota check and was strictly worse than `upload_batch`.)
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
  - `004_security_features.sql` · `005_teams.sql` · `006_cleanup_stale_team_spaces.sql` ·
    `007_spaces_team_id.sql` · `008_team_join_requests.sql` — team system (spaces↔teams,
    invites, join-request approval flow).
  - `009_session_version.sql` — `users.session_version`; bumping it revokes outstanding JWTs
    (see `middleware/auth.ts`, revocation check + 60s Redis cache).
  - `010_referrals.sql` · `012_reset_quota.sql` · `013_fix_tiers.sql` — referral codes +
    storage tiers (`referral.service`). Tier thresholds superseded by 030.
  - `030_referral_tiers_fractional.sql` — current referral ladder: 0→1, 3→2.5, 5→4 GB.
    Widens `referral_tiers.storage_limit_gb` INTEGER → NUMERIC(6,2) (2.5 doesn't fit an
    int) and recreates `redeem_referral` so its `v_tier_gb` local is NUMERIC too —
    otherwise SELECT…INTO silently rounds 2.5 → 3. 5 is the TOP tier and there is no
    referral cap: `referral_count` keeps rising past it, it just stops unlocking storage.
    Keeps 024's GREATEST() guard, so users on the retired 3/5/7/10 GB tiers never get
    lowered. NOT auto-applied; apply BEFORE the API/worker deploy (code reading the old
    int column against fractional rows would round rewards up).
  - `014_personal_quota_enforcement.sql` · `015_add_charged_to_column.sql` ·
    `016_unique_space_constraints.sql` — atomic per-file personal quota enforcement, the
    `charged_to` ledger column (correct quota refunds), and unique constraints closing a
    space-creation race. Apply BEFORE the API/worker deploy that depends on them.
  - `017_drop_google_accounts.sql` — drops the table from 002 (Drive feature removed). Apply
    AFTER the code deploy that stops referencing it.
  - `018_scan_page_seq.sql` — `scan_pages.page_seq BIGSERIAL` (DB-assigned, atomic) so
    concurrent `add_scan_page` workers can't collide on page number; `finalize_scan` orders
    by it. Also backs the `result_file_id` idempotency marker (rule 9).
  - `019_scan_mode.sql` — `scan_sessions.scan_mode` (color/bw), `020_session_kind.sql` —
    `scan_sessions.session_kind` ('scan' vs 'merge'), distinguishing the scan-enhance
    pipeline from the plain merge-to-PDF flow (see `upload.worker.ts` `processAddScanPage`).
  - `021_group_notify_settings.sql` — `group_notify_settings` table keyed by LINE
    group/room id: per-group toggle for the upload confirmation reply (default ON).
    NOT auto-applied; code fails open (notify=TRUE) if the table is missing, so it's
    safe to deploy the code before applying this one.
  - `028_diary.sql` — `diary_entries` + `diary_notification_settings` (ไดอารี่ 365 วัน).
    One LIVE entry per user+Bangkok-day via partial unique index (soft-deleted rows don't
    block a redo); `line_message_id` live unique index backs worker retry dedup; R2 KEYS
    stored (never URLs — rule 5). NOT auto-applied; apply BEFORE deploying the diary code
    (the ไดอารี่ command errors politely without it).
  - `029_usage_events.sql` — product-analytics event log: one append-only `usage_events`
    table (fixed-vocab `event_type` + numeric-only `metadata`, NO PII/file names) + `admin_*`
    aggregate RPCs (DAU/WAU/MAU, feature adoption, funnels, retention, power-users). Powers
    the revamped `/admin` dashboard. Events are written fire-and-forget via
    `services/events.service.ts` `logEvent()` (NEVER throws — protects the 1s webhook budget
    and worker retry-safety): intent events in `webhook/line.ts` (`classifyIntent`), outcome
    events in `upload.worker.ts` (upload/scan/docx/diary done + `feature_blocked_quota`),
    `web_login` in `auth.ts`. NOT auto-applied; the admin endpoints fail soft to empty when
    the RPCs are missing, so it's safe to deploy code first — analytics just stays blank
    until the migration is applied.
  - `031_vault.sql` — ห้องนิรภัย (Vault): `users.vault_pin_hash` / `users.vault_plan`
    + `vault_files` (encrypted per-user store — see the Vault section). NOT
    auto-applied; apply BEFORE deploying the vault code (the /vault routes
    error without these columns; everything else is unaffected).
- No direct DB (pg) connection / DDL access from tooling — schema changes go through
  migration files applied manually.

## Project Structure
- `apps/api` — Fastify API + LINE webhook + BullMQ workers
  - `src/routes/` — `webhook/line`, `auth`, `files`, `folders`, `tags`, `spaces`,
    `analytics`, `admin`, `referral`, `team.router` (mounted at `/api/teams`),
    `progress` (upload-progress view + JSON), `diary` (ไดอารี่ entries/streak/
    today-status/notification — user-scoped, no space membership), `vault`
    (ห้องนิรภัย — PIN + encrypted view-only store, see the Vault section), `static`
  - `src/services/` — `r2`, `line`, `file`, `space`, `scan`, `purge`, `flex`
    (Flex Message builders), `upload-queue` (per-user debounce batching), `team`, `referral`
    (+ `referral.messages`), `progress-store` (Redis batch progress), `storage-monitor`
    (quota-warning thresholds), `virusTotal` (optional file scanning), `group-settings`
    (per-group notify toggle, migration 021 — 5-min in-memory cache, fails open),
    `pending-notify` (Redis queue of deferred user notifications — the reply-only rule's
    fallback: workers queue here instead of pushing; the webhook drains it on the user's
    next 1-on-1 text/postback and prepends the messages to that reply),
    `mistral-ocr` (Mistral OCR REST client), `docx-builder` (markdown → editable .docx,
    pure/env-free, unit-tested), `docx-convert` (convert-mode Redis flag),
    `diary` (diary_entries data access + Bangkok-day/streak helpers), `diary-mode`
    (diary one-shot Redis flag; caption piggybacks on the flag value),
    `vault-crypto` (envelope encryption, pure/unit-tested), `vault-session`
    (Redis unlock sessions + per-user PIN lockout), `vault` (vault_files data
    access + view watermarking)
  - `src/workers/` — `upload.worker` (all job handlers), `index` (entry + repeatable schedule)
  - `src/middleware/` — `auth` (JWT via HttpOnly cookie or Bearer), `line-verify` (webhook
    HMAC signature — used ONLY on `/webhook/line`)
  - `scripts/` — `setup-rich-menu-ab` (CURRENT: two-page A/B menu — see rich-menu policy
    below), `setup-rich-menu`(`-large`) (LEGACY — do NOT run `-large`, it deletes ALL menus),
    `backfill-quota`, `backfill-referral-codes`, `purge-deleted` (dry-run by default),
    `upload-greeting-image`
- `apps/web` — Next.js dashboard + public landing page.
  - Landing page at `/` (`app/page.tsx` + scoped `app/page.module.css`, ~1,300 lines) —
    public SEO/marketing page that replaced the old redirect-to-dashboard. The rich menu
    deep-links straight to `/dashboard`, so keep `/` public — do NOT turn it back into a
    redirect. Sections: hero with LINE-chat mockup, 6 feature cards, polaroid gallery of the
    brand card images (`public/landing/card-1..7.jpg`), 3-step how-to, 1→4 GB referral
    ladder, trust strip, FAQ, locker CTA.
  - Landing content rules: every claim must pass the brand playbook's "เคลมได้/ห้ามเคลม"
    table (marketing/, ส่วนที่ 2) · NO emoji anywhere on the page (inline SVG icons only) ·
    NEVER generate new mascot art — official artwork only (`public/logo.png` IS the mascot,
    transparent PNG). FAQ text and the FAQPage JSON-LD render from the same `FAQS` array in
    `page.tsx`, so they cannot drift — keep it that way.
  - Scroll-reveal via `components/landing/Reveal.tsx` has a 3-layer safety net so content can
    never be stuck invisible: hidden state only inside `@media (scripting: enabled)`, an
    inline hydration-independent 4s failsafe `<script>` in `page.tsx`, and a `<noscript>`
    override — do NOT remove any layer (a blank page was observed when JS arrived late).
  - SEO: `app/robots.ts` (disallows `/dashboard`, `/admin`, `/auth/`, `/join`, `/share/`,
    `/api-proxy/`) + `app/sitemap.ts` (lists only `/`) + OpenGraph image
    `public/landing/og.jpg` + `metadataBase` in `app/layout.tsx` (origin defaults to the
    Vercel domain; override with `NEXT_PUBLIC_SITE_URL` when a custom domain lands).
  - All outbound links/handles live ONLY in `lib/site.ts` (SITE_URL, LINE_ADD_FRIEND_URL,
    LINE_ID, INSTAGRAM_URL, TIKTOK_URL) — that file is the current canon; the playbook's
    ภาคผนวก A still lists an older lin.ee link, so reconcile the playbook when touching links.
  - Dashboard routes: `/dashboard`, `/dashboard/diary` (+ `/[date]` scrapbook viewer),
    `/dashboard/vault` (ห้องนิรภัย), `/dashboard/teams` (+ `/[teamId]`), `/admin`,
    `/join`, `/auth/callback`, `/share/[token]`
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
- Never run `npm run build` for the web while its dev server is running — both write
  `.next/`, the dev server's runtime chunks get clobbered and every page 500s with
  "Cannot find module './NNN.js'" until the dev server is restarted.

## Deployment (Production)
Three platforms. The web (Vercel) never talks to the API cross-origin — it calls the API
**same-origin** through the Next.js `/api-proxy/:path*` rewrite (`apps/web/next.config.mjs`),
because Safari ITP / the LINE in-app browser block the cross-site HttpOnly session cookie to
the Railway domain. So the browser only ever hits `https://<web>/api-proxy/...`; Vercel rewrites
that server-side to the Railway API.

### Railway — API (`@nookeb/api`) + Worker (`nookeb-worker`, separate service)
- API origin: `https://nookebapi-production.up.railway.app` — health at `GET /health`
  (returns the live commit SHA via `RAILWAY_GIT_COMMIT_SHA` — always verify after a push,
  auto-deploy has silently stalled before).
- LINE Messaging webhook → `https://nookebapi-production.up.railway.app/webhook/line`.
- Env vars are **per service** — the worker does NOT inherit from the API; set the full set on
  BOTH (config throws in production if `APP_URL`/`WEB_URL` are localhost). Required (see
  `.env.example`): `NODE_ENV=production`, `APP_URL`, `WEB_URL`, `LINE_CHANNEL_*`,
  `LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET`, `SUPABASE_*`, `R2_*`, `REDIS_URL`
  (`rediss://`), `JWT_SECRET`, plus quota/admin/limit vars.
- `trustProxy: true` is set in `index.ts` — REQUIRED: Railway's ingress + the /api-proxy hop
  make every request arrive from one socket; without it `request.ip` is shared and the per-IP
  rate limiters (global 100/min, `POST /auth/line` 10/min + ban:5) count all users as one and
  ban everyone after a re-login burst.

### Vercel — Web (`nookeb-web`)
- **`API_PROXY_TARGET=https://nookebapi-production.up.railway.app`** (no trailing slash) —
  server-side var (NOT `NEXT_PUBLIC_*`), the destination of the `/api-proxy` rewrite. **If
  unset it falls back to `http://localhost:3001`; Vercel then refuses to proxy to a private
  host and every `/api-proxy/*` call 404s with `DNS_HOSTNAME_RESOLVED_PRIVATE` — which breaks
  login ("เข้าสู่ระบบไม่สำเร็จ") and all dashboard API calls.** Changing it requires a redeploy.
- `NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID` — the LINE Login channel id baked into the authorize URL.
- `NEXT_PUBLIC_API_URL` is NOT used anymore (web hardcodes `API_URL = '/api-proxy'`).
- Verify the proxy end-to-end: `POST https://nookeb-web.vercel.app/api-proxy/auth/line` with a
  dummy code should return `401 "LINE login failed"` (reaches the API) — a `404` means
  `API_PROXY_TARGET` is unset/wrong.

### LINE Developer Console
- Messaging API channel: webhook URL = Railway `/webhook/line`, "Use webhook" ON, auto-reply/
  greeting OFF. Env: `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`.
- LINE Login channel: Callback URLs must include every web origin —
  `https://nookeb-web.vercel.app/auth/callback` and the `*-nookeb.vercel.app/auth/callback`
  preview domain. Env (on the API): `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET`. The
  `redirect_uri` the API sends to LINE's token endpoint must exactly match the one the browser
  used to authorize (both derive from `window.location.origin + '/auth/callback'`).

### Deploy order (critical-fix batches)
Migrations that RPCs/columns depend on go BEFORE the API/worker deploy; deploy API BEFORE web
(the web bundle authenticates only via the cookie + `/api-proxy`). See the migration headers
and `supabase/backfills/` for specifics.

## Key Env Vars (see `.env.example`)
- Core (API): `LINE_CHANNEL_*`, `LINE_LOGIN_CHANNEL_*`, `SUPABASE_*`, `R2_*`, `REDIS_URL`, `JWT_SECRET`
- Web (Vercel, see `apps/web/.env.example`): `API_PROXY_TARGET` (server-side rewrite target =
  Railway API origin, no trailing slash — login breaks if unset), `NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID`
- `DEFAULT_STORAGE_LIMIT` — free-tier quota in bytes (default 1 GB; raised via referral tiers)
- `REFERRAL_BONUS_BYTES` — one-time bonus for redeeming a referral code (default 0.5 GB)
- `PURGE_RETENTION_DAYS` — purge R2 objects of soft-deleted files after N days (default 5)
- `ADMIN_LINE_USER_IDS` — comma-separated LINE user ids granted admin access (no DB column)
- `MISTRAL_API_KEY` / `MISTRAL_OCR_MODEL` / `DOCX_CONVERT_MAX_SOURCE_BYTES` — convert-to-Word
  ("แปลงไฟล์"); feature is OFF (command replies "not available") until the key is set
- `DIARY_MAX_IMAGE_BYTES` — ไดอารี่ per-photo cap (default 10 MB; jpg/png/webp only)
- `VAULT_MASTER_KEY` / `VAULT_MAX_FILE_SIZE_MB` / `VAULT_PURGE_RETENTION_DAYS` —
  ห้องนิรภัย (Vault); routes reply 503 until the key (32-byte hex) is set.
  NEVER rotate/lose the key — existing vault files become unreadable.

## Status (built)
- Phase 1 — Core: LINE webhook, R2 upload worker, LINE Login, file list/download, bot reply.
- Phase 2 — Organize: folders, tags, rename/move, name+OCR search, thumbnails, rich menu.
- Phase 3 — Scan & Team: scan-to-PDF, LINE group shared spaces, team invites, image OCR.
- Phase 4 — SaaS (minus billing): storage quota + enforcement (1 GB free tier, referral
  tiers up to 4 GB — migrations 010/030, `referral.service`), analytics/usage, admin panel,
  daily R2 purge of long-deleted files. (Google Drive export removed — migration 017.)

## Deferred / NOT built
- Plans / Billing / subscriptions (free tier only for now)
- Approval workflows, anything ERP-related
