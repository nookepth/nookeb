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
`task-confirm`, `google-sheets`, `sheetsQueue`, `ocr`,
`group-settings` (**orphaned — see §15**).

---

## 5. Database — Migration Map

None are auto-applied. Read each file's header for apply-order; the ones that must
land **before** the API deploy are flagged in-file.

| File | Adds |
|---|---|
| `001_initial.sql` | users, spaces, space_members, folders, files, tags, file_tags, scan_sessions, scan_pages (+ indexes, RLS on files) |
| `002_google_accounts.sql` | per-user Google refresh token for Drive export — **superseded, dropped by 017** |
| `003_reliability.sql` | atomic `increment_storage_used` RPC, `files.purged_at` + partial index, storage_limit default |
| `004_security_features.sql` | per-file virus-scan status + per-space storage-alert dedupe |
| `005_teams.sql` | first-class teams (replaces implicit `spaces(type='team')`), `files.team_id`, `increment_team_storage` |
| `006_cleanup_stale_team_spaces.sql` | one-time cleanup of legacy team-space rows |
| `007_spaces_team_id.sql` | direct `spaces → teams` link |
| `008_team_join_requests.sql` | owner/admin approval flow for invite-link joins |
| `009_session_version.sql` | `users.session_version` — bumping revokes outstanding JWTs |
| `010_referrals.sql` | referral codes, `referrals`, `referral_tiers`, `redeem_referral` RPC |
| `012_reset_quota.sql` | one-time quota clean slate for the referral launch |
| `013_fix_tiers.sql` | corrected tier thresholds (superseded by 030) |
| `014_personal_quota_enforcement.sql` | atomic `increment_personal_storage(enforce)` |
| `015_add_charged_to_column.sql` | `files.charged_to` ledger column (correct refunds) |
| `016_unique_space_constraints.sql` | one space per LINE group / one personal space per user |
| `017_drop_google_accounts.sql` | drops 002's table (Drive removed) |
| `018_scan_page_seq.sql` | `scan_pages.page_seq BIGSERIAL` + `result_file_id` idempotency marker |
| `019_scan_mode.sql` | `scan_sessions.scan_mode` ('bw' \| 'color') |
| `020_session_kind.sql` | `scan_sessions.session_kind` ('scan' \| 'merge') |
| `021_group_notify_settings.sql` | per-group upload-confirmation toggle — **feature retired; table + service now unused** |
| `022_fix_upload_idempotency.sql` | unique index backstop on upload `line_message_id` |
| `023_scan_expected_pages.sql` | `scan_sessions.expected_pages` + RPC — finalize wait-gate |
| `024_fix_referral_quota.sql` | stop referral redemption clobbering admin-raised quotas (GREATEST guard) |
| `025_perf_indexes.sql` | `files.uploaded_by` etc. partial indexes (CONCURRENTLY) |
| `026_aggregate_rpcs.sql` | count/aggregate RPCs so admin/analytics don't page 1000-row selects |
| `027_file_shares.sql` | public share links for dashboard files (token) |
| `028_diary.sql` | `diary_entries` + `diary_notification_settings`, one live entry per user+Bangkok day |
| `029_usage_events.sql` | append-only `usage_events` + `admin_*` aggregate RPCs |
| `030_referral_tiers_fractional.sql` | current ladder 0→1, 3→2.5, 5→4 GB (NUMERIC column + RPC local) |
| `031_vault.sql` | `users.vault_pin_hash` / `vault_plan` + `vault_files` |
| `032_trash.sql` | `files.trash_origin_folder_id` (restore target snapshot) |
| `033_legacy_boxes.sql` | `legacy_boxes` + `legacy_box_photos` + `increment_box_views` RPC |
| `034_legacy_box_occasion_tagline.sql` | `occasion` + `tagline` (nullable) + anonymous `pro_interest_log` |
| `035_legacy_box_audio.sql` | `legacy_boxes.audio_key` (CHECK pins the `legacy-box/` prefix) |
| `036_tasks.sql` | `tasks`, `task_items`, `task_assignees`, `task_reminders`, `group_members` (RLS, no policies) |
| `037_task_edit.sql` | per-assignee `done_note`, task-level `task_links`, edit/cancel support columns |
| `038_rls_backstop.sql` | enables RLS (deny-all) on every remaining table |
| `039_increment_share_views.sql` | atomic `increment_share_views` RPC |
| `040_pro_interest_authed.sql` | `pro_interest` — authenticated, deduped task Pro fake-door |
| `041_usage_events_client_dims.sql` | `usage_events.session_id` / `plan_tier` / `entry_channel` (nullable) |
| `042_admin_analytics_rpcs.sql` | 12 read-only STABLE admin RPCs (Bangkok day buckets) |
| `043_personal_tasks.sql` | `tasks.is_personal` + `owner_line_uid`, `group_line_id` nullable, `tasks_scope_exclusive` CHECK |
| `044_pdf_merge_session_kind.sql` | widens `session_kind` CHECK to add `'pdf'` |
| `045_task_files.sql` | `task_files` junction + item statuses `submitted`/`rejected` + `submitted_at`/`rejected_at`/`rejection_note`/`submission_note`. **Not additive-safe: `getTaskWithDetails()` SELECTs `task_files` and backs every task read — apply BEFORE deploying.** |
| `046_google_sheets_integration.sql` | `google_integrations` (one row/user, AES-GCM `encrypted_token`, RLS deny-all) |
| `047_task_command_reminders.sql` | `tasks.reminder_count` INT NULL CHECK 1..4 — the Pro "เตือน N ครั้ง" knob |

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
All three review transitions fire ONE best-effort inline push (personal tasks skip
it). `resetRecurringRound` clears review fields so a new round starts clean.

