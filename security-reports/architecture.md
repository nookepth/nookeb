# Architecture Summary — หนูเก็บ (nookeb)

> Phase 1 output of the Cloudflare security-audit skill. Synthesized from three parallel
> reconnaissance agents (overview/stack, trust boundaries, input surface).
> Target: `D:\หนูเก็บ (Nookeb)` — audited at git `1ee62ae` (branch `main`, clean tree).
> **No prior audit runs exist** in `./security-reports/` — this is run 1.

---

## 1. What this application is

A Thai-language **LINE-integrated file archive + task chaser SaaS**. Three deployed
surfaces plus a database:

| Surface | Runtime | Host |
|---|---|---|
| `apps/api` (`@nookeb/api`) | Fastify 4.28 on Node | Railway (`railway.toml`) |
| worker (same package, separate process) | BullMQ consumers, own `/health` | Railway (`railway.worker.toml`, manually wired) |
| `apps/web` (`@nookeb/web`) | Next.js 14.2.x App Router (client-heavy) | Vercel (`apps/web/vercel.json`) |
| Postgres | Supabase, 48 manual migrations `001`–`048` | Supabase cloud |
| Redis | BullMQ + rate limits + ephemeral state | managed `rediss://` (enforced in prod) |
| Object storage | Cloudflare R2 via S3 SDK | Cloudflare |

Feature set: chat-driven file archive, scan-to-PDF / PDF merge / image→docx (Mistral
OCR), 365-day diary, PIN-protected encrypted vault, public "legacy box" gift pages,
a large task manager (LIFF + in-chat NL commands + review loop + Sheets mirror),
teams/invites, referral storage ladder, admin analytics, public landing page.

## 2. Users and actors

| Actor | Identity proof | Designed capability |
|---|---|---|
| Anonymous internet | none | landing page, `GET /share/:token[/download]`, `GET /legacy-box/open/:slug`, `GET /tasks/:id/ics`, `GET /files/:id/download?dl_token=`, `POST /auth/*`, `POST /api/pro-interest`, `GET /static/*`, `GET /health` |
| LINE platform | HMAC-SHA256 over raw body | `POST /webhook/line` (rate-limit exempt) |
| Authenticated user | HS256 JWT in HttpOnly `nookeb_session` cookie (or Bearer), + `session_version` match | own files/diary/vault/boxes/tasks; space actions gated by membership |
| LINE group member | row in `group_members` for that `group_line_id` | group tasks; the group id is treated as an unguessable capability |
| Team owner/admin | `team_members.role` | invite/approve/remove members, bind LINE groups |
| Team owner | role `owner` | delete team |
| Admin | authenticated + `line_user_id ∈ ADMIN_LINE_USER_IDS` (env, no DB column) | all of `/admin/*` incl. `PATCH /admin/users/:id` |
| Worker | service-role Supabase key + LINE channel token | full DB (RLS-bypassing), LINE push. Not HTTP-reachable; its trust boundary is **BullMQ job payload construction** |

## 3. Trust model and enforcement

- **Supabase SERVICE-ROLE key everywhere** (`plugins/supabase.ts:8`, all three workers).
  RLS is **bypassed by design**; migration `038_rls_backstop.sql` enables RLS with
  **zero policies** (deny-all) purely as a backstop against a leaked anon key.
  → **Application code is the only live multi-tenant boundary.**
- Auth middleware: `apps/api/src/middleware/auth.ts`
  - `verifyAppToken` pins `algorithms: ['HS256']`, requires `sub` + `lineUserId` (37–52).
  - `authenticate` prefers cookie, falls back to Bearer, then compares `sessionVersion`
    to a 60 s Redis-cached DB value (78–112). Never reads a token from the query string.
- LINE webhook signature: `middleware/line-verify.ts:9-18` — length-guard then
  `timingSafeEqual` over the **raw buffer**, before JSON parsing (`webhook/line.ts:1550`).
- Authorization helpers (the complete set):
  - `isSpaceMember` — `services/file.service.ts:338-350` → files.ts:130,222,288;
    folders.ts:17,45,87; share.ts:90; tags.ts:19,46,71
  - `getMemberRole` — `services/space.service.ts:140-153` → spaces.ts:96,177;
    upload.worker.ts:581
  - `isGroupMember` / `ensureGroupMember` — `services/task.service.ts:69-82` / `100-117`
    → tasks.ts:254 (create, enrolling), tasks.ts:537 (GET, deliberately read-only)
  - `requireRole` — `services/team.service.ts:154-165` → invite/approve/reject/remove/
    delete/bind/unbind
  - `isAdminLineUser` — `config.ts:238-246` → `routes/admin.ts:6-13` router-wide hook
  - Task ownership is checked **inline**, not via a helper: `created_by_line_uid !== lineUid`
    at tasks.ts:560, 644, 839, 882, 919, 971, 1094, 1130; assignee scoping via
    `markAssigneeDone` / `setDoneNote` boolean returns and `item.assignees.some(...)`.
