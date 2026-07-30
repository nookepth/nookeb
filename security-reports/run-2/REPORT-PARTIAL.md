# Security Report (PARTIAL) — หนูเก็บ (nookeb) — Run 2

**Target:** `D:\หนูเก็บ (Nookeb)` · branch `main` @ `1ee62ae` · **working tree dirty**
**Date:** 2026-07-31 · **Run:** 2 (prior run 1 in `../`)
**Method:** Cloudflare `security-audit` skill

> ## ⚠️ THIS AUDIT IS INCOMPLETE — READ THIS FIRST
>
> Run 2 completed **Phase 1 (reconnaissance) only**. Phases 2–6 did not run:
>
> | Phase | Status |
> |---|---|
> | 1 — Reconnaissance | ✅ Complete (3 parallel `research` agents) |
> | 2 — Hunt | ❌ **Not performed.** All 6 hunter agents were rejected before execution. **Zero code was hunted.** |
> | 3 — Adversarial validation | ❌ Not run (nothing to validate) |
> | 4 — Report | ⚠️ This partial document |
> | 5 — `findings.json` | ❌ Not written (requires validated findings) |
> | 6 — Independent verification | ❌ Not run |
>
> **Consequence:** everything in §2 below is an **unvalidated reconnaissance lead**, not a
> finding. None of it has a proven exploit, a verified trace, or an adversarial disprove pass.
> The skill's core rule is "only report what you can exploit" — these leads do not meet that
> bar and their severity labels are *provisional triage priorities*, not audit severities.
> Do not treat this document as an audit result. Re-run Phases 2–6 to get one.

---

## 1. Validated findings (carried from run 1)

These three were hunted, validated and reported in run 1 (`../findings.json`). Run 2's Phase 1
re-read the relevant code to determine current status.

| # | Severity | Title | Status in working tree |
|---|---|---|---|
| 1 | **HIGH** | `POST /tasks` accepts a LINE **user** ID as `groupId` → Official Account pushes attacker-authored Flex cards into a chosen victim's private 1-on-1 chat | **Appears FIXED** (recon-level check only) |
| 2 | **MEDIUM** | LINE-group task access has no revocation path — a removed member keeps full read/write access indefinitely | **Appears FIXED** (recon-level check only) |
| 3 | INFORMATIONAL | `GET /groups/:groupId/members` discloses co-members' raw LINE user IDs | Unchanged — inert once #1 is fixed |

### 1.1 Finding 1 — group-ID confusion (HIGH) — appears fixed

**Affected files (fix):**
- `apps/api/src/services/line-id.ts` *(new, untracked)* — `LINE_CHAT_ID_RE = /^[CR][0-9a-f]{32}$/`
- `apps/api/src/services/line-id.test.ts` *(new, untracked)* — 10 cases incl. `U…` rejection,
  uppercase hex, wrong-case prefix, whitespace padding, MINI-App pseudo-UUID
- `apps/api/src/routes/tasks.ts:70` — `createTaskSchema.groupId`
- `apps/api/src/routes/groups.ts:32` — `groupIdSchema`, all three `:groupId` routes
- `apps/api/src/routes/team.router.ts:210-215` — `POST /:teamId/groups`

Recon confirmed the guard is applied at every client-facing route that writes a group ID to
`tasks.group_line_id`, `group_members.group_line_id` or `team_line_groups.line_group_id`, or that
uses one as an `ensureGroupMember` enrolment capability.

Two entry points deliberately have **no** regex, both assessed as safe by recon but **not
adversarially validated**:
- `DELETE /api/teams/:teamId/groups/:groupId` (`team.router.ts:236-244`) — must stay able to
  unbind legacy rows; only DELETEs a matching row after `requireRole`.
- `GET /spaces/:id/tasks?groupId=` (`spaces.ts:171`) — the param is only compared for equality
  against the space's own trusted `line_group_id`; `ensureGroupMember` is then called with the DB
  value, never the query param.

**Remaining recommendation from run 1, NOT yet done:** add the DB-level CHECK so no future code
path can reintroduce it:

```sql
ALTER TABLE tasks ADD CONSTRAINT tasks_group_line_id_shape
  CHECK (group_line_id IS NULL OR group_line_id ~ '^[CR][0-9a-f]{32}$');
ALTER TABLE group_members ADD CONSTRAINT group_members_group_line_id_shape
  CHECK (group_line_id ~ '^[CR][0-9a-f]{32}$');
```