### Reminders (currently OFF)

`TASK_NOTIFICATIONS_ENABLED = false` in `packages/shared/src/task-notifications.ts`.
While false: `scheduleReminders` creates no `task_reminders` rows and no delayed
jobs, `processTaskReminder` stands any in-flight job down, and the LIFF hides copy
promising reminders. Recurring **rollover still schedules** so rounds keep advancing.

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
- **Google Sheets mirror** — ONE ROW PER TASK, keyed by a hidden `รหัสงาน` column in
  the sheet itself (the user can re-sort rows, so a cached row index would be wrong).
  Always queued, never inline. See §12/§13.
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
`/dashboard/settings?google=…`) · `DELETE /integrations/google`

**Analytics / admin** — `GET /me/usage` 🔒 · `POST /api/events/track` 🔒 ·
`POST /api/pro-interest` (**unauthenticated**, anonymous gift-box demand test,
10/min per IP) · `POST|GET /pro-interest` 🔒 (task demand test, deduped per user) ·
`GET /admin/{users,spaces,overview,timeseries,features,power-users,pro-interest,tasks,funnel,adoption,storage,referral}`
and `PATCH /admin/users/:id` — all gated by `ADMIN_LINE_USER_IDS`

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
| `/admin` | one scrollable analytics page, hand-rolled SVG/CSS charts, shared 7/30/90-day range | `/admin/*` |
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
| `/liff/tasks/create/[type]/detail` | title/description/deadline/recurrence, file attach picker, Pro fake-door section | `POST /pro-interest` |
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
| `nookeb-file-processing` | `upload.worker.ts` | `upload_batch`, `generate_thumbnail`, `ocr_image`, `add_scan_page`, `finalize_scan`, `convert_to_docx`, `create_diary_entry`, `purge_deleted` (daily repeatable) |
| `nookeb-task-reminders` | `taskReminderWorker.ts` | `task_reminder`, `task_recur_next`, `task_recur_sweep` |
| `nookeb-sheets-sync` | `sheetsWorker.ts` (constructed ONLY when Google is configured) | `sheets_sync` (`upsert` \| `delete`) |

