# Architecture Summary — หนูเก็บ (nookeb) — Run 2

> Phase 1 output of the Cloudflare `security-audit` skill. Synthesized from three parallel
> reconnaissance agents (1a overview/stack/baseline, 1b trust boundaries/authz, 1c input surface).
> Target: `D:\หนูเก็บ (Nookeb)` — branch `main`, HEAD `1ee62ae`, **working tree DIRTY**.
> This document describes the WORKING TREE, not the last commit.

---

## 0. Prior runs — what run 1 found, and what changed since

`./security-reports/` contains a complete run 1 (2026-07-31). Its `findings.json` held three items:

| # | Sev | Title | Status in the tree now |
|---|---|---|---|
| 1 | HIGH | `POST /tasks` accepted a LINE **user** id (`U…`) as `groupId` → OA push into a victim's 1-on-1 chat | **Fixed in working tree** — see below |
| 2 | MEDIUM | No revocation path for LINE-group task access (no `memberLeft` handler, rows never removed) | **Fixed in working tree** — see below |
| 3 | INFO | `GET /groups/:groupId/members` discloses co-members' raw `lineUid` | Unchanged (was inert once #1 fixed) |

Run 1 also declared a methodology caveat: agent delegation was declined mid-run, so its Phases 2,
3 and 6 were performed by a single reasoner with no independent adversarial pass. **Run 2 runs all
six phases with real delegated agents**, and therefore also re-tests run 1's conclusions.

**Uncommitted fixes now present** (`git status`: 6 modified, 2 new):

- **`apps/api/src/services/line-id.ts`** (new) — exports `LINE_CHAT_ID_RE = /^[CR][0-9a-f]{32}$/`
  and a shared error message. `line-id.test.ts` (new) covers accept-group/room, reject `U…` user id,
  empty, wrong length, uppercase hex, non-hex, wrong-case prefix, MINI-App pseudo-UUID, and
  whitespace/newline padding.
- Guard **applied** at: `routes/groups.ts:32` (all three `:groupId` routes), `routes/tasks.ts:70`
  (`createTaskSchema.groupId`), `routes/team.router.ts:210-215` (`POST /:teamId/groups`).
- Guard **deliberately not applied** at: `DELETE /api/teams/:teamId/groups/:groupId`
  (`team.router.ts:236-244`, comment at 206-209 — must still unbind legacy rows; only ever DELETEs
  a matching row after `requireRole`), and `GET /spaces/:id/tasks?groupId=` (`routes/spaces.ts:171`
  — the param is only ever compared for equality against the space's own trusted `line_group_id`,
  and `ensureGroupMember` is then called with the DB value, never the query param).
- **`memberLeft` handling added** — `webhook/line.ts:1248` calls `autoRemoveGroupMember` per
  departing member (`line.ts:1168-1205`); `task.service.ts` gained a matching removal path.

Phase 2 must **independently verify these fixes are complete**, and then spend most of its effort
on ground run 1 explicitly under-covered: `upload.worker.ts` job handlers and BullMQ payload trust,
the scan/OCR/PDF-merge/docx pipelines, admin analytics RPC bodies (migrations 026/042), the Google
OAuth flow end-to-end, legacy-box create/reorder, the client-side/browser surface, and export
generation (xlsx/ics/docx).

---

## 1. What this application is

A Thai-language **LINE-integrated file archive + task chaser SaaS**. Three deployed surfaces plus
managed data stores:

| Surface | Runtime | Host |
|---|---|---|
| `apps/api` (`@nookeb/api`) | Fastify 4.29.1 on Node | Railway (`railway.toml`, `/health`) |
| worker (same package, separate process) | BullMQ consumers, own `/health` on `WORKER_HEALTH_PORT` | Railway (`railway.worker.toml`) |
| `apps/web` (`@nookeb/web`) | Next.js 14.2.35 App Router, client-heavy | Vercel (`apps/web/vercel.json`) |
| Postgres | Supabase, 48 **manually applied** migrations `001`–`048` | Supabase cloud |
| Redis | BullMQ + rate limits + ephemeral state, `rediss://` enforced in prod | managed (Upstash) |
| Object storage | Cloudflare R2 via S3 SDK | Cloudflare |