- Deliberately unauthenticated by design (capability-URL pattern, each rate-limited):
  `GET /tasks/:id/ics` (30/min), `GET /share/:token[/download]` (30/min),
  `GET /legacy-box/open/:slug` (30/min), `GET /files/:id/download?dl_token=` (60 s TTL,
  single-use via Redis `GETDEL` on SHA-256 of the token, separate `DOWNLOAD_TOKEN_SECRET`),
  `POST /auth/logout`, `POST /api/pro-interest`.
- No `NODE_ENV`-gated auth bypass, no `SKIP_AUTH`, no debug header found.
- `trustProxy: true` (index.ts ~43-59) — deliberate; `1` previously mass-banned users.
- Vault: Argon2id (64 MB/3/1), per-user lockout, **no PIN reset by design**.

## 4. Input surfaces (condensed inventory)

**API routes** — global 100/min/IP limiter (`index.ts:130-145`) exempting `/health`,
`/webhook/line`, `/progress/*`.

- auth: `POST /auth/line` (10/min + ban 5), `POST /auth/liff`, `POST /auth/logout`, `GET /auth/me`
- files: `GET /files`, `/files/stats`, `/files/:id`, `POST /files/:id/download-token`,
  `GET /files/:id/download`, `PATCH /files/:id`, `POST|DELETE /files/:id/tags[/:tagId]`, `DELETE /files/:id`
- trash: `GET /trash`, `POST /trash/:id/restore`, `DELETE /trash/:id/permanent`, `POST /trash/empty`
- share: `POST|GET /files/:fileId/shares`, `DELETE .../:shareId`, public `GET /share/:token[/download]`
- folders / tags: full CRUD, authenticated
- spaces: `GET /spaces`, `/spaces/:id/members`, `/spaces/:id/tasks?groupId=`
- groups: `GET /groups/:groupId/members`, `POST /groups/:groupId/register`, `GET /groups/:groupId/room`
- teams (`/api/teams`): create/list/get/delete, invite, accept, join-requests, remove member, bind/unbind group
- tasks: `POST /tasks` (10/min), `GET /tasks/mine`, `GET /tasks/export` (10/min), `GET /tasks/:id`,
  `PATCH /tasks/:id`, item PATCH/done/accept/submit/approve/reject/note, `DELETE /tasks/:id`,
  `PUT .../assignees`, links add/remove, `GET /tasks/:id/ics` (public)
- task-files (own multipart scope): `POST /tasks/:taskId/files` (5×20 MB, 20/min), `GET`, `DELETE`
- diary, vault (own multipart scope, PIN-session `guarded`), legacy-box (own multipart scope)
- integrations: Google OAuth start/callback/status/disconnect
- progress: `GET /progress/:batchId[/view]` — **rate-limit exempt**
- admin: 12 read RPCs + `PATCH /admin/users/:id`
- analytics/events: `GET /me/usage`, `POST /api/events/track`, `POST|GET /pro-interest`
- static: `GET /static/welcome.jpg`, `/static/onboarding/:n.jpg`
- webhook: `POST /webhook/line`

**Next.js handlers** — `GET /api/og` (edge, `?theme=` allowlisted via `isThemeId()`),
`GET /api/file-pdf/[fileId]` (node, `fileId` matched `/^[a-zA-Z0-9-]+$/`, forwards session
cookie). `next.config.mjs`: one static redirect, one rewrite `/api-proxy/:path*` →
`API_PROXY_TARGET` (fixed server env, not user-controlled), CSP/security headers on all routes.

**Queues** (`plugins/bullmq.ts`, `services/taskScheduler.ts`, `services/sheetsQueue.ts`):
- `nookeb-file-processing` → `upload_batch`, `generate_thumbnail`, `ocr_image`, `add_scan_page`,
  `finalize_scan`, `convert_to_docx`, `create_diary_entry`, `purge_deleted`
- `nookeb-task-reminders` → `task_reminder`, `task_recur_next`, `task_recur_sweep`
- `nookeb-sheets-sync` → `sheets_sync`

**User-generated content**: file `display_name`/`original_name`, tags, folder names, task
titles/descriptions/notes/submission+rejection notes, task links (http(s), max 20), diary
captions, legacy-box title/message/tagline/theme/photos/voice, share tokens, OCR text.

**External integrations**: LINE Messaging/Login/LIFF, Google OAuth+Sheets (refresh token
AES-GCM encrypted with `VAULT_MASTER_KEY`), Mistral OCR, VirusTotal (optional), R2, Supabase.