Also still open: `notifyTarget()` in `apps/api/src/services/task.service.ts` was recommended to
refuse a non-chat-ID destination as defence in depth. Verify whether that landed.

### 1.2 Finding 2 — no revocation path (MEDIUM) — appears fixed

**Affected files (fix):**
- `apps/api/src/routes/webhook/line.ts:1248` — new `memberLeft` branch
- `apps/api/src/routes/webhook/line.ts:1168-1205` — `autoRemoveGroupMember`
- `apps/api/src/services/task.service.ts` — matching removal path

**Not verified, and this is the important gap:** recon did *not* establish whether
`ensureGroupMember` now **denies** a removed member, or whether re-presenting the retained group ID
simply **re-enrols** them. Run 1's original analysis was that re-presentation re-enrols, which
would make a removal handler cosmetic. `ensureGroupMember` (`task.service.ts:129`) still treats
possession of a shape-valid group ID as proof of membership with no call to LINE to confirm current
membership. **Confirm this before considering finding 2 closed.**

### 1.3 Finding 3 — roster discloses raw LINE user IDs (INFORMATIONAL)

**Affected files:** `apps/api/src/routes/groups.ts:38-53`,
`packages/shared/src/types/task.ts:321-327` (`toGroupMemberDto` emits `lineUid` verbatim).

No standalone exploit. Was the targeting primitive for finding 1; inert now. Consider an opaque
per-group member handle if the roster surface grows.

---

## 2. Run 2 reconnaissance leads — UNVALIDATED, NOT FINDINGS

Surfaced by Phase 1 mapping. **None has been traced to a proven exploit.** Severity labels are
triage priorities for the hunt that did not happen.

### 2.1 Spreadsheet formula injection in `.xlsx` export — *lead, triage: MEDIUM*

**Affected:** `apps/api/src/services/export.service.ts`; reached via
`GET /tasks/export?format=xlsx` (`apps/api/src/routes/tasks.ts`).

ExcelJS `addRow` is called with raw user-generated strings (task titles, descriptions, submission
and rejection notes, assignee display names). Recon observed **no leading-`'` guard** for values
beginning `=` `+` `-` `@` `\t` `\r`. The parallel Google Sheets path is *not* affected — it uses
`valueInputOption: 'RAW'`, which does not parse formulas.

**Why it is only a lead:** the cross-principal question was never answered. A task creator exports
a workbook containing text written by their assignees (and vice versa), so a boundary plausibly
exists — but nobody verified how ExcelJS types those cells, whether Excel/LibreOffice would
evaluate them on open, or who actually opens the file. All three are required before this is a
finding.

**Recommendation:** prefix any cell value matching `/^[=+\-@\t\r]/` with `'`, or write those cells
with an explicit string type. Cheap, safe, worth doing regardless of the verdict.

### 2.2 Unauthenticated `.ics` endpoint carrying user content — *lead, triage: LOW/MEDIUM*

**Affected:** `apps/api/src/routes/tasks.ts:1151-1211` (`GET /tasks/:id/ics`, `ical-generator`).

Unauthenticated by design — the task UUID is the capability, rate-limited 30/min per IP. Two
separate concerns, neither validated:
1. **Injection:** UGC title/description flow into calendar `summary`/`description`. Whether
   `ical-generator` escapes CR/LF (which would otherwise let an attacker forge iCalendar
   properties) was never checked against the library source.
2. **Over-disclosure:** run 1 noted the route comment describes it as exposing title + deadline,
   but it also emits every item title and every item description (`tasks.ts:1182,1196`).

**Recommendation:** verify `ical-generator`'s escaping; either trim the payload to what the comment
claims or update the comment.

### 2.3 `/progress/*` unauthenticated and rate-limit exempt — *lead, triage: LOW*

**Affected:** `apps/api/src/routes/progress.ts`; exemption at `apps/api/src/index.ts:144`.

`GET /progress/:batchId` has no auth, no zod validation on the param, and is exempt from the global
100/min limiter. The raw URL param is used verbatim as the Redis key `progress:{batchId}` — the
only Redis key in the app whose segment is not derived from a verified channel or a server-generated
UUID. Mitigated by batch-ID unguessability; payload is two counters. The real concern is an
unmetered path to a Redis round-trip on infrastructure shared with the rate limiter and BullMQ.