Features: chat-driven file archive; scan-to-PDF / PDF merge / image→docx (Mistral OCR); 365-day
diary; PIN-protected AES-256-GCM vault; public "legacy box" gift pages; a large task manager
(LIFF + in-chat NL commands + review loop + Sheets mirror + xlsx/ics export); teams/invites;
referral storage ladder; admin analytics; public landing page.

**Monorepo**: npm workspaces + Turborepo 2.x, TypeScript 5.5. Tests are `node:test` via `tsx --test`
(no jest/vitest). `packages/shared` is consumed as built `dist`.

## 2. Actors and designed capability

| Actor | Identity proof | Designed capability |
|---|---|---|
| Anonymous internet | none | landing page, `GET /share/:token[/download]`, `GET /legacy-box/open/:slug`, `GET /tasks/:id/ics`, `GET /files/:id/download?dl_token=`, `GET /progress/:batchId[/view]`, `POST /auth/*`, `POST /api/pro-interest`, `GET /static/*`, `GET /health` |
| LINE platform | HMAC-SHA256 over raw body | `POST /webhook/line` (rate-limit exempt) |
| Authenticated user | HS256 JWT in HttpOnly `nookeb_session` cookie (or Bearer) + `session_version` match | own files/diary/vault/boxes/tasks; space actions gated by membership |
| LINE group member | possession of a shape-valid group id ⇒ row in `group_members` | group tasks, roster, team room |
| Team owner/admin | `team_members.role` via `requireRole` | invite/approve/remove, bind/unbind LINE groups |
| Admin | authenticated + `line_user_id ∈ ADMIN_LINE_USER_IDS` (env, no DB column) | all `/admin/*` + `PATCH /admin/users/:id` |
| Worker | service-role Supabase key + LINE channel token | full DB (RLS-bypassing) + LINE push. Not HTTP-reachable; its trust boundary is **BullMQ payload construction** |

## 3. Trust model and enforcement

- **Supabase SERVICE-ROLE key everywhere** (`plugins/supabase.ts`, all three workers). RLS is
  **bypassed by design**; migrations `036` and `038_rls_backstop.sql` enable RLS with **zero
  policies** (deny-all) purely as a backstop against a leaked anon/publishable key.
  → **Application code is the only live multi-tenant boundary. There is exactly one DB privilege
  level.** A route that forgets a check has no DB-level safety net.
- Auth middleware `apps/api/src/middleware/auth.ts`: `verifyAppToken` pins `algorithms:['HS256']`,
  requires `sub` + `lineUserId`; `authenticate` prefers cookie, falls back to Bearer, compares
  `sv` claim to a 60 s Redis-cached (`sv:{userId}`) DB `session_version`. Never reads a token from
  the query string. 24 h expiry.
- LINE webhook signature `middleware/line-verify.ts:9-18`: length-guard then `timingSafeEqual`
  over the **raw buffer**, before `JSON.parse` (`webhook/line.ts:1591` → `:1597`).
- **Authorization helpers (the complete set) and their call sites:**
  - `isSpaceMember` — `services/file.service.ts:338` → `files.ts:130,222,288`;
    `folders.ts:17,45,87`; `tags.ts:19,46,71`; `share.ts:90`
  - `getMemberRole` — `services/space.service.ts:140` → `spaces.ts:96,177`
  - `isGroupMember` (read-only) — `services/task.service.ts:98` → `tasks.ts:541`, `spaces.ts:176`,
    and internally at `task.service.ts:134`
  - `ensureGroupMember` (enrolling) — `services/task.service.ts:129` → `groups.ts:48,76,97`,
    `tasks.ts:258`, `spaces.ts:173`
  - `getTeamRole` / `requireRole` — `services/team.service.ts:138,154` → invite, listJoinRequests,
    approve/reject, removeMember, deleteTeam, bind/unbindLineGroup
  - `isLineUserTeamMember` — `space.service.ts:101`, only from `joinSenderToGroupSpace:89`
  - `isAdminLineUser` — `config.ts:244` → `routes/admin.ts:10` (router-wide preHandler), `:42`,
    `auth.ts:309`
  - Vault: `requireVaultPremium` (`vault.ts:136`), `requireVaultSession` (`:155`), bundled as
    `guarded` (`:166`); `verifyPinOrReply` (`:172`) re-verifies the PIN for unlock and delete
  - **Task ownership is checked inline, not via a helper**: `task.created_by_line_uid === lineUid`
    at `tasks.ts:564,843,886,923,975,1098,1134`; read access via `canView()` at `tasks.ts:201`;
    assignee scoping via `markAssigneeDone`/`setDoneNote` boolean returns