**Dangerous sinks observed by recon** (to be attacked in Phase 2, not accepted as safe):
- PostgREST filter string building: `buildSearchOr()` `files.ts:89-95` (escapes `%`, `_`, `\`,
  strips `(),`), used at files.ts:146,152,154,156,260; also `referral.service.ts:195`
- `.rpc()` calls throughout admin/analytics/legacy-box/share/team/file/scan/referral services
- R2 key construction `r2.service.ts` `buildFileKey`/`buildScanPageKey`/`buildThumbnailKey`,
  filename via `sanitizeR2Name()` (r2.service.ts:32-39, added after a raw-filename incident)
- `dangerouslySetInnerHTML` — only `apps/web/app/page.tsx:328,336`, static JSON-LD
- **No** `child_process`/`exec`/`spawn`/`eval`/`new Function` anywhere in api or web
- Outbound fetch hosts are hardcoded (LINE, Mistral, VirusTotal, Google, R2 presigned)
- 302 redirect only to server-generated presigned R2 URLs (`files.ts:360`)

## 5. Baseline comparable

Closest comparables: **Dropbox / Google Drive-style consumer file archive** for the storage
half; **Telegram/WhatsApp-bot file-archival services** for the chat-intake half; **Trello /
Asana-lite** for the task half; time-capsule apps (gift box). Tradeoffs those comparables
routinely accept, and which are therefore *not* findings on their own here:

- Presigned object-storage URLs with a TTL instead of proxying binaries (leak-window risk accepted).
- Unguessable-token public share links with no per-recipient auth.
- A server-side service credential to the database with tenant isolation enforced in app code.
- Trusting the messaging platform (LINE) as the identity/transport layer, with HMAC as the check.
- CDN/platform-level rate limiting in addition to application-level limits.

What a comparable would **not** accept, and so is fair game: a share/capability token that is
guessable or not scoped; a tenant check missing on one of several paths to the same resource;
quota/ledger accounting that can be driven negative; user content reaching another user's
render or export path unescaped.

## 6. Key file paths (Phase 2 starting points)

```
apps/api/src/index.ts                      bootstrap, CORS, headers, limiter, error sanitiser
apps/api/src/config.ts                     zod env schema, isAdminLineUser
apps/api/src/middleware/auth.ts            JWT + session_version
apps/api/src/middleware/line-verify.ts     webhook HMAC
apps/api/src/routes/webhook/line.ts        1500+ line dispatcher
apps/api/src/routes/webhook/task-*.ts      postback + in-chat command handlers
apps/api/src/routes/{files,share,trash,tasks,task-files,vault,legacy-box,
                     diary,spaces,groups,team.router,admin,integrations,
                     referral,events,progress,analytics,folders,tags}.ts
apps/api/src/services/{file,space,task,team,team-room,r2,line,vault,vault-crypto,
                       vault-session,legacy-box,diary,referral,export,pdf-merge,
                       docx-*,scan*,mistral-ocr,virusTotal,google-sheets,
                       upload-queue,progress-store,pending-notify,events,
                       taskScheduler,task-command,task-nl,task-confirm}.service.ts
apps/api/src/workers/{index,upload.worker,taskReminderWorker,sheetsWorker}.ts
apps/web/next.config.mjs                   CSP, headers, /api-proxy rewrite
apps/web/app/api/{og/route.tsx,file-pdf/[fileId]/route.ts}
apps/web/app/{box/[slug],share/[token],join,auth/callback}/**
apps/web/app/{dashboard,liff/tasks,admin}/**
apps/web/lib/{api,liff,auth,share,taskDraft,taskFiles,track}.ts
packages/shared/src/**
supabase/migrations/001..048
```

## 7. Notes that shape hunting priority

- Migrations are **manually applied**; the repo cannot prove which are live in production.
  Findings must not depend on an unapplied migration.
- `TASK_NOTIFICATIONS_ENABLED = false` in `packages/shared/src/task-notifications.ts` —
  scheduled reminders are dormant; do not report bugs in dead code paths as live findings.
- The recon pass flagged four areas it did **not** finish: `apps/web/app/box/**` XSS handling,
  exact BullMQ payload shapes in `packages/shared/src/types/jobs.ts`, `JSON.parse` of job and
  postback data, and vault crypto/session correctness. Phase 2 must cover all four.
- Root of repo contains `.env` (verify it is git-ignored), `SECURITY-UPGRADE-PLAN.md`,
  `UPGRADE-ROADMAP.md` — read them; a prior audit (2026-07-19) produced migration 038.
- Next.js pinned `^14.2.4`; the repo documents this as accepted risk.