`GET /progress/:batchId/view` embeds the ID into HTML but strips it to `[a-zA-Z0-9-]` first
(`progress.ts:118-119`), which closes the XSS angle.

**Recommendation:** keep the auth exemption, but bring `/progress/*` under a dedicated per-IP limit.

### 2.4 Dependency posture — 20 known vulnerabilities — *documented accepted risk*

**Affected:** root `package-lock.json`; `SECURITY-UPGRADE-PLAN.md`, `UPGRADE-ROADMAP.md`,
`ROADMAP.md`.

`npm audit --omit=dev`: **20 vulnerabilities (1 moderate, 19 high, 0 critical)**, none fixable
without a breaking major upgrade. Four clusters:

| Cluster | Resolved version | Notable advisories |
|---|---|---|
| **Next.js** | 14.2.35 | GHSA-p9j2-gv94-2wf4 (rewrite SSRF), GHSA-ggv3-7p47-pfv8 (request smuggling), GHSA-955p-x3mx-jcvp (Server Function disclosure), + cache-poisoning/DoS/XSS; `postcss` 8.4.31. Fix = Next 16 |
| **Fastify 4 chain** | 4.29.1 | `find-my-way` GHSA-c96f-x56v-gq3h (HTTP/2 DoS), `fast-uri`, `fast-json-stringify`. Fix = Fastify 5 |
| **googleapis** | 173.0.0 | `gaxios`→`rimraf`→`glob`→`minimatch`→`brace-expansion` ReDoS |
| **exceljs** | 4.4.0 | `archiver`→`uuid` GHSA-w5hq-g745-h8pq (moderate) |

Documented compensating control for the Next cluster: `/api-proxy/:path*` is a fixed-target
rewrite with no user-controlled destination. **This is a documented, deliberate accepted risk with
a written migration plan — it is not a new finding.** Do not run `npm audit fix --force`; the plan
warns it silently downgrades `exceljs` to 3.4.0.

**Recommendation:** execute the Next 14→16 migration in `ROADMAP.md`. It is the single highest-value
dependency action and the advisories cluster exactly on the `/api-proxy` rewrite the plan already
identifies as the risk surface.

### 2.5 `trustProxy: true` — *requires deployment testing, unverifiable from source*

**Affected:** `apps/api/src/index.ts:42-59`.

With unbounded proxy trust, `X-Forwarded-For` is attacker-controlled for any client that can reach
the Railway origin **directly**, which would defeat every per-IP control: `/auth/line` (10/min +
ban-after-5), the share and legacy-box 30/min caps, the anonymous pro-interest limit — and would
allow banning another user's IP.

This is a **hard invariant** in the codebase (regressed twice: `771fd9f` fixed it, `a39adec`
re-broke it). Setting it to `1` collapses every Vercel-proxied user onto one IP and the `/auth/line`
limiter bans the entire userbase. The tradeoff is documented in-file.

**Exploitability depends entirely on whether the Railway origin is reachable without passing
through Vercel — a deployment fact not in this repository.** Per the skill's source-visibility gate
this cannot be reported as a confirmed finding.

**Recommendation:** test the live Railway origin directly. If reachable, do **not** change
`trustProxy` — instead re-key the `/auth/line` limiter on LINE login channel or user identity
rather than IP, as the in-file comment itself recommends.

### 2.6 Structural note — application code is the only tenant boundary

**Affected:** `apps/api/src/plugins/supabase.ts`; `supabase/migrations/036_tasks.sql:93-97`,
`038_rls_backstop.sql`.

The API and all three workers use the Supabase **service-role key**, which bypasses RLS. Migrations
036/038 enable RLS with **zero policies** (deny-all) purely as a backstop against a leaked
anon/publishable key. There is exactly **one DB privilege level**. Any route that forgets an
authorization check is a full tenant bypass with no database-level safety net.

This is a deliberate, documented architecture and matches how comparable Supabase-backed products
are commonly built — **not a finding**. It is recorded because it sets the blast radius for every
access-control bug: there is no second line of defence. It is also precisely why Phase 2's access
control hunt mattered most, and that hunt did not run.

### 2.7 Carried-over hardening notes from run 1 (still open)