Retry policy: `add_scan_page` / `finalize_scan` / `convert_to_docx` /
`create_diary_entry` get `attempts: 3` + exponential backoff (LINE CDN ~1 h TTL);
`generate_thumbnail` / `ocr_image` retry but are best-effort; `upload_batch` is
`attempts: 1` and retries each file internally (3×, 1→2→4 s) and never throws;
task jobs get 3 attempts × exponential 10 s; sheets jobs 3 attempts × 5-min backoff
with `jobId = sheets-{taskId}-{action}` collapsing edit bursts.

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

---

## 13. Feature Flags and Pro Gates

| Flag / gate | Controls | Checked where |
|---|---|---|
| `TASK_NOTIFICATIONS_ENABLED` (constant, **false**) | all scheduled task reminders (rows, jobs, delivery, and the LIFF copy promising them) | `packages/shared/src/task-notifications.ts`; `taskScheduler.scheduleReminders`, `taskReminderWorker`, LIFF create pages, `task-command-handlers` success copy |
| `users.plan` ∈ {pro, team} | the `เตือน N ครั้ง` custom reminder count (migration 047) | `resolvePlanIsPro` in `task-command-handlers.ts`; effective count baked into the confirm card |
| `users.plan` | plan-aware trash retention (5 vs 30 days) | `purgeDeletedFiles` |
| `users.vault_plan` | vault access (`VAULT_PREMIUM_REQUIRED`); setup-pin self-grants `'premium'` until billing exists | `routes/vault.ts` |
| `MISTRAL_API_KEY` | แปลงไฟล์ — the command replies "not available" without it | `isMistralOcrConfigured()` |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `VAULT_MASTER_KEY` | Google Sheets sync (routes 503, worker not constructed, jobs no-op) | `isGoogleSheetsConfigured()` |
| `VAULT_MASTER_KEY` | vault routes + the encrypted Google refresh token | `config.ts`, `vault-crypto` |
| `SCAN_ENHANCE_ENABLED` / `SCAN_OCR_ENABLED` / `SCAN_DEFAULT_MODE` | scan pipeline behaviour (printed once at worker boot so the deployed state is auditable) | `config.ts`, `upload.worker.ts` |
| `ENABLE_VIRUS_SCAN` + `VIRUSTOTAL_API_KEY` | optional upload scanning | `virusTotal.service` |
| `ADMIN_LINE_USER_IDS` | `/admin/*` access (no DB column) | `routes/admin.ts` |
| `LINE_LIFF_ID` / `NEXT_PUBLIC_LIFF_ID` | LIFF deep links vs plain WEB_URL fallback | `lineMessage.ts`, web `lib/liff.ts` |
| Pro **fake doors** (no feature behind them) | `task_auto_reminder` / `task_voice_command` (authenticated, deduped, migration 040) and gift-box `audio`/`video` (anonymous, migration 034) | `routes/pro-interest.ts`, `ProFeatureSection.tsx` |

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
- Public landing page + OG/robots/sitemap
- ระบบตามงาน: LIFF create, personal tasks, in-chat command with confirm-first,
  natural-language detection, attachments, review loop, ห้องทีม, .xlsx export,
  dashboard task views

**Built but dormant / conditional**
- **Scheduled task reminders** — code complete, switched off at
  `TASK_NOTIFICATIONS_ENABLED = false`. Personal and command-created tasks therefore
  ship with no working reminders today.
- **Google Sheets sync** — needs migration 046 applied + `GOOGLE_CLIENT_*` on both
  Railway services + the redirect URI registered in Google Cloud.
- **แปลงไฟล์** — needs `MISTRAL_API_KEY` on both services.
- **Vault** — needs migration 031 + `VAULT_MASTER_KEY`.
- **Pro reminder count** — needs migration 047 before a Pro user first sends
  `เตือน N ครั้ง`; free-tier inserts omit the column, so it is either-order safe.
- **Pro fake doors** — demand tests only; nothing is behind them.

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