- Capability-URL pattern, deliberately unauthenticated, each separately rate-limited:
  `GET /tasks/:id/ics` (30/min), `GET /share/:token[/download]` (30/min),
  `GET /legacy-box/open/:slug` (30/min), `GET /files/:id/download?dl_token=` (60 s TTL, single-use
  via Redis `GETDEL` on SHA-256 of the token, separate `DOWNLOAD_TOKEN_SECRET`),
  `GET /progress/:batchId` (**also exempt from the global limiter**), `POST /api/pro-interest`.
- **`ensureGroupMember` is the designed "soft" boundary**: possession of a shape-valid group id is
  proof of membership, with no cryptographic binding to the group (`task.service.ts:113-147`,
  documented as the share-link trust model). The new `LINE_CHAT_ID_RE` is what keeps a LINE *user*
  id out of that capability space.
- No `NODE_ENV`-gated auth bypass, no `SKIP_AUTH`, no debug header. Production branches in
  `config.ts:208-231` only tighten (reject `localhost`, require `rediss://`).
- `trustProxy: true` (`index.ts:42-59`) — hard invariant, regressed twice (`771fd9f` fixed,
  `a39adec` re-broke). Accepted tradeoff: a client reaching the Railway origin directly can spoof
  `X-Forwarded-For` and defeat every per-IP control.
- Vault: Argon2id (64 MB/3/1), **per-user** (not per-IP) lockout with exponential escalation,
  unlock session bound to `session_version`, no PIN reset by design.

## 4. Input surfaces (condensed; full inventory in agent 1c output)

**Global**: 100/min per-IP limiter (`index.ts:130-145`) exempting `/health`, `/webhook/line`,
`/progress/*`. CORS is an explicit origin allowlist (`config.WEB_URL` + `CORS_EXTRA_ORIGINS`),
replacing an earlier `*-nookeb.vercel.app` regex that allowed origin-squatting.

**Routes with no zod validation on the path param** (rely on Supabase typed-column comparison):
`GET /files/:id`, `GET /spaces/:id`, `/spaces/:id/members`, `trash.ts` `:id` params,
`GET /progress/:batchId`, `GET /share/:token`.

**Notable schemas**: `createTaskSchema` (`tasks.ts:70`, now with `LINE_CHAT_ID_RE`),
`listQuerySchema` (`files.ts`), `pinSchema` `/^\d{6}$/`, task link `z.string().url().max(2000)` +
`isHttpUrl()` rejecting `javascript:`/`data:` (`tasks.ts:159-166`), `HEX_COLOR` on tag colour,
events `eventName` whitelisted against `CLIENT_TRACKABLE_EVENTS` + `sanitizePayload` to scalars.

**Multipart scopes (three, never shared)**: `vault.ts` (1 file, MIME allowlist, `Content-Length`
required so chunked is rejected), `legacy-box.ts` (≤10 photos + 1 voice, MIME + magic-byte sniff,
`sharp` re-encode strips EXIF), `task-files.ts` (5 files × 20 MB, `sanitizeR2Name()` before the R2
key; `originalName` kept raw for display/`Content-Disposition`).

**LINE CDN media**: `getMessageContent` → hardcoded `https://api-data.line.me/v2/bot/message/{id}/content`.
Size caps applied pre-stream (declared size) and mid-stream (`SizeLimitExceededError` hard abort).
Magic-byte sniffing rather than declared Content-Type in `detectConvertMime` (`upload.worker.ts:1189`),
`detectDiaryImage` (`:1438`), `sniffVoiceContainer`.

**Queues** (`FILE_QUEUE = 'nookeb-file-processing'`, `nookeb-task-reminders`, `nookeb-sheets-sync`):
`upload_batch`, `generate_thumbnail`, `ocr_image`, `add_scan_page`, `finalize_scan`,
`convert_to_docx`, `create_diary_entry`, `purge_deleted`; `task_reminder`, `task_recur_next`,
`task_recur_sweep`; `sheets_sync`. **No externally reachable enqueue endpoint** — payloads are
built by trusted server code, but string fields carry raw user text: `items[].originalName`,
`ConvertToDocxJob.originalName` (→ `docxOutputName()`), `CreateDiaryEntryJob.caption`
(`.slice(0,500)` at `line.ts:1385`).