| Item | File |
|---|---|
| `buildSearchOr` escapes `%` `_` `\` but not `*`, which PostgREST maps to `%` — `?search=*` still yields a full wildcard scan (no tenant impact; `space_id` is AND-ed) | `apps/api/src/routes/files.ts:89-95` |
| `POST /auth/logout` clears the cookie but does not bump `users.session_version`, so a JWT captured before logout stays valid up to 24 h | `apps/api/src/routes/auth.ts:280` |
| Share links are creator-revocable only — any space member can mint a link for another member's file, but `DELETE` filters on `created_by` | `apps/api/src/routes/share.ts:95,150` |
| `PATCH /tasks/:id/items/:itemId/note` has no status gate, unlike its done/submit/approve/reject siblings — an assignee can edit their note after closure | `apps/api/src/routes/tasks.ts:1046` |
| CSP allows `'unsafe-inline'` for scripts (documented as a deliberate first step pending nonce middleware) | `apps/web/next.config.mjs:42-47` |

---

## 3. What the codebase does well

Carried from run 1's validated assessment, corroborated by run 2 recon:

- **Authentication.** HS256 pinned explicitly in `jwt.verify`; required claims checked; a
  `session_version` revocation channel with a 60 s Redis cache; tokens accepted only from an
  HttpOnly cookie or an `Authorization` header, never the URL. OAuth `state` generated with
  `crypto.randomUUID()`, mirrored into a Lax cookie for Safari/LINE in-app, verified on callback.
  LIFF ID tokens verified server-side against LINE with a correctly resolved audience.
- **Webhook verification.** Raw bytes preserved by a *scoped* content-type parser, length-guarded
  `timingSafeEqual`, checked before any JSON parse or side effect.
- **Secrets.** `DOWNLOAD_TOKEN_SECRET` mandatory, ≥32 chars, deliberately separate from
  `JWT_SECRET` (the previous derived default is called out as the bug it was); `VAULT_MASTER_KEY`
  format-validated; `.env` git-ignored and untracked; no credential in the tree.
- **Download tokens.** Bound to file *and* user, 60 s TTL, single-use via Redis `GETDEL` on a
  SHA-256 of the token so the store never holds a usable value, membership re-checked at redemption.
- **Injection posture.** No `eval` / `Function` / `child_process` / `vm` / dynamic `import()`
  anywhere (grep-confirmed across `apps/api` and `apps/web`). The only `dangerouslySetInnerHTML` is
  `JSON.stringify` of a hardcoded constant. Google Sheets uses `valueInputOption:'RAW'`.
- **Uploads.** Magic-byte sniffing rather than declared Content-Type; three *separate* multipart
  scopes; `sanitizeR2Name()` on every object key; mid-stream size abort.
- **Quota accounting.** Reserve-then-settle, refunds routed by the immutable `charged_to` ledger
  rather than the mutable `team_id`, affected-row checks guarding every refund against
  double-credit under concurrency.
- **The comments.** Nearly every non-obvious decision records why it was made and what broke last
  time. Two of run 1's leads came from the code documenting its own hazard.

---

## 4. Recommended next steps

1. **Re-run Phases 2–6 with hunter agents enabled.** This is the substantive gap. Run 1 also
   lacked independent Phase 2/3/6 agents, so **no run to date has had an adversarial hunt**. The
   skill's own guidance is that a single complete run finds roughly half of what multiple runs
   find; zero complete runs have happened.
2. **Priority hunt targets never covered by any run:** `upload.worker.ts` job handlers and BullMQ
   payload trust; the scan/OCR/PDF-merge/docx pipelines; the RPC function bodies in migrations
   026/029/042 (never read — check for `SECURITY DEFINER` with a mutable `search_path`); the
   Google OAuth flow end-to-end; legacy-box create/reorder; the client-side/LIFF surface.
3. **Close the two cheap items now**, independent of any further audit: the `'`-prefix guard on
   xlsx cells (§2.1) and the DB CHECK constraints on chat-ID shape (§1.1).
4. **Confirm finding 2 is actually closed** — specifically whether a departed member who
   re-presents the retained group ID is re-enrolled by `ensureGroupMember` (§1.2).
5. **Test `trustProxy` against the live Railway origin** (§2.5). It is the only item here whose
   severity could rise sharply, and it cannot be resolved from source.
