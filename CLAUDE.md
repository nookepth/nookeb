# หนูเก็บ (nookeb) — Claude Code Context

> Rewritten 2026-07-30 from a full read of the codebase (routes, services, workers,
> web/LIFF pages, shared package, migrations 001–047). Anything the code did not
> confirm is marked **[UNCLEAR — needs verification]**.

---

## 1. Project Overview

A LINE-integrated personal/team **file archive + task chaser** SaaS, Thai-language,
with a bot persona ("หนู" / addresses the user as "พี่" / ends sentences with "น้า").

What actually works today:

- **Archive** — users send files/images/video/audio to a LINE OA; a debounced batch
  job stores them permanently in Cloudflare R2 and indexes them in Postgres
  (Supabase). Browsable at a Next.js dashboard with folders, tags, name+OCR search,
  thumbnails, previews, share links and a trash bin.
- **Document flows in chat** — สแกน (scan-to-PDF with enhancement + OCR),
  รวมไฟล์ (merge images **and** PDFs into one PDF), แปลงไฟล์ (image/PDF → editable
  .docx via Mistral OCR). All three ride the same `scan_sessions` machinery.
- **ไดอารี่ 365 วัน** — one photo + caption per Bangkok calendar day, stored
  outside the files table, with a web 365-grid/scrapbook viewer.
- **ห้องนิรภัย (Vault)** — PIN-protected, per-user AES-256-GCM encrypted,
  view-only web store.
- **กล่องของขวัญ (Legacy Box)** — shareable gift boxes (photos + message + optional
  voice clip) behind a public slug with an animated reveal.
- **ระบบตามงาน (Task Manager)** — the largest feature. Group and personal tasks
  created from a LIFF flow **or** from in-chat commands and natural language,
  with a confirm-before-create card, assignee roster that fills itself,
  attachments, a ส่งงานกลับ / รับงาน / ตีกลับ review loop, ห้องทีม (team room),
  .xlsx export, Google Sheets mirroring, and scheduled reminders that are
  currently **soft-disabled**.
- **Teams** — teams, invites, join-request approval, LINE group ↔ team binding.
- **Referrals** — invite codes raising the free storage tier 1 → 2.5 → 4 GB.
- **Admin analytics** — one `/admin` page over an append-only `usage_events` log
  and read-only aggregate RPCs.
- **Public landing page** at `/` (SEO, FAQ JSON-LD, no emoji, official art only).

Not built: billing/plans (the `users.plan` column exists and gates one feature, but
nothing sells it), Google **Drive** export (removed; migration 017), any ERP or
configurable approval workflow.

---

## 2. Tech Stack (verified from package.json — FIXED, do not change without asking)

**Root** — npm workspaces (`apps/*`, `packages/*`) + turbo 2.x, TypeScript 5.5.

**apps/api** (`@nookeb/api`)
- Fastify **4.28** + `@fastify/cookie` 9, `@fastify/cors` 9, `@fastify/rate-limit` 9,
  `@fastify/multipart` 8.3 (registered per-scope only — see rules)
- `@supabase/supabase-js` 2.44 (service-role key), `ioredis` 5.10.1, `bullmq` 5.8
- Storage: `@aws-sdk/client-s3` / `lib-storage` / `s3-request-presigner` 3.x
- Images `sharp` 0.35 · scan enhance `@techstark/opencv-js` 5 · OCR `tesseract.js` 7
- PDF `pdf-lib` 1.17 + `@pdf-lib/fontkit` · Word `docx` 9.7 · Excel `exceljs` 4.4
- Calendar `ical-generator` 11 · Google `googleapis` 173 (Sheets/Drive-file only)
- `jsonwebtoken` 9 (HS256), `argon2` 0.41 (vault PIN), `zod` 3.23, `dayjs` 1.11
- Dev: `tsx` 4, `concurrently` 10. Tests are `tsx --test` (node:test), no jest/vitest.
- **Mistral OCR is a hand-rolled REST client** (`mistral-ocr.service.ts`) — no SDK dep.

**apps/web** (`@nookeb/web`)
- Next.js **^14.2.4** (resolves 14.2.35 — deliberately pinned, see §14), React 18.3
- `@line/liff` 2.29 (npm, never CDN), `pdfjs-dist` 4.10 (mobile PDF viewer only)
- No chart library, no CSS framework, no state library. Charts are hand-rolled SVG/CSS.

**packages/shared** — types + DTO mappers + constants; API/web import the built `dist`
(`npm run build` after changing).

---

## 3. Key Engineering Rules

1. **LINE webhook must answer within 1 second** — verify signature, `reply 200`
   immediately, process events in `setImmediate`, enqueue anything slow.
2. **Verify the LINE signature over the RAW body** (`X-Line-Signature`, HMAC-SHA256).
   A scoped `application/json` buffer content-type parser preserves exact bytes.
3. **Never store files locally** — stream to/from R2, no temp files on disk.
4. **Multi-tenant isolation is enforced in code.** The API/worker use the Supabase
   SERVICE ROLE key, which BYPASSES RLS; RLS (migration 038 enables deny-all on the
   rest) is a backstop only. Every space/group/task route checks membership
   explicitly (`isSpaceMember` / `getMemberRole` / `ensureGroupMember` /
   `isGroupMember`).
5. **File downloads use presigned URLs** (1 h) — binary is never proxied through the
   API. Two deliberate exceptions: the vault viewer (`GET /vault/files/:id/view`)
   and the web's same-origin `/api/file-pdf/:id` route (mobile pdf.js).
6. **Soft-delete only** (`deleted_at`). A daily purge removes R2 OBJECTS past the
   retention window and stamps `purged_at` (tombstone). Exceptions, each justified
   in-file: vault files hard-delete at purge, and `google_integrations` rows are
   hard-deleted on disconnect (a third-party credential, not user content).
7. **BullMQ custom `jobId` must not contain `:`** — use `sanitizeJobId(prefix, id)`
   from `@nookeb/shared` (LINE message ids contain `:`).
8. **Storage accounting only via `adjustStorageUsed` / `increment_storage_used` /
   `increment_personal_storage`** — never read-modify-write (worker concurrency).
9. **Retried job handlers must be safe to re-run.** `add_scan_page` dedups by
   `line_message_id`; `finalize_scan` skips non-`processing` sessions and records
   `result_file_id`; `convert_to_docx` uses a marker row; `create_diary_entry` relies
   on live-row unique indexes; `upload_batch` retries INTERNALLY and never throws
   (BullMQ `attempts: 1`).
10. **Reply-only LINE messaging** — see §6 preamble. Push is sanctioned only for the
    Task Manager, and even there only for LIFF-create announcements, review-loop
    notices and scheduled reminders.
11. **`@fastify/multipart` is registered per-plugin-scope, never shared** — three
    scopes today: `vault.ts`, `legacy-box.ts`, `task-files.ts`. Registering it in a
    shared scope installs a content-type parser across every route in that scope.
12. **`trustProxy: true`** in `index.ts` — must stay `true` (regressed twice). `1`
    collapses every Vercel-proxied user onto one IP and the `/auth/line` limiter bans
    the whole userbase.
13. **No emoji in Flex Message cards** (brand rule) — status icons are native colored
    boxes; the web uses inline SVG. Plain-text bot replies DO use emoji.
14. **Pure, unit-tested service modules stay env-free**: `task-command`, `task-nl`,
    `task-confirm` (pure parts), `task-recurrence`, `pdf-merge`, `docx-builder`,
    `export`, `vault-crypto`, `scan-enhance`, `referral`.
15. **Client analytics events only through `POST /api/events/track`** (whitelist +
    payload sanitiser + server-derived `plan_tier`). Never pass raw event strings —
    add to `EVENT_TYPES` in `events.service.ts`.

---

## 4. Project Structure

```
apps/api/src/
  index.ts              Fastify bootstrap, CORS allowlist, security headers,
                        global 100/min limiter (exempts /health, /webhook/line,
                        /progress/*), root error sanitiser, SIGTERM batch flush
  config.ts             zod env schema (see §13)
  middleware/           auth (JWT via HttpOnly cookie or Bearer, session_version
                        revocation + 60s Redis cache), line-verify (HMAC)
  plugins/              supabase, r2, redis, bullmq
  routes/               admin, analytics, auth, diary, events, files, folders,
                        groups, integrations, legacy-box, pro-interest, progress,
                        referral, share, spaces, static, tags, task-files, tasks,
                        team.router (mounted /api/teams), trash, vault
    webhook/            line.ts (the dispatcher), task-handlers.ts (task Flex
                        postbacks + /register), task-command-handlers.ts (in-chat
                        task command, NL detection, confirm postbacks)
  services/             see below
  workers/              upload.worker.ts (all file jobs), taskReminderWorker.ts,
                        sheetsWorker.ts, index.ts (entry + /health + schedulers)
  scripts/ (src)        cleanup-redis.ts
apps/api/scripts/       setup-rich-menu-single.ts (the ONLY rich-menu script left),
                        backfill-quota, backfill-referral-codes, purge-deleted
                        (dry-run by default), upload-greeting-image,
                        upload-onboarding-images, download-tessdata.js
apps/web/app/           landing (/), dashboard/*, liff/tasks/*, admin, auth/callback,
                        join, share/[token], box/[slug], api/og, api/file-pdf
apps/web/components/    Navbar, BottomNav, FileGrid/FileCard, FilePreviewModal,
                        ShareModal, UsageBar, ReferralCard, VaultPinPad,
                        ProLockModal, DiaryReminderBanner, TeamStorageBar, landing/
apps/web/lib/           api.ts (101 client fns + DTOs), liff.ts, taskDraft.ts,
                        taskFiles.ts, track.ts, site.ts, share.ts, auth.ts,
                        format.ts, filetype.ts, useVaultSummary.ts
packages/shared/src/    types/* + legacy-box-{themes,occasions,stickers,voice}
                        + task-notifications.ts (the reminder master switch)
supabase/migrations/    001–047 (see §5) · supabase/backfills/ (3 idempotent SQL)
```

**Services** (`apps/api/src/services/`) — `r2`, `line` (reply/push/profile),
`file`, `space`, `scan`, `scan-enhance`, `purge`, `flex` (bot Flex builders),
`lineMessage` (task Flex builders), `upload-queue` (per-user debounce), `team`,
`team-room`, `referral` + `referral.messages`, `progress-store`, `storage-monitor`,
`virusTotal`, `pending-notify`, `mistral-ocr`, `docx-builder`, `docx-convert`,
`docx-thai-components`, `pdf-merge`, `export`, `diary` + `diary-mode`,
`vault` + `vault-crypto` + `vault-session`, `legacy-box`, `events`,
`task.service`, `taskScheduler`, `task-recurrence`, `task-command`, `task-nl`,
`task-confirm`, `google-sheets`, `sheets-workspace`, `sheetsQueue`, `ocr`,
`admin-audit`, `push-flag`, `queue-stats`, `queue-actions`,
`push-log` + `job-log` (TIER 3 history writers — **both NEVER throw**, see §5/060),
`feature-flags` (DB-backed runtime switches), `line-quota`,
`group-settings` (**orphaned — see §15**).

**Jobs** (`apps/api/src/jobs/`) — `membership.queue` + `membership.worker`,
`quotaReset`, `boostExpiry`, `trashCleanup`, `diaryReminder`, `r2Reconcile`
(the R2 ↔ Postgres drift audit — **never deletes an R2 object**, see §12).

---

## 5. Database — Migration Map

None are auto-applied. Read each file's header for apply-order; the ones that must
land **before** the API deploy are flagged in-file.

> Migrations are applied manually. Always verify by reading the file
> header, not the CLAUDE.md map alone. Last verified: 2026-08-02.
>
> Verified against `ls supabase/migrations/` on that date: 56 files, numbered
> 001–057 with **011 skipped** (no such file has ever existed). Three entries
> were wrong before this pass and are corrected below — 048 was documented as
> `task_urgency` (it is the reverse-lookup indexes), 049 and 052 were missing
> entirely, and the real `task_urgency` is 050. The 050 file's own first line
> also said `048_task_urgency.sql`; that header is fixed in the file.