**`JSON.parse` of externally-influenced data**: `webhook/line.ts:1597` (raw body, **after** HMAC,
try/catch → 400); `pending-notify.service.ts:69`; `diary-mode.service.ts:29`; `task-confirm.ts:84`;
`referral.service.ts:109` — the last four read Redis values the app itself wrote.

**Redis key construction**: every identifier segment comes from a verified channel (HMAC webhook
id, JWT `userId`) or a server UUID/nonce — **except `progress:{batchId}`**, where the raw
unauthenticated URL param is used verbatim as the key (mitigated only by UUID unguessability).

**UGC → later render/serve/process**: file `original_name`/`display_name` (→ search, →
`ResponseContentDisposition`), task `title`/`description`/notes (→ Flex cards, `.ics`, `.xlsx`,
Google Sheets, LIFF), diary `caption`, legacy-box `title`/`message`/`tagline` (→ public JSON),
tags, folder names, OCR text (→ `buildSearchOr` `ilike`), task links, vault `original_filename`
(→ `Content-Disposition`, `encodeURIComponent`'d).

**Outbound fetch**: all base URLs hardcoded (LINE `api.line.me` / `api-data.line.me`, Mistral
`api.mistral.ai/v1/ocr`, VirusTotal `virustotal.com/api/v3` with `encodeURIComponent` on the
VT-returned analysis id, Google via the `googleapis` SDK, R2 presigned). Path segments interpolated
into LINE URLs are LINE-issued opaque ids.

**Next.js handlers**: `GET /api/og` (edge, `?theme=` allowlisted via `isThemeId()`, renders no user
content), `GET /api/file-pdf/[fileId]` (node, `fileId` matched `/^[a-zA-Z0-9-]+$/`, forwards the
session cookie, only proxies when `mimeType === 'application/pdf'`). `next.config.mjs`: one static
redirect, one rewrite `/api-proxy/:path*` → `API_PROXY_TARGET` (fixed server env, **not**
user-controlled), CSP + security headers on all routes; CSP allows `'unsafe-inline'` for scripts.

## 5. Dangerous sinks to attack (do NOT accept these as safe without reading them)

1. `buildSearchOr()` `routes/files.ts:89-95` — hand-built PostgREST `.or()` filter string; strips
   `(),`, escapes `\ % _`; used at `files.ts:146,260`.
2. `.rpc()` calls throughout admin/analytics/legacy-box/share/team/file/referral — **the RPC
   bodies live in migrations 026/042 and were never read in run 1.**
3. R2 key builders in `r2.service.ts:19-38` (`sanitizeR2Name` strips `/ \` + control chars, caps 200).
4. 302 redirects: `files.ts:360` (presigned R2), `integrations.ts:92,98,108,121,123` (Google callback
   → `${WEB_URL}/dashboard/settings?...`).
5. **Spreadsheet cell writes** — `export.service.ts` ExcelJS `addRow` with raw UGC strings;
   **no leading-`'` guard for values starting with `= + - @` was observed**. Google Sheets uses
   `valueInputOption:'RAW'`, which does mitigate on that path.
6. `.ics` generation `tasks.ts:1151-1211` — UGC title/description into calendar fields on an
   **unauthenticated** endpoint.
7. DOCX generation `docx-builder.service.ts` from Mistral-OCR markdown — **not read in run 1**.
8. `progress.ts` `VIEW_HTML` — `batchId` stripped to `[a-zA-Z0-9-]` before `<script>` substitution.
9. **No** `eval` / `Function` / `child_process` / `vm` / dynamic `import()` anywhere (grep-confirmed).
10. `dangerouslySetInnerHTML` — only `apps/web/app/page.tsx:328,336`, static JSON-LD.

## 6. Baseline comparable

Closest comparables: **Dropbox / Google Drive-style consumer file archive** (storage half);
**Telegram/WhatsApp/LINE-bot archival services** (chat-intake half); **Trello / Asana-lite** (task
half); time-capsule/gift apps (legacy box).

Tradeoffs the comparables routinely accept — therefore **not findings on their own here**:
presigned object-storage URLs with a TTL instead of proxying; unguessable-token public share links
with no per-recipient auth; a server-side service credential with tenant isolation in application
code; trusting the messaging platform as the identity layer with HMAC as the check; CDN/platform
rate limiting alongside application limits.

What a comparable would **not** accept, and so is fair game: a capability token that is guessable
or unscoped; a tenant check missing on one of several paths to the same resource; quota/ledger
accounting drivable negative; user content reaching another user's render or export path
unescaped; a role gate enforced on one route but not its sibling.

Where this app diverges from all comparables: a messaging platform's **chat identifier used as a
bearer capability**, with no "is this caller still in the channel" call to the platform. Slack and
Discord bots do ask. Both of run 1's findings fell out of that one decision.

## 7. Dependency posture (accepted risk, documented)

`npm audit --omit=dev`: **20 vulnerabilities (1 moderate, 19 high, 0 critical)**, all requiring
breaking major upgrades. Four clusters, per `SECURITY-UPGRADE-PLAN.md` / `UPGRADE-ROADMAP.md`:
Fastify 4→5 chain (`fast-uri`, `find-my-way` GHSA-c96f-x56v-gq3h HTTP/2 DoS, `fast-json-stringify`);
**Next 14.2.35 → 16** (`next` rewrite-SSRF GHSA-p9j2-gv94-2wf4, request-smuggling
GHSA-ggv3-7p47-pfv8, Server-Function disclosure GHSA-955p-x3mx-jcvp, plus cache-poisoning/DoS/XSS;
`postcss` 8.4.31); `googleapis`→`gaxios`→`rimraf`→`glob`→`minimatch`→`brace-expansion` ReDoS;
`exceljs`→`archiver`→`uuid` (moderate). No `overrides` block exists. `ROADMAP.md` sets the Next
migration as the single planned item; the documented compensating control is that the
`/api-proxy` rewrite is a fixed-target passthrough with no user-controlled destination.

## 8. Key file paths (Phase 2 starting points)

```
apps/api/src/index.ts                      bootstrap, CORS, headers, limiter, error sanitiser
apps/api/src/config.ts                     zod env schema, isAdminLineUser
apps/api/src/middleware/auth.ts            JWT + session_version
apps/api/src/middleware/line-verify.ts     webhook HMAC
apps/api/src/services/line-id.ts           NEW — the chat-id shape guard
apps/api/src/routes/webhook/line.ts        ~1600-line dispatcher
apps/api/src/routes/webhook/task-handlers.ts, task-command-handlers.ts
apps/api/src/routes/{files,share,trash,tasks,task-files,vault,legacy-box,diary,spaces,
                     groups,team.router,admin,integrations,referral,events,progress,
                     analytics,folders,tags,pro-interest,static}.ts
apps/api/src/services/{file,space,task,team,team-room,r2,line,vault,vault-crypto,
                       vault-session,legacy-box,diary,referral,export,pdf-merge,docx-*,
                       scan*,mistral-ocr,virusTotal,google-sheets,upload-queue,
                       progress-store,pending-notify,events,taskScheduler,task-command,
                       task-nl,task-confirm,ocr}.ts
apps/api/src/workers/{index,upload.worker,taskReminderWorker,sheetsWorker}.ts
apps/api/src/__tests__/security.integration.test.ts
apps/web/next.config.mjs                   CSP, headers, /api-proxy rewrite
apps/web/app/api/{og/route.tsx,file-pdf/[fileId]/route.ts}
apps/web/app/{box/[slug],share/[token],join,auth/callback,dashboard,liff/tasks,admin}/**
apps/web/lib/{api,liff,auth,share,taskDraft,taskFiles,track}.ts
packages/shared/src/**
supabase/migrations/001..048
```

## 9. Notes that shape hunting priority

- Migrations are **manually applied**; the repo cannot prove which are live. A finding must not
  depend on an unapplied migration.
- `TASK_NOTIFICATIONS_ENABLED = false` (`packages/shared/src/task-notifications.ts`) — scheduled
  reminders are dormant. Do not report bugs in dead paths as live findings; do note them if the
  flag flipping would introduce one.
- The codebase has already been through **≥4 explicit security passes** (`02e0a56`, `8c6eeb6`,
  `1696468`, `67c6d9b`, plus `8467741`). Re-flagging a closed issue is a false positive — verify
  the current code, not the pattern.
- Run 1's under-covered areas are run 2's priority: workers/BullMQ, scan/OCR/PDF/docx, admin RPC
  bodies, Google OAuth, legacy-box, client-side, export generation.