| # | File | Adds |
|---|---|---|
| 001 | `001_initial.sql` | users, spaces, space_members, folders, files, tags, file_tags, scan_sessions, scan_pages (+ indexes, RLS on files) |
| 002 | `002_google_accounts.sql` | per-user Google refresh token for Drive export — **superseded, dropped by 017** |
| 003 | `003_reliability.sql` | atomic `increment_storage_used` RPC, `files.purged_at` + partial index, storage_limit default |
| 004 | `004_security_features.sql` | per-file virus-scan status + per-space storage-alert dedupe |
| 005 | `005_teams.sql` | first-class teams (replaces implicit `spaces(type='team')`), `files.team_id`, `increment_team_storage` |
| 006 | `006_cleanup_stale_team_spaces.sql` | one-time cleanup of legacy team-space rows |
| 007 | `007_spaces_team_id.sql` | direct `spaces → teams` link |
| 008 | `008_team_join_requests.sql` | owner/admin approval flow for invite-link joins |
| 009 | `009_session_version.sql` | `users.session_version` — bumping revokes outstanding JWTs |
| 010 | `010_referrals.sql` | referral codes, `referrals`, `referral_tiers`, `redeem_referral` RPC |
| 011 | *(no file — number skipped)* | — |
| 012 | `012_reset_quota.sql` | one-time quota clean slate for the referral launch |
| 013 | `013_fix_tiers.sql` | corrected tier thresholds (superseded by 030) |
| 014 | `014_personal_quota_enforcement.sql` | atomic `increment_personal_storage(enforce)` |
| 015 | `015_add_charged_to_column.sql` | `files.charged_to` ledger column (correct refunds) |
| 016 | `016_unique_space_constraints.sql` | one space per LINE group / one personal space per user |
| 017 | `017_drop_google_accounts.sql` | drops 002's table (Drive removed) |
| 018 | `018_scan_page_seq.sql` | `scan_pages.page_seq BIGSERIAL` + `result_file_id` idempotency marker |
| 019 | `019_scan_mode.sql` | `scan_sessions.scan_mode` ('bw' \| 'color') |
| 020 | `020_session_kind.sql` | `scan_sessions.session_kind` ('scan' \| 'merge') |
| 021 | `021_group_notify_settings.sql` | per-group upload-confirmation toggle — **feature retired; table + service now unused** |
| 022 | `022_fix_upload_idempotency.sql` | unique index backstop on upload `line_message_id` |
| 023 | `023_scan_expected_pages.sql` | `scan_sessions.expected_pages` + RPC — finalize wait-gate |
| 024 | `024_fix_referral_quota.sql` | stop referral redemption clobbering admin-raised quotas (GREATEST guard) |
| 025 | `025_perf_indexes.sql` | `files.uploaded_by` etc. partial indexes (CONCURRENTLY) |
| 026 | `026_aggregate_rpcs.sql` | count/aggregate RPCs so admin/analytics don't page 1000-row selects |
| 027 | `027_file_shares.sql` | public share links for dashboard files (token) |
| 028 | `028_diary.sql` | `diary_entries` + `diary_notification_settings`, one live entry per user+Bangkok day |
| 029 | `029_usage_events.sql` | append-only `usage_events` + `admin_*` aggregate RPCs |
| 030 | `030_referral_tiers_fractional.sql` | current ladder 0→1, 3→2.5, 5→4 GB (NUMERIC column + RPC local) |
| 031 | `031_vault.sql` | `users.vault_pin_hash` / `vault_plan` + `vault_files` |
| 032 | `032_trash.sql` | `files.trash_origin_folder_id` (restore target snapshot) |
| 033 | `033_legacy_boxes.sql` | `legacy_boxes` + `legacy_box_photos` + `increment_box_views` RPC |
| 034 | `034_legacy_box_occasion_tagline.sql` | `occasion` + `tagline` (nullable) + anonymous `pro_interest_log` |
| 035 | `035_legacy_box_audio.sql` | `legacy_boxes.audio_key` (CHECK pins the `legacy-box/` prefix) |
| 036 | `036_tasks.sql` | `tasks`, `task_items`, `task_assignees`, `task_reminders`, `group_members` (RLS, no policies) |
| 037 | `037_task_edit.sql` | per-assignee `done_note`, task-level `task_links`, edit/cancel support columns |
| 038 | `038_rls_backstop.sql` | enables RLS (deny-all) on every remaining table |
| 039 | `039_increment_share_views.sql` | atomic `increment_share_views` RPC |
| 040 | `040_pro_interest_authed.sql` | `pro_interest` — authenticated, deduped task Pro fake-door. **Retired by 057** |
| 041 | `041_usage_events_client_dims.sql` | `usage_events.session_id` / `plan_tier` / `entry_channel` (nullable) |
| 042 | `042_admin_analytics_rpcs.sql` | 12 read-only STABLE admin RPCs (Bangkok day buckets) |
| 043 | `043_personal_tasks.sql` | `tasks.is_personal` + `owner_line_uid`, `group_line_id` nullable, `tasks_scope_exclusive` CHECK |
| 044 | `044_pdf_merge_session_kind.sql` | widens `session_kind` CHECK to add `'pdf'` |
| 045 | `045_task_files.sql` | `task_files` junction + item statuses `submitted`/`rejected` + `submitted_at`/`rejected_at`/`rejection_note`/`submission_note`. **Not additive-safe: `getTaskWithDetails()` SELECTs `task_files` and backs every task read — apply BEFORE deploying.** |
| 046 | `046_google_sheets_integration.sql` | `google_integrations` (one row/user, AES-GCM `encrypted_token`, RLS deny-all) |
| 047 | `047_task_command_reminders.sql` | `tasks.reminder_count` INT NULL CHECK 1..4 — the Pro "เตือน N ครั้ง" knob |
| 048 | `048_reverse_lookup_indexes.sql` | the two missing reverse-lookup indexes on junction tables whose composite PK only covers the LEADING column: `idx_space_members_user_id` (`space_members` queried by `user_id` alone in `ensureUserAndSpace` + `GET /auth/me`) and `idx_file_tags_tag_id` (`file_tags` queried by `tag_id` alone in the dashboard tag filter). **Purely additive — indexes only, safe in either deploy order and safe to re-run.** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block: run the statements one at a time, never wrapped in BEGIN/COMMIT |
| 049 | `049_group_member_removal.sql` | `group_members.removed_at` TIMESTAMPTZ + partial index `idx_group_members_active` — turns LINE `memberLeft` removal from cosmetic into enforceable. A HARD delete was undone on the ex-member's next group-scoped request, because `ensureGroupMember` treats possession of the group id as proof of membership and re-creates the row; a tombstone can only be cleared by a LINE-OBSERVED signal (message/postback/unsend/memberJoined, or a `members/ids` roster sync) through `upsertGroupMember`. The capability-only path may still auto-enroll a caller with NO row, but must never resurrect a tombstoned one. **Additive + either-order-safe** (NULL = active) |
| 050 | `050_task_urgency.sql` | `tasks.urgency` TEXT NULL CHECK (urgent_max/urgent/normal/relaxed) — creation-time ความเร่งด่วน; apply BEFORE deploying the web/API that sends it (older clients omit the column, so old-code/new-DB is safe). **Was mislabeled `048` in this map and in its own file header** — both corrected 2026-08-02; the `COMMENT ON COLUMN` text inside the file still says "(048)" and was left alone because it is a SQL statement |
| 051 | `051_membership.sql` | **ระบบสมาชิก** — widens `users.plan` to include `'premium'` (keeps `'team'`, normalised to premium in code); `subscriptions`, `user_quotas` (+ `consume_quota` / `release_quota` RPCs), `user_group_boosts` (+ `claim_group_boost`), `support_tickets`, `user_integrations`; `tasks.reminder_intervals INT[]` + `tasks.notify_only_pending`; widens `task_reminders.remind_type` for `2_days`/`6_hours`/`at_deadline`. **Apply BEFORE the API/worker deploy** — every quota-guarded route calls `consume_quota`. The monthly RESET is structural (rows are keyed by Bangkok `period_start`), so no job can fail it. Single source of truth for all limits is `apps/api/src/config/plans.ts`. |
| 052 | `052_diary_addon.sql` | **หนูเก็บความทรงจำ** — the standalone diary-reminder ADD-ON (any plan holds it; it is not a tier). New tables only, nothing existing is touched, so old code against the new schema is safe. **Apply BEFORE the API/worker deploy** — `routes/diaryAddon.ts` and the hourly sweep in `jobs/diaryReminder.job.ts` read these tables directly. The `POST /diary-addon/subscribe` route that writes them is currently **503-disabled** (see "Temporarily Disabled Endpoints") |
| 053 | `053_diary_push_optin.sql` | `diary_notification_settings.notification_enabled` — LINE push opt-in, default FALSE (distinct from `is_enabled`, which is the in-app banner). No diary push may go out without it. Apply BEFORE the API/worker deploy |
| 054 | `054_diary_reminder_last_sent.sql` | `diary_notification_settings.last_push_date` DATE — the per-day claim that makes the §17 sweep safe to run HOURLY (a retry / worker restart / `notify_time` edit would otherwise double-push). Claimed with a conditional UPDATE; Bangkok calendar date. Apply BEFORE the API/worker deploy |
| 055 | `055_reminder_intervals_minutes.sql` | §4b — re-bases `tasks.reminder_intervals` from HOURS to **MINUTES** and widens the menu from 5 lead times to 13 (15/30 นาที · 1/2/3/6/12 ชม. · 1/2/3/5 วัน · 1 สัปดาห์ · `-60` = the overdue chase, selectable in a form for the first time). Also widens `task_reminders.remind_type` for the seven new shot names; the six old names are unchanged, so no reminder row is rewritten. The hour→minute backfill is IDEMPOTENT because {3,6,24,48,72} and {3,6,24,48,72}×60 are disjoint — the same property `normalizeLeadMinutes` (packages/shared) relies on to read an un-converted row. **Apply BEFORE the API/worker deploy** (a new client's minute values fail the old CHECK); the reverse order is safe. The plan cap stays 1/2/4 — the menu widened, the entitlement did not |
| 056 | `056_reminder_short_leads.sql` | §4b — adds the two SHORT lead times 055 deliberately floored out: `5` (ก่อนกำหนด 5 นาที) and `0` (**ถึงกำหนดพอดี** — fire AT the deadline), taking the menu to **fifteen**. Widens both CHECKs only — **no data is rewritten**, unlike 055. `0` is a REAL lead time on this column, never a "ไม่เตือน" sentinel: that convention belonged to migration 047's `tasks.reminder_count`, and the CHECK's `cardinality >= 1` still forbids `{}` so absence can only be NULL. Disjointness holds — {5, 0} misses the legacy hour set {3,6,24,48,72}, every other minute choice, and −60. Also adds `5_min` / `at_deadline` to `task_reminders.remind_type` (additive). **Apply BEFORE the API/web deploy** (a new client's 5/0 fails the old CHECK); the reverse order is safe. Plan cap unchanged at 1/2/4 |
| 057 | `057_retire_task_pro_fake_doors.sql` | Retires the two ระบบตามงาน Pro **fake doors** (`task_auto_reminder` / `task_voice_command`, migration 040) — neither ever had a scheduler or a microphone behind it, and this is UNRELATED to the live reminder system (047/051/055/056) and to the gift-box voice notes. Closes `pro_interest.feature_id` with `CHECK (false) NOT VALID` (the allowed set is empty and a CHECK cannot spell `IN ()`; `NOT VALID` is what preserves the existing rows), DROPs `admin_pro_interest_tasks`, and DROP+CREATEs `admin_pro_interest_daily` without its now-always-zero `task_clicks` column. **No row is deleted** — `pro_interest` and its `pro_interest_*` usage_events rows stay as history. The gift-box half (`pro_interest_log`, `POST /api/pro-interest`, `admin_pro_interest_giftbox`) is untouched. Order-independent vs the deploy: the code that wrote these values is removed in the same change |
| 058 | `058_admin_ops_rpcs.sql` | TIER 1 of the ops dashboard — three read-only `CREATE OR REPLACE` aggregates for `/admin/system` (`admin_storage_totals`, `admin_reminder_outcomes_daily`, `admin_diary_addon_daily`). Nothing is created, altered or dropped, so it is **order-independent vs the deploy** and safe to re-run; every endpoint that reads them fails soft to empty/zero, so deploying first only means those cards stay blank. Bangkok day buckets, matching 029/042 |
| 059 | `059_admin_audit_and_settings.sql` | **TIER 2 — the admin WRITE surface.** `admin_audit_log` (append-only; `admin_line_id` is the LINE id from the session, NOT a users.id, because admin membership is the `ADMIN_LINE_USER_IDS` env allowlist and has no DB column, and it is deliberately not an FK so the trail outlives a deleted user; `before`/`after` JSONB carry only the fields the action touched, never whole rows). `system_settings` (JSONB key/value, seeded `push_enabled = true`) — a TABLE rather than an env var because the kill switch must take effect in BOTH processes within 60 s without a redeploy, which a per-service env var cannot do. `users.storage_limit_override` BIGINT NULL, folded in by `syncStorageLimit()` as `COALESCE(override, lockerLimitBytes(plan, referral_count))` so an admin-raised ceiling survives the next plan change / referral redemption / subscription lapse — the same class of bug 024's `GREATEST()` guard fixed on the referral path. **Apply BEFORE the API/worker deploy.** The two halves fail in opposite directions on purpose: CLOSED on the writes (every TIER 2 endpoint 500s without `admin_audit_log`, because an unaudited privileged write is worse than a failed one) and OPEN on the messaging (`getPushEnabled` returns true on a missing table, because an outage must never be able to mute the product). `syncStorageLimit`'s column read carries an explicit pre-059 fallback, so the reverse order degrades rather than breaking every plan change. Safe to re-run |
| 060 | `060_push_log_job_log_suspension.sql` | **TIER 3 — the HISTORY tables.** Everything 058/059 can see is CURRENT STATE (a queue's depth now, a reminder row's terminal stamp); none of it answers "how many pushes went out last Tuesday and why did the failures fail" or "is the file queue getting slower", because the live rows are overwritten and BullMQ's `removeOnComplete` evicts a job the moment it settles. `push_log` (one row per push ATTEMPT from inside `pushMessage`; four statuses, and the two `blocked_*` ones are the point — a push suppressed by the kill switch returns normally BY DESIGN and a quota-exhausted push looks like an ordinary 429, so neither left any trace). `job_log` (one row per settled job, all four queues). `users.suspended_at` + `suspended_reason`. **Apply BEFORE the API/worker deploy.** All three fail OPEN: both writers never throw (a throw after a delivered push would fail the BullMQ job and the retry would send the message TWICE; a throw inside a BullMQ listener is an unhandledRejection, and `workers/index.ts` exits(1) on those), and the auth middleware's `suspended_at` read carries an explicit pre-060 fallback. Safe to re-run |
| 061 | `061_feature_flag_seeds.sql` | **TIER 3 — five env flags become `system_settings` rows** so they are INCIDENT-time switches rather than deploy-time ones: `diary_reminder_enabled` / `diary_addon_enabled` / `scan_enhance_enabled` / `scan_ocr_enabled` / `virus_scan_enabled`. Pure seed data, no DDL, so it is **order-independent vs the deploy** and safe to re-run (`ON CONFLICT DO NOTHING` — it can never reset a switch an admin has since flipped, and therefore cannot be used to CHANGE one). **⚠ TWO SEEDS CHANGE BEHAVIOUR**: `scan_ocr_enabled` and `diary_addon_enabled` are seeded `true` while their env vars default to FALSE, and once a row exists it WINS over the env var (which survives only as `getFlag`'s fallback). The first turns the searchable-text layer on for every `finalize_scan` — tesseract over every page, a real ongoing worker CPU cost; the second registers the hourly add-on sweep, inert today only because `POST /diary-addon/subscribe` is 503-disabled. Seed `false` instead, or flip them at `/admin/system`, if that is not wanted. The other three match today's resolved values exactly |

Key invariants:
- Every content table carries `space_id` (or a per-feature owner key: diary/vault =
  `user_id`, tasks = `group_line_id` **or** `owner_line_uid`, never both).
- A LINE **user** id must NEVER be written to `tasks.group_line_id` (see §8).
- No direct pg/DDL access from tooling — schema changes are migration files applied
  manually in the Supabase SQL editor.

---

## 6. LINE Bot — Command Reference

**Messaging discipline.** Reply-only is the hard rule: `reply` is free and always
works, `push` burns metered quota and fails silently when exhausted. Workers cannot
reply with an expired token, so they either (a) carry the original `replyToken` in
the job payload and reply when the job is quick, or (b) queue the message via
`pending-notify.service`, which the webhook drains on the user's next **1-on-1**
text/postback event and prepends to that reply. Group chats never drain
pending-notify. The only sanctioned pushes are Task Manager announcements, review-
loop notices and scheduled reminders (`pushMessage` in `line.service.ts`).

**Address prefix.** `stripBotPrefix()` strips a leading `หนูเก็บ` and reports
`prefixed`. Bare `หนูเก็บ` maps to `เมนู`. `isCmd` is an EXACT match after
zero-width stripping + NFC + lowercase, so `รวมไฟล์` / `รวมรูป` / `แปลงไฟล์` /
`ฟีเจอร์` / `ฟีเจอร์เอกสาร` never shadow each other.

**Group/room guard.** In a group or room the bot stays silent unless the message is
`หนูเก็บ`-prefixed, matches `ผูกทีม <n>`, or is caught earlier by the task command /
natural-language / pending-due handlers (which run BEFORE the guard on purpose).

**Almost every command now requires the `หนูเก็บ` prefix.** Only `เสร็จ`, `ยกเลิก`
and `ติดต่อหนูเก็บ` work bare.

| Command | Where | What it does | Handler / card |
|---|---|---|---|
| `หนูเก็บ` / `หนูเก็บเมนู` | any | quick-reply menu (different button set in group vs 1-on-1) | `replyWithQuickReply` |
| `หนูเก็บคำสั่ง` | any | full command-name list | `buildCommandListFlexMessage` |
| `หนูเก็บวิธีใช้` | any | how-to card | `buildHelpFlexMessage` |
| `หนูเก็บแนะนำตัว` | any | one-line self-intro text | `INTRO_TEXT` |
| `ติดต่อหนูเก็บ` (bare, also `หนูเก็บ…`) | any | support text + `lin.ee/Z0ewNYb` | `SUPPORT_TEXT` |
| `หนูเก็บล็อคเกอร์` | any | quick-reply link to `/dashboard` | — |
| `หนูเก็บฟีเจอร์` | 1-on-1 only | 7 quick replies (bot features + web links) | — |
| `หนูเก็บฟีเจอร์เอกสาร` | any | 3 quick replies: แปลงไฟล์ / สแกนสี / รวมไฟล์ | — |
| `หนูเก็บเพิ่มเติม` | group → 3 admin quick replies; 1-on-1 → feature image carousel | | `buildFeatureCarouselMessage` |
| `หนูเก็บกล่องของขวัญ` / `หนูเก็บห้องนิรภัย` / `หนูเก็บงานของฉัน` | 1-on-1 only | quick-reply link to the matching dashboard page | — |
| `หนูเก็บสแกน` | 1-on-1 | open a `scan` session in the default mode (or ack if one is open) | `buildScanFlexMessage` |
| `หนูเก็บสแกนสี` / `หนูเก็บสแกนขาวดำ` | 1-on-1 | open in — or switch an open session to — that mode | — |
| `หนูเก็บรวมไฟล์` | 1-on-1 | open a `pdf` session: accepts **images AND .pdf files**, merges to one PDF | `buildPdfMergeFlexMessage` |
| `หนูเก็บรวมรูป` | 1-on-1 | **silent no-op** — consolidated into รวมไฟล์ | — |
| `หนูเก็บแปลงไฟล์` | 1-on-1 | arm the one-shot convert-to-Word flag (needs `MISTRAL_API_KEY`) | `buildDocxConvertFlexMessage` |
| `หนูเก็บไดอารี่` | 1-on-1 | arm the one-shot diary flag (rejects if today already has an entry) | `buildDiaryPromptCard` |
| `เสร็จ` (bare) | 1-on-1 | finalize the open session → enqueue `finalize_scan` | `buildFinalizingFlexMessage` |
| `ยกเลิก` (bare) | 1-on-1 | cancel session / disarm diary / disarm convert (kind-aware copy) | — |
| unprefixed text while diary armed | 1-on-1 | captured as the pending entry's caption (Redis `SET XX KEEPTTL`) | — |
| `หนูเก็บเชิญ…` | any | referral invite card + code | `buildInviteFlexMessage` |
| `หนูเก็บกรอกโค้ด <CODE>` | any | redeem a referral code (rate-limited 1/h) | `buildRedeemSuccessFlexMessage` |
| `หนูเก็บผูกทีม [n]` / `ผูกทีม <n>` | group only | bind the group to the sender's team (auto if exactly one) | — |
| `หนูเก็บยกเลิกผูกทีม` | group only | unbind (owner/admin only) | — |
| `หนูเก็บไอดีกลุ่ม` | group only | print the LINE group id | — |
| `หนูเก็บคู่มือทีม` | any | team onboarding guide | `buildTeamGuideFlexMessage` |
| `หนูเก็บลงทะเบียน` | group/room | legacy roster opt-in (the roster now fills itself) | `handleRegisterCommand` |
| `หนูเก็บเตือนงาน` (bare) | group → help card; 1-on-1 → งานส่วนตัว create card | | `buildTaskCommandHelpCard` / `buildCreateTaskCard(…,'personal')` |
| `หนูเก็บเตือนงาน @… <งาน> ส่ง <วัน> [เตือน N ครั้ง]` | group/room | parse → **confirmation card** (does NOT create yet) | `buildTaskConfirmCard` |
| `หนูเก็บสั่งงาน …` | group/room | legacy alias of the above | same |
| un-prefixed group message that @mentions someone | group/room | natural-language detection → confirm card, or one due-date follow-up question | `detectNaturalTask` |
| any other `หนูเก็บ…` in 1-on-1 | 1-on-1 | "หนูไม่เข้าใจคำสั่งนี้น้า…" nudge | — |

**Retired / removed** (documented so nobody re-adds them by memory):
`หนูเก็บสร้างงาน`, `สร้างงาน` (unprefixed), `หนูเก็บห้องทีม`,
`หนูเก็บปิดแจ้งเตือน` / `หนูเก็บเปิดแจ้งเตือน`, `รวมรูป` (now a no-op),
`สมัคร`/`/register` text aliases, and every bare (unprefixed) form of the
feature commands.

**Non-text events**
- `follow` (1-on-1) → 8-bubble onboarding carousel.
- `join` (group) → onboarding carousel **plus** `buildGroupWelcomeCard` in the SAME
  reply (a join grants exactly one replyToken and a follow-up push is forbidden).
- `memberJoined` → enroll each new member into `group_members` immediately.
- `unsend` (group) → refresh the sender's roster row.
- every group/room `message` and `postback` → fire-and-forget roster upsert
  (`autoUpsertGroupMember`, profile via the group-scoped `getChatMemberProfile`).

**Media routing order** for an image/file in 1-on-1: diary one-shot → convert
one-shot → active session page → (redelivery dedup) → normal debounced upload batch.
Diary and convert flags are consumed atomically via a `GETDEL` pipeline; if diary
wins while convert was also armed, convert is re-armed.

---

## 7. LINE Bot — Postback Actions

| `postback.data` | Card that emits it | Handler | Effect |
|---|---|---|---|
| `action=task_accept&taskId=…` | `buildTaskCreatedFlex` / `buildReminderFlex` (รับทราบ) | `task-handlers.ts` `handleTaskPostback` | stamps `accepted_at` on the tapper's items; replies |
| `action=task_done&taskId=…[&itemId=…]` | task created / reminder card (เสร็จแล้ว) | same | stamps `done_at`, rolls up completion, cancels reminders when the task completes |
| `task_cmd_confirm:{nookeb:confirm:group:commander}` | `buildTaskConfirmCard` (ยืนยัน) | `task-command-handlers.ts` `handleTaskConfirmPostback` | GETDEL-claims the pending intent → creates the task → replies `buildTaskCreatedFlex` |
| `task_cmd_cancel:{…}` | `buildTaskConfirmCard` (ยกเลิก) | same | deletes the pending intent |
| `หนูเก็บ` (literal) | onboarding + feature carousel bubbles | routed through `handleTextCommand` | opens the quick-reply menu — **placeholder, still marked TODO in `flex.service.ts`** |

Routing order in `line.ts`: roster upsert → `action=task_*` → `task_cmd_*` →
pending-notify drain → `handleTextCommand(postback.data)`.

Confirm/cancel keys are validated by **reconstructing** `confirmKey(groupId, tapper)`
from the live event — only the commander who issued the command, in that group, can
act on it.

---

## 8. Task System — full lifecycle

**Storage model.** `tasks` (+ `task_items` + `task_assignees` + `task_links` +
`task_files` + `task_reminders`) and `group_members`. A task is in exactly one mode
(CHECK `tasks_scope_exclusive`, migration 043):
- **group**: `group_line_id` set, `owner_line_uid` NULL. Tenant key is the LINE group
  id, treated as an unguessable capability (same trust model as share links).
  `tasks.space_id` is informational only.
- **personal**: `owner_line_uid` set (from the verified session only),
  `group_line_id` NULL, no roster, no `group_members` write, no space lookup.
  A LINE user id must NEVER be stored as `group_line_id` — `ensureGroupMember`
  treats "holds the id" as proof of membership, which is only safe for group ids.

Types: `single` (one implicit item), `multi` (per-item assignees/deadlines; items
without their own deadline share ONE task-level reminder round), `recurring`
(`recurrence_rule` JSONB, Bangkok wall clock; never reaches status `done`).

**Roster (`group_members`) fills itself** — nobody types `/register`:
1. every group message/postback/unsend upserts its sender;
2. `memberJoined` enrolls new members instantly;
3. `GET /groups/:id/members` runs a Redis-throttled `syncGroupRoster` (10 min/group,
   always when empty) against LINE `members/ids` — verified/premium OA only;
4. task routes auto-enroll the caller (`ensureGroupMember`).
Display names always come from `getChatMemberProfile` (group-scoped; works for
members who never friended the OA), never from the client.

### Creation paths

**A. LIFF flow** (`/liff/tasks/create/*`): 4 steps (type → detail → members → submit)
→ `POST /tasks`. Group tasks get an immediate Flex **push** announcement; personal
tasks get none (`announced=false`) because the only recipient just pressed submit.

**B. Dashboard** (`/dashboard/tasks` → `CreatePersonalTaskModal`): personal single
tasks only, same `POST /tasks` with `scope:'personal'`.

**C. In-chat command** (`หนูเก็บเตือนงาน …`, group/room only):
1. `parseTaskCommand` (pure) reads inbound @mentions and a Thai due clause
   (`ส่ง`/`กำหนด`/`กำหนดส่ง`/`ภายใน`/`due`/`deadline` + `วันนี้`/`พรุ่งนี้`/`มะรืนนี้`/
   `อีก N วัน`/`DD/MM[/YYYY]` + optional `HH:MM`; default 18:00; 2-digit or ≥2400
   years read as Buddhist; day-overflow and past dates rejected).
   `@all` → hard error. A mention LINE can't resolve to a `userId` → hard error
   (never assign silently). Typed error codes map to Thai copy in `ERROR_TEXT`.
2. `เตือน N ครั้ง` is extracted and **Pro-gated** at card-build time so the card
   shows the EFFECTIVE count (free users see a Pro note; `selectRemindTypes`
   priority is `1_day → 3_hours → overdue → 3_days`).
3. The intent is stashed in Redis (`nookeb:confirm:{group}:{commander}`, 5 min) and a
   **confirmation card** is replied. Nothing is created yet.
4. `ยืนยัน` → `claimPendingConfirm` (GETDEL, exactly-once) → an NX
   `nookeb:taskcmd:{message.id}` claim guards double-create → `createTaskWithItems`
   → `scheduleReminders` → `enqueueSheetsSync` → reply `buildTaskCreatedFlex`.
   A failed create releases the claim and RESTORES the pending intent for a retry.
   `ยกเลิก` deletes the key.

**D. Natural language** (`task-nl.ts`, un-prefixed group message that @mentions
someone, run BEFORE the group guard): a deliberate heuristic, not NLP.
- HIGH (assignee + title + future due clause) → straight to the confirmation card.
- MEDIUM (assignee + a task-verb-gated title, no due) → ONE follow-up question
  ("…ส่งเมื่อไหร่คะ?"); the partial sits in `nookeb:taskpartial:{group}:{commander}`
  (5 min) and the commander's next date-bearing message completes it into a
  confirmation card. A non-date reply is ignored — it never asks twice.
- LOW → silent. It reuses the strict parser's primitives and NEVER creates directly.

### Work / review lifecycle

`pending` → assignee taps **รับทราบ** (`accepted_at`) → either:
- **เสร็จแล้ว** (postback or `POST …/items/:itemId/done`) → `done_at` per assignee;
  `rollUpCompletion` flips the item, then the task, when all assignees are done; a
  completed task cancels outstanding reminders; or
- **ส่งงานกลับ** (`POST …/items/:itemId/submit`, LIFF `[taskId]/submit`) → item
  `submitted`, `submitted_at` + `submission_note`. Deliberately does NOT stamp
  `done_at` (that would be self-approval). Files upload FIRST, then the status flip.
  Then the creator either **รับงาน** (`…/approve` → `markAllAssigneesDone` →
  `rollUpCompletion` owns the status) or **ตีกลับ** (`…/reject`, reason MANDATORY →
  item `rejected`, `rejection_note`).
All three review transitions QUEUE one `task_notify` job (personal tasks skip it,
and so does a false `TASK_NOTIFICATIONS_ENABLED` — that guard was missing until
2026-08-01 and let the review loop message groups while every other task push was
disabled). `resetRecurringRound` clears review fields so a new round starts clean.

### Reminders (ON since 2026-08-01)

`TASK_NOTIFICATIONS_ENABLED` in `packages/shared/src/task-notifications.ts` is now
a **default-ON kill switch**, not a hard-coded `false`: it reads
`process.env.TASK_NOTIFICATIONS_ENABLED` and only the exact string `"false"`
disables. The env read is guarded for the browser bundle (the LIFF imports this
module), so the web always resolves to ON.

It gates EVERY task push — scheduled reminders, the create announcement, the
cancel notice, and the review-loop notices. While false: `scheduleReminders`
creates no `task_reminders` rows and no delayed jobs, `enqueueTaskNotify` queues
nothing, both worker handlers stand in-flight jobs down, and the LIFF hides copy
promising reminders. Recurring **rollover still schedules** so rounds keep
advancing.

**Every task push goes through the queue.** `enqueueTaskNotify` (taskScheduler)
adds a `task_notify` job; no route calls `pushMessage` directly any more. That
puts announcements, cancel notices and review notices behind the SAME worker
rate limiter as reminders — `limiter: { max: 10, duration: 1000 }` on
`createTaskReminderWorker`, which is the whole product's push governor. LINE's
technical ceiling is ~2,000 req/s; the 10/s figure is chosen against the monthly
push ALLOWANCE (metered, fails silently when spent), not the rate limit.
`POST /tasks` now returns `announced` meaning QUEUED, not delivered.

When on: offsets `REMIND_OFFSETS_MINUTES` = −3 d / −1 d / −3 h / +1 h relative to the
effective deadline; one row + one delayed BullMQ job per shot
(`jobId = reminder-{rowId}` — the row id IS the idempotency key); delivery is ONE
push carrying a textV2 @mention (skipped for personal tasks — mentioning someone in
their own DM is meaningless) plus an urgency-coloured Flex card; 3 attempts,
exponential 10 s; final failure stamps `failed_at`. Rows are stamped
(`sent_at`/`failed_at`/`cancelled_at`), never deleted. `notifyTarget(task)` is the
single task→destination mapper — never reach for `group_line_id` directly.

Recurring rollover: `task_recur_next` at deadline + 90 min resets marks, advances
`global_deadline`, schedules the next round. A 30-minute **in-process interval**
enqueues a zero-delay `task_recur_sweep` self-heal job (deliberately NOT a BullMQ
repeatable/scheduler — a standing delayed job pins the idle worker's blocking poll to
10 s; see the long comment in `taskScheduler.ts`).

### Reporting

- **.xlsx export** — `GET /tasks/export?format=xlsx&from&to&status`, ONE ROW PER
  ITEM, scoped by `listTasksForUser` (creator or assignee), cap 500 tasks, dates
  written +07:00-shifted on purpose so Excel shows Bangkok wall clock,
  "อัปเดตล่าสุด" DERIVED via `resolveUpdatedAt` (there is no `updated_at` column).
  The web's Export button exports EVERYTHING, never the active tab.
- **Google Sheets mirror** — keyed by a hidden `รหัสงาน` column in the sheet itself
  (the user can re-sort rows, so a cached row index would be wrong). ROW MODEL
  (2026-08-01): single/recurring = one row keyed by the bare task id; **multi = one
  row per sub-item**, keyed `{taskId}-{itemId}` (`taskRowKey` in `sheets-row.ts`),
  each carrying the ITEM's own deadline/assignees/status, title "งาน - รายการย่อย".
  `syncTaskToSheet` takes the ROWS array, claims a pre-B legacy bare-id row for the
  first item that lacks one (in-place upgrade), and strikes through orphaned item
  rows. Always queued, never inline. See §12/§13. Two sync-delivery rules learned
  the hard way (regression-tested in `task-handlers.test.ts`): (1) webhook postback
  handlers have NO onResponse hook — every task write in `task-handlers.ts` must
  call `enqueueSheetsSync` itself; (2) `sheets_sync` jobs MUST keep
  `removeOnComplete/removeOnFail: true` — a settled job whose stable jobId lingers
  in BullMQ's completed set silently swallows every later sync for that task.
  รับทราบ (LINE postback AND `…/accept`) also promotes a pending item+task to
  `in_progress` (`promoteToInProgress`), so acceptance is visible in every mirror.
  `tasks.urgency` (migration 048, canonical keys) is chosen at creation in the LIFF
  detail step and the dashboard modal, and becomes column K's INITIAL value only —
  K stays the user's column after the first fill.
  The mirror is EVENT-DRIVEN, so tasks that predate the connect are invisible to it;
  `sheets-historical.service.ts` backfills them (creator's tasks only, cap 500, oldest
  first, chunked appends of 100). It runs automatically the first time a spreadsheet is
  written to and on demand from `POST /integrations/google/sync-historical` — the
  dashboard button, and the `🔄 sync ประวัติงาน` HYPERLINK on the ภาพรวม tab, which
  points at `/dashboard/settings?sync=historical` because a Sheets cell can only GET and
  the session cookie lives on the web origin. Duplicate guard = the sheet's own รหัสงาน
  column, read fresh each run, so re-running is always safe. "Has it run?" is
  spreadsheet developer metadata (`nookeb_historical_sync`), NOT a DB column: a user who
  deletes their sheet must get a fresh backfill, which a DB flag would deny.
  The spreadsheet is a full **workspace**, not a bare table (`sheets-workspace.service.ts`,
  `LAYOUT_VERSION` = 6): tabs ภาพรวม / ความสำคัญ / ติดตามสถานะ / รายงานทีม / ปฏิทิน /
  วิเคราะห์ (month-anchored 1-7/8-14/…/29-end ranges) / สรุปงาน (date-or-month picker,
  replaced สรุปสัปดาห์) / งานเสร็จ (completed-task report: days-to-complete from the
  real P/Q stamps, distribution + per-person charts) / **รายงานผลการทำงานรายบุคคล**
  (v6, see below) / วิธีสั่งงาน plus hidden `_ข้อมูลคำนวณ` + `_ตัวเลือก`.
  The `📋 สั่งงาน` form tab was REMOVED in v4 —
  `LEGACY_TABS` lists it (and the old สรุปสัปดาห์ title) so a rebuild deletes them
  from upgraded sheets without recreating them. The nav strip is NINE links since v6,
  so every visible tab is at least 9 columns wide (`sizeOf` widens automatically).
  Every view is a FORMULA over `_ข้อมูลคำนวณ` — no Apps Script, no extra OAuth scope,
  nothing for the user to install. Column rules: **A–J belong to the sync** (values AND
  background repainted every write), K–S are the workspace's — K ความเร่งด่วน and
  N หมายเหตุ are the USER's (filled only when blank, never overwritten), L/M/O, the
  hidden real-date columns P/Q/R and the visible S ⏱ เวลาตอบรับ (ชม.) are
  worker-written by the single `extensionUpdates` writer (which carries the owned-range
  table — anything new starts at T and must be declared in `MASTER_EXT`).
  CF over A–J may set font colour
  only. **ความคืบหน้า is the PIPELINE STAGE, not a done flag** (`STAGE_PROGRESS`,
  since v5): ยกเลิก 0 / รอดำเนินการ 25 / กำลังทำ 50 / ตีกลับ 50 / รอตรวจ 75 /
  เสร็จแล้ว 100 %, pinned to the สายพานสถานะ dots in calc column Q and tested
  against them. It is computed TWICE from that one table — `progressForStatus`
  writes master column L, and calc column W derives the same string from column H
  so existing rows are right without a re-sync. ปฏิทิน is the one view that shows
  เสร็จแล้ว (with a ✓), so it cannot use calc column N and spells out its own
  `<>"ยกเลิก"` / `<>"ลบแล้ว"` exclusion instead.
  **Performance layer (v6).** Master column S carries hours from assignment to the
  first รับทราบ (`acceptHours` in `sheets-row.ts`, earliest `accepted_at` across the
  row's assignees, baseline = `tasks.created_at` because no per-assignee "assigned at"
  stamp exists). It is BLANK, never 0, when nobody has acknowledged — 0 would claim an
  instant reply and drag every average down. The historical backfill needs no extra
  code: it shares `toSheetRows` + `extensionUpdates`.
  `_ข้อมูลคำนวณ` gained X–AD (`CALC_PERF`), all plain numbers because the only
  per-person grouping available is `SUMPRODUCT(ISNUMBER(SEARCH(name, ผู้รับผิดชอบ)) * …)`
  — the assignee cell is comma-joined names, so COUNTIFS/AVERAGEIFS cannot reach it, and
  SUMPRODUCT reads non-numeric entries as 0 so an ARRAYFORMULA's trailing blanks are
  harmless. Each measure ships with its OWN denominator: X÷Y on time (a late row is in
  Y but not X; a task with no deadline is in neither), Z÷AA lateness in days
  (**averaged over late rows only** — dividing by the completed count answers a
  different question), AC÷AD acknowledgement hours (gated on `ISNUMBER`, not `>0`,
  because a genuine 20-second reply rounds to 0.01). AB buckets by INTAKE month
  (column P), not deadline. Every ratio degrades to blank, so "no evidence" never
  renders as 0. รายงานทีม now shows **% เสร็จทั้งหมด** and **% เสร็จตรงกำหนด** side by
  side — the old ambiguous "% สำเร็จ" only ever meant the former.
  The 📊 รายงานผลการทำงานรายบุคคล tab is one row per person (roster reused from
  `_ตัวเลือก`), sorted by งานทั้งหมด desc via one `ARRAY_CONSTRAIN(SORT(FILTER({…})))`
  spill, with a J/K block that re-sorts the table's own output by on-time % to feed the
  single BAR chart. Sub-70 % gets a pale amber coaching tint guarded by `<>""`.
  Two caveats are printed IN THE TAB, not just in a report: rejection counts anywhere
  in the workspace are current-state only (`task_items` keeps one `rejected_at`,
  overwritten on the next submit — a task bounced three times is indistinguishable from
  one approved first try), and a blank cell means "not measurable", not zero. The tab
  deliberately carries **no urgency metric** — `tasks.urgency` is only set by the
  LIFF/dashboard create flows, so chat-created tasks have none and any urgency split
  would rank people by which door their work arrived through. Both gaps need a schema
  decision that has NOT been taken; do not "fix" either as a side effect.
  The layout version is spreadsheet developer metadata; the worker checks it at
  most once per 6 h per sheet and rebuilds the generated tabs when it differs, which is
  how existing users get a new layout without doing anything.
  **Two invariants the whole workspace rests on** (both regression-tested in
  `sheets-workspace.service.test.ts`):
  1. `_ข้อมูลคำนวณ` reaches the master ONLY through `INDIRECT("…")` (`pinToMaster`).
     Sheets rewrites direct references when a row is inserted, and the sync appends
     task rows — a literal `'งานของฉัน'!J2:J` drifted one row per task until every
     view read from below the data and reported zero. The sync therefore also must
     NOT use `insertDataOption:'INSERT_ROWS'`.
  2. Row 1 of every VISIBLE tab is the nav strip. Builders author in nav-free
     coordinates and `composeWorkspacePlans` applies the offset via `shiftPlan`;
     a formula pointing at its own tab must go through `self()`. The hidden tabs and
     the master are never shifted — the master's row 1 is the sync's header row.
  A third invariant since v4: charts whose SOURCE ranges live on a nav-shifted tab
  must go through `composeChartRequests`/`shiftChart`, which shifts sources along
  with the anchor (the pre-v4 analytics charts read one blank row and dropped their
  newest data row). A fourth since v5: a `viewFormula` cell SPILLS over its
  `ARRAY_CONSTRAIN(…, rows, cols)` footprint, and Sheets answers a blocked spill
  with `#REF!` for the whole block — which the formula's own `IFERROR` does NOT
  catch. The dashboard activity feed (10 rows from A21) sat exactly on the
  '📊 กราฟสรุป' title at A30 and died for every user with 10+ rows; the charts
  block moved to row 32 and a test now asserts no spill footprint overlaps any
  other write on any tab.
  **The Apps Script add-on is retired as of v5** — `google-sheets-workspace/` is
  dead code kept only for reference and is no longer advertised anywhere in the
  product. Two of its three features (the ส่งงาน submit button and the urgency
  buttons) keyed off the 📋 สั่งงาน tab that v4 removed and `LEGACY_TABS` now
  deletes, so `onEdit()` returns immediately and `submitForm()` throws; the third
  (a 07:00 overdue scan into column S) only duplicates calc column M. Apps Script
  CANNOT be auto-installed anyway (needs the `script.projects` scope plus a
  per-user API toggle). Do not re-add an install prompt to วิธีสั่งงาน.
- **ห้องทีม** — group-keyed room payload (`team-room.service.getTeamRoom`), reachable
  two ways: `GET /groups/:groupId/room` (capability) and `GET /spaces/:id/tasks`
  (dashboard side; 404 `NOT_A_GROUP_SPACE` for a personal space). Returns
  `space: null` when the group has no space yet. `listTasksForGroup` also filters
  `is_personal = false` as defence in depth.

---

## 9. API Routes

All authenticated routes use `app.authenticate` (JWT from the HttpOnly `session`
cookie or a Bearer header; checks `session_version`). Global limit 100/min per IP.
🔒 = authenticated.

**Auth** — `POST /auth/line` (LINE Login code → cookie; 10/min + ban:5) ·
`POST /auth/liff` (LIFF id token verified against LINE, `aud` = LINE_LOGIN_CHANNEL_ID
→ same cookie) · `POST /auth/logout` · `GET /auth/me` 🔒

**Webhook** — `POST /webhook/line` (HMAC only, no auth, exempt from the limiter)

**Files / organise** 🔒 — `GET /files` · `GET /files/stats` · `GET /files/:id` ·
`POST /files/:id/download-token` · `GET /files/:id/download?dl_token=` ·
`PATCH /files/:id` · `POST /files/:id/tags` · `DELETE /files/:id/tags/:tagId` ·
`DELETE /files/:id` · `GET|POST /folders`, `PATCH|DELETE /folders/:id` ·
`GET|POST /tags`, `PATCH|DELETE /tags/:id` · `GET /spaces` ·
`GET /spaces/:id/members` · `GET /spaces/:id/tasks?groupId=`

**Share** — `POST|GET /files/:fileId/shares` 🔒 · `DELETE /files/:fileId/shares/:shareId` 🔒 ·
`GET /share/:token` and `GET /share/:token/download` (public, own limits)

**Trash** 🔒 (uploader-scoped, never space membership) — `GET /trash` ·
`POST /trash/:id/restore` (re-charges the same ledger, 409 `QUOTA_EXCEEDED`) ·
`DELETE /trash/:id/permanent` · `POST /trash/empty` (batches of 20)

**Diary** 🔒 (user-scoped) — `GET /diary/entries` · `/diary/streak` ·
`/diary/today-status` · `GET /diary/entry/:date` · `DELETE /diary/entry/:id` ·
`PUT /diary/notification`

**Vault** 🔒 — `POST /vault/setup-pin` · `/vault/unlock` · `/vault/lock` ·
`GET /vault/session-status` · `POST /vault/upload` (multipart) ·
`GET /vault/stats` · `GET /vault/files` · `GET /vault/files/:id/view` (streams
decrypted bytes; images watermarked; video Range-capable) · `DELETE /vault/files/:id`
(re-verifies the PIN). Lock states are **403 + `code`** (`VAULT_LOCKED` /
`VAULT_PREMIUM_REQUIRED`), never 401.

**Legacy Box** — `POST /legacy-box` 🔒 (multipart: ≤10 photos + optional voice) ·
`GET /legacy-box` 🔒 · `DELETE /legacy-box/:id` 🔒 ·
`PATCH /legacy-box/:id/reorder` 🔒 · `GET /legacy-box/open/:slug` (public, 30/min per
IP, noindex + no-store, 120 s presigned photo URLs, `?preview=1` = non-counting read)

**Tasks** 🔒 — `POST /tasks` (10/min) · `GET /tasks/mine` · `GET /tasks/export`
(10/min) · `GET /tasks/:id` · `PATCH /tasks/:id` · `DELETE /tasks/:id` (cancel) ·
`PATCH /tasks/:id/items/:itemId` · `POST …/items/:itemId/done` · `…/accept` ·
`…/submit` · `…/approve` · `…/reject` · `PATCH …/items/:itemId/note` ·
`PUT …/items/:itemId/assignees` (403 for personal tasks) · `POST|DELETE /tasks/:id/links[/:linkId]`
(max 20, http(s) only) · `GET /tasks/:id/ics` (**unauthenticated by design** — the
Flex button opens an external browser with no cookie; the task UUID is the
capability, own 30/min per-IP limit, noindex + no-store).
An `onResponse` hook enqueues a Sheets sync for every 2xx write on `/tasks/:id…`;
create enqueues explicitly.

**Task files** 🔒 (own multipart scope) — `POST /tasks/:taskId/files` (5 files/req,
20 MB/file, 30/task; multipart THROUGH the API, no presigned PUT, charged to the
UPLOADER's personal pool after the stream is counted) · `GET /tasks/:taskId/files`
(presigned GETs) · `DELETE /tasks/:taskId/files/:attachmentId` (uploader or creator)

**Groups** 🔒 — `GET /groups/:groupId/members` · `POST /groups/:groupId/register` ·
`GET /groups/:groupId/room`

**Teams** 🔒 (prefix `/api/teams`) — `POST /` · `GET /` · `GET|DELETE /:teamId` ·
`POST /:teamId/invite` · `POST /invite/:token/accept` · `GET /:teamId/requests` ·
`POST /:teamId/requests/:id/{approve,reject}` · `DELETE /:teamId/members/:userId` ·
`POST /:teamId/groups` · `DELETE /:teamId/groups/:groupId`

**Integrations** 🔒 — `GET /integrations/google` (status; never returns the token) ·
`GET /integrations/google/auth` (consent URL as JSON — a 302 would be swallowed by
fetch) · `GET /integrations/google/callback` (redirects to
`/dashboard/settings?google=…`) · `DELETE /integrations/google` ·
`POST /integrations/google/sync-historical` (queue a one-shot backfill of every
task the user created before connecting; 3/10 min, 409 when not connected)

**Analytics / admin** — `GET /me/usage` 🔒 · `POST /api/events/track` 🔒 ·
`POST /api/pro-interest` (**unauthenticated**, anonymous gift-box demand test,
10/min per IP; the authenticated `POST|GET /pro-interest` task twin was removed
with the task fake doors — migration 057) ·
`GET /admin/{users,spaces,overview,timeseries,features,power-users,pro-interest,tasks,funnel,adoption,storage,referral}`
and `PATCH /admin/users/:id` — all gated by `ADMIN_LINE_USER_IDS`

**Admin ops** (`routes/admin-ops.ts`, same gate) — READS, all fail-soft to empty/zero:
`GET /admin/system/{queues,health,stuck-files}` · `GET /admin/{notifications,quotas,membership}` ·
`GET /admin/support/tickets?status=`

**Admin TIER 2 writes** — the INVERSE contract: zod-validated, never fail-soft, and
every one records a row in `admin_audit_log` via `requireAdminAction()` before
answering 2xx. `GET /admin/settings` · `PUT /admin/settings/push_enabled` ·
`PATCH /admin/users/:id/{plan,storage-override}` ·
`POST /admin/users/:id/quotas/:feature/reset` · `POST /admin/users/:id/revoke-sessions` ·
`POST /admin/system/queues/:queue/jobs/:jobId/{retry,remove}` ·
`POST /admin/tasks/:taskId/cancel-reminders` · `PATCH /admin/support/tickets/:id`.
PostgREST has no multi-statement transaction, so these use COMPENSATION, not
atomicity: reversible writes read `before`, write, audit, and revert on an audit
failure (→ 500); the two IRREVERSIBLE BullMQ ops audit FIRST and act second.
`PATCH /admin/users/:id/plan` is an override, not a purchase — it never touches
`subscriptions` and never calls `changePlan()`, so the billing seam stays
single-caller (see "Temporarily Disabled Endpoints").

**Admin TIER 3 reads** (fail-soft) — `GET /admin/line-quota` (LINE's OWN monthly
push allowance; the one quota figure that is not the product's own accounting,
and the one that decides whether messaging silently stops mid-month) ·
`GET /admin/flags` (every runtime switch, read UNCACHED per key; a key that
cannot be read degrades to its documented fallback and is listed in `stale`
rather than failing the payload) · `GET /admin/push-log?days=&context=&status=` ·
`GET /admin/system/job-throughput?days=&queue=` (aggregated in process — there
is no RPC for this shape and PostgREST cannot GROUP BY, same pattern as
`/admin/quotas`) · `GET /admin/system/r2-reconcile/status`.

**Admin TIER 3 writes** — same audited, never-fail-soft contract as TIER 2.
`PUT /admin/flags/:key` (allowlisted keys only, 400 otherwise — `system_settings`
is a generic table and an open endpoint would let a typo create a switch that
looks real and controls nothing. THREE mechanisms behind one endpoint:
`push_enabled` DELEGATES to `setPushEnabled` so the product's most important
switch keeps exactly one writer and one cache key; `diary_reminder_enabled`
calls `setFlag` and THEN `toggleDiaryReminderSchedule`; everything else is plain
`setFlag`) · `POST /admin/system/r2-reconcile` (singleton by a fixed jobId;
409 while one is waiting/active, and a SETTLED singleton is removed first —
the `sheets_sync` lesson, where a lingering settled job with a stable id
swallows every later run. Audits FIRST, then enqueues) ·
`POST /admin/users/:id/{suspend,unsuspend}` (see §16).

**Misc** — `GET /health` (returns `RAILWAY_GIT_COMMIT_SHA`) ·
`GET /progress/:batchId[/view]` (limiter-exempt) · `GET /referral/status` 🔒 ·
`POST /referral/redeem` 🔒 · `GET /static/welcome.jpg`, `/static/onboarding/:n.jpg`

---

## 10. Web Dashboard Pages

All dashboard pages are client components calling the API **same-origin** through the
Next `/api-proxy/:path*` rewrite (Safari ITP / the LINE in-app browser block the
cross-site cookie). `apps/web/lib/api.ts` holds ~101 client functions + DTO types.

| Route | Shows | Calls |
|---|---|---|
| `/` | public landing page (hero, features, polaroid gallery, 3-step how-to, referral ladder, trust strip, FAQ + FAQPage JSON-LD from one `FAQS` array, CTA) | none |
| `/dashboard` | file browser: folders, tags, search, grid/list, preview modal, usage bar, recent strip, trash count, profile sheet (vault / legacy-box / referral entries) | files, folders, tags, spaces, usage, stats, trash |
| `/dashboard/diary` (+ `/[date]`) | 365-grid, streak, scrapbook viewer, in-app reminder banner | `/diary/*` |
| `/dashboard/vault` | PIN pad, unlock session, encrypted file list + inline viewer | `/vault/*` |
| `/dashboard/trash` | soft-deleted files, restore, permanent purge, empty-all | `/trash/*` |
| `/dashboard/legacy-box` (+ `/new`) | box list; 4-step create (โอกาส → รูป → ข้อความ+ประโยคส่งท้าย → ธีม), voice recorder, share actions | `/legacy-box*`, `/api/pro-interest` |
| `/dashboard/teams` (+ `/[teamId]`) | teams, members, invites, join requests, group binding, team storage | `/api/teams/*` |
| `/dashboard/tasks` | งานของฉัน: tabs (active/overdue/done/cancelled), filter+sort bar with Export, calendar, progress ring, stats, activity feed, today-focus banner, pins/collapse/view-mode persisted in localStorage, personal-task create modal, plan badge | `/tasks/mine`, `/tasks/:id…` |
| `/dashboard/tasks/[taskId]` | task detail: items, assignees, links, attachments, done/accept/note, creator's รับงาน/ตีกลับ, edit assignees (hidden for personal) | `/tasks/:id*`, `/groups/:id/members` |
| `/dashboard/settings` | การเชื่อมต่อ — Google Sheets connect/disconnect (the OAuth callback's redirect target) | `/integrations/google*` |
| `/admin` | one scrollable analytics page, hand-rolled SVG/CSS charts, shared 7/30/90-day range; the user drawer carries the TIER 2/3 write controls (plan, storage override, quota reset, session revoke, **suspend/unsuspend**) | `/admin/*` |
| `/admin/system` | the OPS page: push kill switch, **LINE allowance card**, **runtime flag toggles**, service health, queue depth + failed-job triage, notification delivery, **push log**, **queue throughput**, quota pressure, membership, support SLA queue, storage ledger + stuck files, **R2 reconciliation**. Queue/health blocks live-poll every 10 s and are range-independent; the historical blocks follow the 7/30/90 selector | `/admin/system/*`, `/admin/flags`, `/admin/line-quota`, `/admin/push-log` |
| `/join` | team invite acceptance | `/api/teams/invite/:token/accept` |
| `/auth/callback` | LINE Login code exchange | `/auth/line` |
| `/share/[token]` | public shared file view/download | `/share/:token*` |
| `/box/[slug]` | PUBLIC gift reveal (closed→opening→revealed, seeded stickers, voice player, noindex, generic themed OG image that carries NO box content) | `/legacy-box/open/:slug` |
| `/api/og` | Satori OG image; takes `?theme=`, **never `?slug=`**; `runtime='edge'` required (Windows path bug in the node build) | — |
| `/api/file-pdf/[fileId]` | same-origin PDF byte proxy for the mobile pdf.js viewer (nodejs runtime, PDF-only, forwards the session cookie) | `/files/:id` |

Boundaries: root `error.tsx` / `global-error.tsx` / `not-found.tsx` / `loading.tsx`,
plus `dashboard/error.tsx`, `dashboard/loading.tsx`, `admin/error.tsx`. Error
boundaries log only `error.digest`. Don't add per-route `loading.tsx` to the
client-rendered dashboard pages.

**File preview** (`components/FilePreviewModal.tsx`): images inline; text and
**desktop** PDFs in an `<iframe src={presignedUrl}>`; **mobile PDFs use pdf.js**
(`pdfjs-dist/legacy` — the modern bundle needs `Promise.withResolvers`, Safari 17.4+),
every page rendered to its own canvas with a DPR cap and sequential render queue,
worker served same-origin from `public/pdf.worker.min.mjs` (copied by
`scripts/copy-pdf-worker.mjs` on `predev`/`prebuild`). The modal JS-pins `<body>`;
do NOT add a CSS `body:has(.modal-overlay)` rule.

Landing rules: no emoji (inline SVG only), never generate mascot art
(`public/logo.png` IS the mascot), keep `/` public (the rich menu deep-links to
`/dashboard`), all outbound links live in `lib/site.ts`, and don't remove any of the
three `Reveal.tsx` safety-net layers.

---

## 11. LIFF Pages

Every LIFF page lives under `/liff/tasks/` — the LIFF app's endpoint URL is
`${WEB_URL}/liff/tasks` and `https://liff.line.me/{id}/…` deep links resolve
RELATIVE to it, so anything outside the subtree is unreachable from LINE without a
second LIFF app. `/liff/tasks/page.tsx` exists specifically because LINE's redirect
always lands on the endpoint first with `?liff.state=…`.

| Route | Shows | Calls |
|---|---|---|
| `/liff/tasks` | redirect shim resolving `liff.state` | — |
| `/liff/tasks/create` | type selector (งานเดียว / แยกรายการ / งานประจำ); hides auto-reminder copy while `TASK_NOTIFICATIONS_ENABLED` is false | — |
| `/liff/tasks/create/[type]` | step 1 of that type | — |
| `/liff/tasks/create/[type]/detail` | title/description/deadline/recurrence, file attach picker | — |
| `/liff/tasks/create/[type]/members` | assignee picker (skipped for `scope=personal`) | `GET /groups/:id/members`, `POST /groups/:id/register` |
| `/liff/tasks/[taskId]` | task view, optimistic done, accept, attachments, creator's รับงาน/ตีกลับ | `GET/POST /tasks/:id…` |
| `/liff/tasks/[taskId]/submit` | ส่งงานกลับ — uploads files FIRST, then flips status; `?item=` picks the item | `POST /tasks/:id/files`, `…/submit` |
| `/liff/tasks/team` | ห้องทีม: tabs งานทั้งหมด/ของฉัน × กำลังดำเนินการ/เสร็จแล้ว/ยกเลิก; identity from `?groupId=` (preferred) or `?spaceId=` | `GET /groups/:id/room` or `/spaces/:id/tasks` |

Session = LIFF id token exchanged at `POST /auth/liff` for the same HttpOnly cookie.
Draft state lives in sessionStorage (`lib/taskDraft.ts`, carries `scope`) because LIFF
navigations can hard-reload and a multi task can't fit in URL params. UI: brand-red
tokens + Prompt Thai font (`--font-liff`; LINE Seed isn't redistributable), no emoji
(SVG icons in `components.tsx`). CSP `connect-src` must keep `https://api.line.me`.
`LINE_LIFF_ID` / `NEXT_PUBLIC_LIFF_ID` are optional — unset falls back to plain
WEB_URL links and a LIFF-less dev mode (`?groupId=`).

---

## 12. Workers and Queues

Three BullMQ queues, all running in the SAME worker process (`workers/index.ts`,
separate Railway service, own `/health` on `WORKER_HEALTH_PORT` reporting Redis
status + commit SHA, `uncaughtException`/`unhandledRejection` → exit 1 for restart).
Keep them separate — merging re-couples the failure domains they were split to isolate.

| Queue | Worker | Jobs |
|---|---|---|
| `nookeb-file-processing` | `upload.worker.ts` | `upload_batch`, `generate_thumbnail`, `ocr_image`, `add_scan_page`, `finalize_scan`, `convert_to_docx`, `create_diary_entry`, `purge_deleted` (daily repeatable), `r2_reconcile` (**one-off, never repeatable** — admin-triggered singleton, jobId `r2_reconcile_singleton`, `attempts: 1`) |
| `nookeb-task-reminders` | `taskReminderWorker.ts` | `task_reminder`, `task_recur_next`, `task_recur_sweep`, `task_notify` (every immediate task push — announce / cancel / review loop). Worker `limiter: 10/sec` governs ALL task pushes. |
| `nookeb-sheets-sync` | `sheetsWorker.ts` (constructed ONLY when Google is configured) | `sheets_sync` (`upsert` \| `delete`), `sheets_historical` (backfill; jobId `sheets-historical-{userId}`, removed on settle so a later press can re-queue) |

Retry policy: `add_scan_page` / `finalize_scan` / `convert_to_docx` /
`create_diary_entry` get `attempts: 3` + exponential backoff (LINE CDN ~1 h TTL);
`generate_thumbnail` / `ocr_image` retry but are best-effort; `upload_batch` is
`attempts: 1` and retries each file internally (3×, 1→2→4 s) and never throws;
task jobs get 3 attempts × exponential 10 s; sheets jobs 3 attempts × 5-min backoff
with `jobId = sheets-{taskId}-{action}` collapsing edit bursts.

**Throughput history.** `workers/index.ts` attaches a `completed`/`failed`
listener to all four workers and writes one `job_log` row per settled job
(migration 060). Attached at the entry point, not inside each factory, so the
queues cannot drift on what is recorded and the existing per-worker listeners
(the upload worker's exhausted-retries admin alert) stay orthogonal. Every
failed ATTEMPT is logged, not just the exhausted one — a job that succeeds on
its third try is a different health signal from one that succeeds first time.

### `r2_reconcile` — the drift audit

`jobs/r2Reconcile.job.ts`. Two independent stores hold every file and nothing
keeps them in step transactionally (`uploadStream` puts the object, a separate
statement writes the row), so drift accumulates in both directions.

**It NEVER deletes an R2 object, and that is not timidity.** The orphan set is
computed by SUBTRACTING every key the database knows about from every key in the
bucket, so a query that silently returns too few rows does not produce a small
error — it produces a large, confident list of live user files. A report cannot
destroy anything when it is wrong. `purge_deleted` already deletes objects and
does so by walking ROWS, which is the safe direction. The one write is
`files.status = 'error'` for a row whose object is gone.

Two rules the orphan half rests on:

1. **The known-key universe is bigger than `files.r2_key`.** `KEY_SOURCES` unions
   every key-bearing column in the schema — `files.{r2_key,thumbnail_key}`,
   `scan_pages.r2_key`, `diary_entries.{image_key,thumbnail_key}`,
   `vault_files.r2_key`, `legacy_box_photos.r2_key`, `legacy_boxes.audio_key`.
   Subtracting only the first would report every thumbnail, diary photo, vault
   blob and gift-box voice clip as an orphan. **Adding a new R2-backed feature
   means adding its column here.**
2. **A DEGRADED run reports NO orphans at all.** Any key source that could not be
   read in full (missing table, page cap, error) sets `degraded`, and the orphan
   list is suppressed entirely — the `missing` correction still runs, because a
   failed vault read says nothing about whether a `files` row's object exists.

`missing` is scoped to `files` only (the sole table with an `error` status to
write) and EXCLUDES rows in `pending`/`processing`: those legitimately have a row
before they have an object — that is the normal upload sequence, not drift.

`purge_deleted` sweeps, in one job: files past the plan-aware retention
(`purgeDeletedFiles` → `purgeFileRows`), stale `processing` files, diary entry
objects, vault files (HARD delete + storage refund), legacy boxes older than 7 days
(photos **and** `audio_key`; no refund — soft delete already refunded), and orphan
scan-temp objects.

**Upload flow (normal files)**: webhook debounces per user (1500 ms sliding window,
`upload-queue.ts`) → ONE `upload_batch` job + ONE reply. **1-on-1 gets a progress
Flex card** whose button opens the live progress page; **group/room uploads are
stored completely silently** (the "บันทึกแล้วน้า ✓" confirmation and its per-group
toggle were retired). Worker: resolve user + space (group files → the group's shared
space via `ensureGroupSpace`) → quota check → stream LINE CDN → R2
`spaces/{space_id}/files/{file_id}/{name}` → `status='ready'` → best-effort
thumbnail + OCR enqueue.

### สแกน — the scan-enhance pipeline (`scan-enhance.service.ts`)

Runs inside `add_scan_page` for `session_kind='scan'` only, and only while
`SCAN_ENHANCE_ENABLED`. `processScanPage` NEVER throws: every stage degrades to
`plainNormalize(input)` (`edgeDetection:'skipped'`), and detection failure
degrades to full image bounds (`'fallback'`). Classic OpenCV throughout
(`@techstark/opencv-js` WASM) — **there is no ML model and no ONNX dependency**;
see the note at the end of this section before adding one.

| Stage | What |
|---|---|
| 0 | decode: EXIF-rotate → bound to 1600 px → RGBA `Mat`; brightness + Laplacian-variance quality gates (warn only, never reject) |
| 1 | corner detection, three passes, cheapest first: **canny** (Canny 75/200 + dilate) → **adaptive** (adaptive threshold, C<0) → **rect** (Otsu + `MORPH_CLOSE` + `minAreaRect`) |
| 2 | `getPerspectiveTransform` → `warpPerspective` |
| **2b** | **post-crop validation → capped re-crop** (see below) |
| **2c** | **auto-orientation** — sideways page → quarter turn |
| 3 | flat-field illumination divide + per-mode tone LUT + sharpen → JPEG |

Four rules the detection stage rests on, each of which was a real bug:

1. **Contours are found with `RETR_LIST`, never `RETR_EXTERNAL`.** External-only
   returns just the outermost contours, so anything the clutter *encloses* is
   invisible: a wood-grain table or a placemat whose edges close into one
   frame-spanning ring hides the page nested inside it. The area + aspect gates
   do the filtering that nesting used to do for free.
2. **`MAX_QUAD_AREA_RATIO` (0.985) exists and is checked against the SIMPLIFIED
   quad**, not the raw contour — the simplified polygon is what `warpToQuad`
   actually uses. Without it a frame-sized contour wins on area, warps ≈ identity
   and ships the whole desk inside the "scan". Rejecting a candidate does not end
   the search; the loop continues to the next-largest quad, which is the page.
3. **Detection during REFINEMENT uses the tighter `REFINE_MAX_AREA_RATIO`
   (0.97).** A crop's own outline is still an edge in the cropped image and, being
   the largest quad present, it wins and masks the page. A refinement is by
   definition looking for something smaller. Kept consistent with
   `REFINE_MIN_INSET_RATIO` — insetting one side 2.5 % costs ~2.5 % of the area.
4. **The paper level is a HIGH PERCENTILE of the interior (0.8), not a median.**
   Median assumes ink is a minority of the page, which is false for forms with
   filled blocks, pasted photos or solid table headers. When it flips, "paper" is
   measured as black and a correct crop is declared dirty.

**Stage 2b** treats the first crop as a candidate, not the answer:
`borderDirtyRatio` samples the crop's outer 6 % ring against the page's own
background (luma **and** chroma, so cream/coloured stock reads right), and while
that ring is >22 % non-paper, detection re-runs **on the crop** and re-warps.
Bounded three ways — `MAX_REFINE_PASSES` = 2, the "must actually tighten" gate
(`quadIsWorthRefining`: ≥2.5 % inset on some side AND ≥35 % of the frame kept, so
it can never collapse onto a text block), and detection simply finding nothing
better. A shadowed page is a known false positive: it usually spends one extra
pass and crops a few % tighter. Harmless, and visible in the log.

**Stage 2c** compares row-wise vs column-wise ink-profile variation; a *clearly
landscape* result whose text lines run vertically gets `sharp.rotate(270)`. A
genuinely landscape document is never touched. The 90° **direction** cannot be
recovered from pixels — that needs Tesseract OSD, and `osd.traineddata` is NOT
among the assets `scripts/download-tessdata.js` fetches. CCW is a pinned choice
in `ORIENT_ROTATE_DEGREES`, not a derived one. **180° is deliberately never
attempted** for the same reason.

**There is no "ขอบเอกสาร" / corner-not-detected message, and one must not be
re-added.** Detection failure is not a user error worth interrupting anyone for:
the page is stored either way, the fallback still gets Stage 3's
brightness/contrast correction, and — because `AddScanPageJob` carries no
`replyToken` — the notice always deferred through pending-notify and arrived
stapled to whatever the user said next, with no photo in sight. Too-dark and
too-blurry warnings DO still go out. `scan-enhance.service.test.ts` pins the
absence by substring, so a constant under a new name would still fail.
The only signal for a bad crop is the worker log line — grep
`[upload.worker] add_scan_page … edge= recrops= border=` and
`[scan-enhance] re-crop declined`.

**Before reaching for an ML detector** (DocAligner et al.): `apps/api/Dockerfile`
is `node:20-alpine` (musl) and `onnxruntime-node` ships no musl prebuilds, so it
needs a glibc base image plus re-validating sharp + opencv-wasm + tesseract on
it — and ~150–250 MB RSS in a worker that already holds three heavy runtimes.
That is an infra decision, not a dependency bump.

Regression fixtures: the SVG ones live in `scan-enhance.service.test.ts`; REAL
photographs go in `src/services/__fixtures__/scan/` (gitignored — they are
photos of real documents, the reported sample carries a name, address and bank
account number) and are picked up by `scan-enhance.real.test.ts`, which SKIPS
when the directory is empty. See that directory's README.

---

## 13. Feature Flags and Pro Gates

| Flag / gate | Controls | Checked where |
|---|---|---|
| `TASK_NOTIFICATIONS_ENABLED` (env, **default true**; only `"false"` disables) | EVERY task push: scheduled reminders (rows, jobs, delivery), the create announcement, the cancel notice, the review-loop notices, and the LIFF copy promising them. Set on BOTH Railway services. | `packages/shared/src/task-notifications.ts`; `taskScheduler.scheduleReminders` + `enqueueTaskNotify`, `taskReminderWorker` (`processTaskReminder`, `processTaskNotify`), `routes/tasks.ts` `notifyTaskChat`, LIFF create pages, `task-command-handlers` success copy |
| `system_settings.push_enabled` (DB row, migration 059, **default true**) | EVERY LINE push, gated at the last possible moment inside `pushMessage()` — so a flip takes effect on jobs already queued and in flight, unlike `TASK_NOTIFICATIONS_ENABLED` which gates SCHEDULING. The two COMPOSE; neither replaces the other. Flipped from the toggle at the top of `/admin/system`. Cached in Redis 60 s (`settings:push_enabled`), invalidated by DELETE on write, and **fails OPEN** on any error — an outage must never mute the product, only a human may. A blocked push returns normally, never throws: throwing would burn the reminder worker's 3 attempts and stamp `failed_at` on a row nothing was wrong with | `services/push-flag.service.ts`; `pushMessage` in `line.service.ts`; `GET|PUT /admin/settings[/push_enabled]` |
| `system_settings.diary_reminder_enabled` (DB row, 061, **seeded false**) | the §17 plan-based diary nudge. Was a hard-coded `export const DIARY_REMINDER_ENABLED = false`; that constant is **gone**. The resolved value reaches the sweep through `DiaryReminderDeps.enabled`, supplied by `membership.worker.ts` — `diaryReminder.job.ts` stays env-free (§3.14), and an OMITTED `enabled` means OFF, the one flag that fails closed because the failure mode is "LINE-message the whole opted-in userbase" and a push cannot be taken back. **Flipping the row is not enough on its own**: the sweep runs because a REPEATABLE EXISTS IN REDIS, so `setFlag` must also call `toggleDiaryReminderSchedule` (see below) | `services/feature-flags.service.ts`; `jobs/membership.queue.ts`; `jobs/diaryReminder.job.ts` |
| `system_settings.{diary_addon,scan_enhance,scan_ocr,virus_scan}_enabled` (DB rows, 061) | the add-on sweep, the สแกน enhancement pipeline, the searchable-text OCR layer, VirusTotal scanning. Read through `getFlag(key, fallback)`, cached 60 s under `flag:{key}`, **failing open to the CALLER'S fallback** — the safe direction differs per flag (a missing `scan_enhance_enabled` should read TRUE, a missing `diary_reminder_enabled` FALSE), so each site names its own, and it is the value its env var used to resolve to. Only the JSON literals `true`/`false` are honoured: `Boolean("false")` is true, so coercing is how a malformed write flips a switch the wrong way. `virus_scan_enabled` is still ANDed with `VIRUSTOTAL_API_KEY` — **a flag may only turn a CONFIGURED feature off, never turn an unconfigured one on**. The scan flags are read PER PAGE / PER PDF, not per boot: this is the switch someone reaches for while bad scans are actively shipping | `services/feature-flags.service.ts`; `workers/upload.worker.ts`, `routes/diaryAddon.ts`, `jobs/membership.*` |
| `toggleDiaryReminderSchedule(enabled)` (`jobs/membership.queue.ts`) | remove-then-add of the hourly `diary_reminder_sweep` repeatable, so Redis agrees with the row in the same request. Runs in the **API** process, which is fine — a repeatable is a Redis sorted-set entry, not worker state, and the API already holds the queue handle for `/admin/system/queues`. Without it, OFF→ON changes nothing at all until the next worker restart silently turns it on, and ON→OFF leaves the sweep firing hourly and standing itself down at the `deps.enabled` guard | `routes/admin-ops.ts` `PUT /admin/flags/:key` |
| `REMINDER_POLICY[plan].maxSelectable` (free 1 / pro 2 / premium 4) | how many of the **15** §4b lead times may be ticked (13 since 055, +5 นาที and ถึงกำหนดพอดี since 056). Every plan sees the same menu — a plan caps the COUNT, never which ones. Enforced in `resolveReminderConfig` (403 `REMINDER_INTERVAL_LIMIT`); the picker's own cap is a courtesy | `config/plans.ts`, `middleware/planGuard.ts`, `components/ReminderPicker.tsx` + `ReminderSheet.tsx` |
| `users.plan` ∈ {pro, team} | the `เตือน N ครั้ง` custom reminder count (migration 047) | `resolvePlanIsPro` in `task-command-handlers.ts`; effective count baked into the confirm card |
| `users.plan` | plan-aware trash retention (5 vs 30 days) | `purgeDeletedFiles` |
| `users.vault_plan` | vault access (`VAULT_PREMIUM_REQUIRED`). **`POST /vault/setup-pin` no longer self-grants `'premium'`** (2026-08-02) — it stamps `vault_plan` from the caller's real `users.plan` via `ensurePlan()`, and primes the 60 s Redis cache with the same value. Setting a 6-digit PIN was the entire paywall; it is now free and simply does not buy the tier. Consequence: existing free users who already hold `vault_plan='premium'` KEEP it (no backfill was run — decide that separately), but no NEW one is minted | `routes/vault.ts` |
| `MISTRAL_API_KEY` | แปลงไฟล์ — the command replies "not available" without it | `isMistralOcrConfigured()` |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `VAULT_MASTER_KEY` | Google Sheets sync (routes 503, worker not constructed, jobs no-op) | `isGoogleSheetsConfigured()` |
| `VAULT_MASTER_KEY` | vault routes + the encrypted Google refresh token | `config.ts`, `vault-crypto` |
| `SCAN_DEFAULT_MODE` | default colour mode for new scan sessions. Still env — a VALUE, not a switch. (`SCAN_ENHANCE_ENABLED`/`SCAN_OCR_ENABLED` are now the DB rows above; the env vars survive only as `getFlag` fallbacks. The worker's boot line prints the DB-resolved values and labels them a starting position, because they can change at runtime) | `config.ts`, `upload.worker.ts` |
| `ENABLE_VIRUS_SCAN` + `VIRUSTOTAL_API_KEY` | optional upload scanning — now ANDed with `system_settings.virus_scan_enabled` | `virusTotal.service` |
| `ADMIN_LINE_USER_IDS` | `/admin/*` access (no DB column) | `routes/admin.ts` |
| `LINE_LIFF_ID` / `NEXT_PUBLIC_LIFF_ID` | LIFF deep links vs plain WEB_URL fallback | `lineMessage.ts`, web `lib/liff.ts` |
| Pro **fake door** (no feature behind it) | gift-box `audio`/`video` only (anonymous, migration 034). The two TASK fake doors `task_auto_reminder` / `task_voice_command` (migration 040) were **removed 2026-08-02** — UI, routes and admin panel all gone, historical rows kept, `pro_interest` closed by migration 057. Neither ever had scheduling or a microphone behind it; do not confuse `task_auto_reminder` with the live reminder system (047/051/055/056) | `routes/pro-interest.ts` |

Other notable env (full schema in `apps/api/src/config.ts`):
`DEFAULT_STORAGE_LIMIT` (1 GB), `REFERRAL_BONUS_BYTES` (0.5 GB),
`PURGE_RETENTION_DAYS` (5), `TRASH_RETENTION_DAYS_PRO` (30),
`MAX_FILE_SIZE_BYTES` (1 GB), `RATE_LIMIT_FILES_PER_HOUR` (50) /
`RATE_LIMIT_BYTES_PER_HOUR` (5 GB), `DOCX_CONVERT_MAX_SOURCE_BYTES` (10 MB),
`PDF_MERGE_MAX_SOURCE_BYTES` (20 MB) × `PDF_MERGE_MAX_SOURCES` (20) — worst-case
worker memory is roughly their product, raise together and deliberately —
`DIARY_MAX_IMAGE_BYTES` (10 MB), `VAULT_MAX_FILE_SIZE_MB` (100),
`VAULT_PURGE_RETENTION_DAYS` (30), `STORAGE_WARN_THRESHOLD_LOW/HIGH` (80/95),
`DOWNLOAD_TOKEN_SECRET` (REQUIRED, ≥32 chars, no fallback),
`JWT_SECRET` (≥32), `CORS_EXTRA_ORIGINS`, `WORKER_HEALTH_PORT` (3002).

**Deployment note.** Env vars are **per Railway service** — the worker does NOT
inherit from the API. Keys that must be on BOTH or the feature half-works:
`VAULT_MASTER_KEY`, `GOOGLE_CLIENT_*`, `MISTRAL_API_KEY`, `DOWNLOAD_TOKEN_SECRET`.
Vercel needs `API_PROXY_TARGET` = the Railway origin (unset → `localhost:3001` →
every `/api-proxy/*` 404s and login breaks) and `NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID`.
Migrations that add columns/RPCs go BEFORE the API/worker deploy; deploy API before
web. `DEPLOYMENT.md` has the long form.

---

## Temporarily Disabled Endpoints

Two routes granted a **paid** entitlement without taking money. There is no
billing provider anywhere in this codebase, so any authenticated user could
self-upgrade for free by calling them directly — the rate limit (5/min) slowed
that down, it did not prevent it. Both now answer **`503`** unconditionally:

```json
{ "error": "SERVICE_UNAVAILABLE",
  "message": "Plan upgrades are temporarily unavailable.",
  "code": "BILLING_NOT_READY" }
```

| Endpoint | File | Granted | Re-enable when |
|---|---|---|---|
| `POST /plans/change` | `apps/api/src/routes/plans.ts` | any `users.plan` (pro/premium) + an `active` `subscriptions` row, via `changePlan()` | a verified payment webhook calls `changePlan()` — the route becomes the webhook's seam, not a self-service door |
| `POST /diary-addon/subscribe` | `apps/api/src/routes/diaryAddon.ts` | หนูเก็บความทรงจำ (49/365฿) — an `active` add-on row **plus** the diary push opt-in as a side effect | same: a verified payment webhook calls `createSubscription()` |

### `/support/*` — disabled for a different reason (no admin surface)

`apps/api/src/routes/support.ts` — **all four routes**, disabled 2026-08-02:
`GET /support/sla`, `POST /support/tickets`, `GET /support/tickets`,
`GET /support/tickets/:id`. They answer **`503`** unconditionally with a
different body from the billing pair above:

```json
{ "error": "NOT_IMPLEMENTED",
  "message": "Support system is not yet available.",
  "code": "SUPPORT_NOT_READY" }
```

This is not a billing hole — support is deliberately free on every plan. It is
disabled because the feature has **zero UI surface on either side**: no page
lets a user file a ticket, and **no admin panel exists to read one**
(`/admin/*` has no ticket view). `createTicket` stamps an SLA clock
(`support_tickets.sla_hours` + `due_at`, migration 051, 4 h on premium) that
would start ticking on rows nobody monitors — a promise the product cannot
keep, which is worse than having no ticket intake at all. The routes stay
REGISTERED and `services/support.service.ts` is untouched; only the handler
bodies are commented out. **Re-enable when the admin ticket UI is built**, not
when a user asks for the endpoint.

Rules for whoever picks this up:

- **The original handler bodies are commented out in place, not deleted.** They
  are the shape the webhook path needs; restore them under the payment check
  rather than rewriting from scratch.
- **`changePlan()` has exactly one caller** (`POST /plans/change`). There is no
  admin plan-mutation route — `PATCH /admin/users/:id` reads `users.plan` for the
  user list but never writes it. Re-grep before re-enabling; a second caller is a
  second hole.
- Neither route was wired to a user-facing button, so nothing in the web app
  breaks: `/dashboard/plans` renders its upgrade CTAs DISABLED, and
  `subscribeDiaryAddon()` in `apps/web/lib/api.ts` exists but has no caller
  (`DiaryAddonSection.tsx` deliberately does not call it). Do not wire a CTA to
  either before billing lands.
- The `POST /plans/change` disable does **not** roll back plans already granted
  through it. Auditing/reverting free self-upgrades already in `users.plan` and
  `subscriptions` is a separate decision.
- Same class of bug, already fixed rather than disabled: `POST /vault/setup-pin`
  used to self-grant `vault_plan='premium'` to anyone who set a PIN — see the
  `users.vault_plan` row in §13.

---

## 14. Current Feature Status

**Fully built and live**
- LINE webhook + upload batching + R2 storage + thumbnails + OCR + search
- Folders, tags, rename/move, previews, share links, trash bin (restore + purge)
- สแกน (enhance + OCR), รวมไฟล์ (images + PDFs → one PDF), แปลงไฟล์ (→ .docx)
- ไดอารี่ 365 วัน (chat capture + web grid/scrapbook)
- ห้องนิรภัย (vault), กล่องของขวัญ (legacy box incl. voice + public reveal)
- Teams, invites, join requests, LINE group ↔ team binding
- Referral ladder 1 / 2.5 / 4 GB
- Admin analytics dashboard (`usage_events` + aggregate RPCs)
- Admin ops dashboard `/admin/system` — TIER 1 (reads) + TIER 2 (audited writes)
  + TIER 3 (push log, LINE allowance, DB-backed runtime flags, R2 reconciliation,
  queue throughput history, account suspension)
- Public landing page + OG/robots/sitemap
- ระบบตามงาน: LIFF create, personal tasks, in-chat command with confirm-first,
  natural-language detection, attachments, review loop, ห้องทีม, .xlsx export,
  dashboard task views

**Built but dormant / conditional**
- **§17 plan-based diary reminder** — code complete, switched off at
  `DIARY_REMINDER_ENABLED = false` in `jobs/diaryReminder.job.ts`. Now an HOURLY
  sweep that honours each user's `notify_time` + `timezone` (it used to be a daily
  20:00 cron that ignored both); needs migration 054 before it is switched on.
  The paid หนูเก็บความทรงจำ add-on is separate and unaffected.
- **Google Sheets sync** — needs migration 046 applied + `GOOGLE_CLIENT_*` on both
  Railway services + the redirect URI registered in Google Cloud.
- **แปลงไฟล์** — needs `MISTRAL_API_KEY` on both services.
- **Vault** — needs migration 031 + `VAULT_MASTER_KEY`.
- **Pro reminder count** — needs migration 047 before a Pro user first sends
  `เตือน N ครั้ง`; free-tier inserts omit the column, so it is either-order safe.
- **Pro fake door** — the gift-box `audio`/`video` demand test only; nothing is
  behind it. The two task fake doors were removed on 2026-08-02 (migration 057).

**Deliberately deferred**
- Plans / billing / subscriptions (free tier only)
- Anything ERP-shaped. The review loop is a fixed two-party
  ส่งงาน → รับงาน/ตีกลับ handshake, **not** a configurable approval chain — don't
  grow it into one without a deliberate decision.
- Campaign / `hook_id` attribution in the referral panel (placeholder)
- Vault PIN change/reset flow (deliberate); vault PDF rasterisation (TODO in-file)

**Accepted risk** — Next.js pinned to the 14.2.x branch (`^14.2.4` → 14.2.35).
Request-smuggling / cache-poisoning advisories on the 14 branch are unresolved; npm
audit's only fix is Next 16. Compensating control: the `/api-proxy` rewrite is a
single fixed-target passthrough with no user-controlled destination. Migration plan
in `ROADMAP.md`; the pin note also lives in the `"//next"` key of
`apps/web/package.json`.

---

## 15b. Account Suspension (migration 060)

`users.suspended_at` + `suspended_reason`, enforced in `middleware/auth.ts`.
The verb TIER 2 was missing: quota resets, storage ceilings and session
revocation all leave the account WORKING, and a revoked user simply logs in
again a second later.

- **403 `ACCOUNT_SUSPENDED`, never 401**, and the distinction is load-bearing on
  the client: the web app treats 401 as "log in again", which for a suspended
  user is an infinite loop through LINE Login. Same shape as the vault's lock
  states (`VAULT_LOCKED` / `VAULT_PREMIUM_REQUIRED`) — a state that
  re-authenticating cannot fix. Checked AFTER the session-version check, so a
  forged token learns nothing about the account it claims.
- **The check rides the EXISTING `sv:{userId}` cache entry and query**, not a
  second Redis GET and a second SELECT on the hottest path in the API. Format is
  `"{version}:{0|1}"` and the parse is backward compatible with the bare
  `"{version}"` the key used to hold, so the deploy window degrades to "not
  suspended" — which is what every user was when those entries were written.
- **Suspending also bumps `session_version`.** The column check alone only stops
  the NEXT login; the bump kills the tokens already in the browser without
  waiting for the 60 s cache. Guarded on the version just read
  (`.eq('session_version', before)`), so two admins cannot both write `+1`.
  Unsuspend deliberately does NOT bump — those tokens are already gone.
- **409 on a double-suspend**, so a re-submit cannot overwrite the ORIGINAL
  `suspended_at` and reason. Amending means unsuspend + suspend, which leaves
  both events in `admin_audit_log`.
- **SCOPE: this stops the WEB and LIFF surfaces only.** The LINE webhook is
  signature-authenticated and never reaches the auth middleware, so a suspended
  user can still message the OA and still have files stored. Deliberate, stated
  in the migration and in the drawer's own copy — cutting the chat path would
  silently swallow uploads a user believes were saved, and needs its own design.

---

## 15. Known Issues (observed while reading — fix in a later session, not now)

1. **Orphaned group-notify feature.** `services/group-settings.service.ts` has zero
   references anywhere in `apps/api/src`, and migration 021's
   `group_notify_settings` table is now unused — the "บันทึกแล้วน้า ✓" reply and its
   toggle commands were retired (`line.ts:810`, `upload-queue.ts:270`). Dead code +
   dead table. `notifyGroupId` is still threaded through `EnqueueParams` and the
   batch entry but never read.
2. **Onboarding / feature carousel taps are placeholders.** Six of the eight
   onboarding bubbles and every feature-carousel bubble post back the literal
   `'หนูเก็บ'` with `// TODO: replace with real action` (`flex.service.ts:771-777`),
   so a tap just opens the menu. The doc comment above the array also still says
   "7-bubble" while `ONBOARDING_ACTIONS` has 8 entries.
3. **Hardcoded production URLs in the webhook.** `line.ts` lines 630-632, 646, 657,
   668 hardcode `https://nookeb-web.vercel.app/...` for the กล่องของขวัญ /
   ห้องนิรภัย / งานของฉัน quick replies instead of `config.WEB_URL` — wrong host in
   dev and after any custom-domain move. `flex.service.ts:778` does the same for the
   last onboarding bubble.
4. **`หนูเก็บรวมรูป` is a silent no-op** (`line.ts:904`). A user (or a stale pinned
   message) typing it gets no reply and no redirect — deliberate per the comment, but
   it reads as a broken bot. Worth at least a one-line "ใช้ หนูเก็บรวมไฟล์ แทนน้า".
5. **Bare command forms no longer work.** `สแกน`, `วิธีใช้`, `ไดอารี่` etc. now all
   require the `หนูเก็บ` prefix, but `classifyIntent` still has `prefixed`-independent
   branches (`เสร็จ`/`ยกเลิก`/`ติดต่อหนูเก็บ`) and older docs/marketing may advertise
   bare forms. Only `เสร็จ`, `ยกเลิก`, `ติดต่อหนูเก็บ` are prefix-free.
6. **`หนูเก็บห้องทีม` no longer exists.** `buildTeamRoomCard` is gone; the ห้องทีม
   entry point is now only the group welcome card on `join` and the task-command help
   card. Nothing surfaces ห้องทีม to a group that already onboarded — a
   discoverability gap.
7. **Unused exports** in `task-confirm.ts`: `isConfirmKey` (no non-test reference) and
   `getPendingConfirm` (tests only).
8. **`handleTaskConfirmPostback` returns `boolean`** but `line.ts:1254` ignores the
   return and unconditionally `return`s — harmless today, misleading contract.
9. **In-chat command creates `single` tasks only.** `createTaskFromConfirm` hardcodes
   `type: 'single'` with the item deadline NULL (inheriting `globalDeadline`). Verify
   the help card copy doesn't imply multi/recurring from chat. [UNCLEAR — verify card]
10. **`GET /tasks/:id/ics` is unauthenticated** — deliberate and documented, but any
    leaked task UUID exposes title + deadline. Listed so it stays a conscious choice.
11. **Migration drift risk.** The previous CLAUDE.md said `045`/`046` were "not
    applied yet." **[UNCLEAR — needs verification]** whether 045/046/047 are now
    applied in production; the repo cannot tell. 045 is the blocking one — every task
    read SELECTs `task_files`.
12. **`scan_sessions.session_kind = 'merge'`** is now legacy-only (nothing opens one),
    but `finalize_scan` and the reply-card chooser still branch on it. Fine as
    back-compat; flag it before anyone assumes 'merge' is reachable.
13. **`apps/web/.next/` build output is present in the working tree** and matched a
    repo-wide grep. Confirm it is git-ignored; never run `npm run build` for the web
    while its dev server is running (both write `.next/`, every page then 500s).
14. **Uncommitted working-tree changes at the time of writing** (`git status`):
    `apps/api/package.json`, `apps/api/src/routes/webhook/line.ts`,
    `apps/api/src/services/flex.service.ts`, `apps/web/app/liff/tasks/team/page.tsx`.
    This document describes the WORKING TREE, not the last commit.

---

## Running Locally

- `npm run dev` (root, turbo) — web + API + worker. The API workspace's `dev` runs
  `dev:api` and `dev:worker` via `concurrently`; turbo only runs each workspace's
  `dev`, so the worker MUST stay bundled into it.
- Production: `npm start` runs the API only; run `npm run start:worker` as a
  SEPARATE process/container.
- Tests: `cd apps/api && npm test` (node:test via `tsx --test`; needs
  `--env-file=../../.env` for the security integration test, whose live-infra cases
  are skip-guarded).
- Rich menu: `cd apps/api && npx tsx --env-file=../../.env scripts/setup-rich-menu-single.ts`
  — destructive by design (deletes every existing menu + legacy aliases first).
  It is the ONLY rich-menu script left in the repo.
- Redis must be the Upstash `rediss://` TLS URL; plain `redis://` fails.
- LINE needs a public HTTPS webhook at `<public>/webhook/line`, "Use webhook" ON,
  auto-reply/greeting OFF.

## Rich Menu — `RichMenu_Nookeb` (single menu, 2500×1686, `New_1.jpg` at repo root)

| # | Zone | x, y, w, h | Action |
|---|---|---|---|
| 1 | ล็อคเกอร์ | 0, 0, 1250, 843 | `uri` → `WEB_URL/dashboard` |
| 2 | สร้างงาน | 1250, 0, 1250, 843 | `uri` → `WEB_URL/dashboard/tasks` |
| 3 | ฟีเจอร์เอกสาร | 0, 843, 800, 843 | `message` `หนูเก็บฟีเจอร์เอกสาร` |
| 4 | บันทึกไดอารี่ | 800, 843, 720, 843 | `message` `หนูเก็บไดอารี่` |
| 5 | รวมคำสั่ง | 1520, 843, 430, 407 | `message` `หนูเก็บเพิ่มเติม` |
| 6 | เว็บไซต์หนูเก็บ | 1950, 843, 550, 407 | `uri` → `WEB_URL/` |
| 7 | ช่วยเหลือ | 1520, 1250, 980, 436 | `message` `ติดต่อหนูเก็บ` |

Every `message` text must map to a real handler in `webhook/line.ts` — keep in sync.
Do not add/remove/rearrange zones without approval.
