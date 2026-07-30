# Security Audit — หนูเก็บ (nookeb)

**Target:** `D:\หนูเก็บ (Nookeb)` · branch `main` @ `1ee62ae` (clean tree)
**Date:** 2026-07-31 · **Run:** 1 (no prior runs found in `./security-reports/`)
**Method:** Cloudflare `security-audit` skill — Phase 1 recon (3 parallel agents) →
Phase 2 hunt → Phase 3 adversarial validation → Phase 4/5 reporting → Phase 6 verification.

> **Methodology caveat, stated up front.** Phase 1 ran as the skill specifies: three
> independent reconnaissance agents. Phases 2, 3 and 6 did **not** — agent delegation was
> declined mid-run, so the hunt, the disprove-it pass and the final verification were all
> performed by the same reasoner rather than by separate agents with independent context.
> The skill relies on that separation to kill false positives and catch blind spots, so
> the adversarial independence behind these findings is weaker than the method intends.
> Every line reference below was re-read against source before publication, and each
> finding's candidate mitigations were enumerated and eliminated individually — but a
> genuinely independent verification pass would still be worth running.

---

## Executive summary

This is a well-defended codebase. Authentication, secret handling, storage-quota
accounting, the vault's crypto, and the file/space authorization layer are all careful,
consistently applied, and unusually well-commented — most of the obvious classes
(SQL/PostgREST injection, XSS, SSRF, command execution, path traversal, IDOR on files,
open redirect, weak tokens, secrets in the repo) are genuinely closed, and several were
closed by deliberate prior fixes still visible in the comments. The audit found **one
exploitable HIGH-severity defect and one MEDIUM**, both in the same place: the LINE
**group-identifier trust model** behind the Task Manager.

The HIGH finding is that `POST /tasks` never validates the *shape* of the `groupId` it is
given. A LINE user ID (`U…`) is accepted where a group ID (`C…`) is expected, and the
Official Account then pushes an attacker-authored Flex card straight into that person's
private 1-on-1 chat. The application itself hands out the user IDs needed to aim it
(`GET /groups/:groupId/members`). The repository *knows* about this hazard — migration
`043_personal_tasks.sql` warns in its header that a user ID must never reach
`tasks.group_line_id`, and `apps/web/lib/liff.ts:248` defines exactly the right regex —
but that regex lives only on the client, and the DB CHECK that was relied on to enforce
the rule only tests for NULL, not for format. This is the classic shape of a real bug:
the control was designed, documented, and then implemented on the wrong side of the
trust boundary.

The MEDIUM is the same trust model seen from the other end: group task access can be
granted but never revoked.

Everything else the audit surfaced is a hardening note, not a finding.

## Baseline

Comparables: consumer file archives (Dropbox / Google Drive) for the storage half,
messaging-platform archival bots for the chat-intake half, and Trello/Asana-lite for
tasks. Tradeoffs this app shares with all of them, and which are therefore **not**
findings: presigned object-storage URLs with a TTL; unguessable-token public share
links; a server-side database credential with tenant isolation enforced in application
code; trusting the messaging platform as the identity layer with HMAC as the check.

Where it diverges from the comparables — and where the findings are — is that a
messaging platform's *chat identifier* is used as a bearer capability. Slack and
Discord bots do the same thing for convenience, but they scope the capability by asking
the platform whether the caller is still in the channel. This app deliberately stopped
doing that (`ensureGroupMember`, `task.service.ts:100-118`, and the strict variant
`getChatMemberProfileStrict` it no longer calls) after the check produced false
negatives. Both findings below fall out of that one decision.

## Findings

| # | Severity | Title |
|---|---|---|
| 1 | **HIGH** | `POST /tasks` accepts a LINE user ID as `groupId`, turning the Official Account into a targeted push channel for attacker-authored content |
| 2 | **MEDIUM** | LINE-group task access has no revocation path — a removed member keeps full read/write access indefinitely |
| 3 | INFORMATIONAL | `GET /groups/:groupId/members` discloses co-members' raw LINE user IDs (the targeting primitive for #1) |

---

### 1. HIGH — user ID accepted as group ID → arbitrary push into a chosen user's private chat

**Where:** `apps/api/src/routes/tasks.ts:66` (schema), `:254` (auto-enrol), `:354`
(persist), `:380-384` (push) · `apps/api/src/services/task.service.ts:100-118`,
`:251-253` · `supabase/migrations/043_personal_tasks.sql:20-24` (the CHECK that was
relied on) · `apps/web/lib/liff.ts:248` (the correct regex, client-side only).

**Attack.** An authenticated user (any nookeb account — a LIFF or dashboard login is
enough) who is in one LINE group with the bot:

1. `GET /api-proxy/groups/<their-own-group-id>/members` → returns every co-member's
   raw `lineUid` (`U…`).
2. `POST /api-proxy/tasks` with
   `{"scope":"group","groupId":"U<victim>","title":"<any text>","type":"single",
   "globalDeadline":"<future ISO>","items":[{"title":"<any text>","assignees":["U<attacker>"]}]}`.

`ensureGroupMember` finds no row, calls LINE for a display name *purely for decoration*,
upserts a `group_members` row and **returns `true` unconditionally**. Assignee validation
then passes because the attacker's own just-created row is the only roster entry. The
task is written with `group_line_id = "U<victim>"`, and `notifyTarget()` — which simply
returns `group_line_id` — hands that to `pushMessage`. LINE delivers the Flex card from
the Official Account into the victim's 1-on-1 chat.

Nothing rejects the `U…` prefix: the Zod schema is `z.string().min(1).max(100)`, the
column is bare `TEXT` (migration 036), and the `tasks_scope_exclusive` CHECK only asserts
that exactly one of `group_line_id`/`owner_line_uid` is non-NULL.

**Impact.** Attacker-controlled text (200-char title + 200-char item title +
1000-char description) delivered to a named individual inside the brand's trusted
Official Account — a high-credibility phishing and harassment channel that bypasses the
"reply-only" messaging discipline the whole codebase is built around. Repeating it burns
the OA's metered push quota; the codebase itself calls quota exhaustion its
"silent-failure trap", and exhausting it silently disables every legitimate task
announcement and review-loop notice for all users. It also permanently violates the
documented `group_line_id` invariant and litters `group_members` with rows keyed on user
IDs. Delivery requires the victim to have added the OA as a friend — true for every
dashboard/LIFF user, i.e. the entire active user base.

**Fix.** Validate the shape server-side, in the one place the value enters. Reuse the
regex that already exists on the client:

```ts
// apps/api/src/routes/tasks.ts — createTaskSchema
const LINE_CHAT_ID = /^[CR][0-9a-f]{32}$/;
groupId: z.string().regex(LINE_CHAT_ID, 'invalid LINE chat id').optional(),
```

Apply the same to `groupIdSchema` in `apps/api/src/routes/groups.ts:28` and to the
`?groupId=` comparison in `apps/api/src/routes/spaces.ts:171`, and add a DB CHECK
(`group_line_id ~ '^[CR][0-9a-f]{32}$'`) so the invariant is enforced at the column too.

---

### 2. MEDIUM — no revocation path for LINE-group task access

**Where:** `apps/api/src/services/task.service.ts:100-118` (`ensureGroupMember` always
returns true) · `apps/api/src/routes/webhook/line.ts:1159` (rows are never deleted —
stated explicitly in the comment) · consumers: `apps/api/src/routes/groups.ts:44,72,93`,
`apps/api/src/routes/spaces.ts:173,176`, `apps/api/src/routes/tasks.ts:254`.

**Attack.** A user is added to a work LINE group, opens any task page (or simply sends
one message in the group), and is enrolled in `group_members`. They are later removed
from the LINE group. The webhook handles `join`, `memberJoined`, `message`, `postback`
and `unsend` — there is **no `memberLeft` handler anywhere in the tree**, and no code
path deletes a `group_members` row. The ex-member's session still authenticates, so they
continue to call `GET /groups/<id>/room` (every task in the group: titles, descriptions,
assignees, deadlines, statuses, submission and rejection notes), `GET /groups/<id>/members`
(the current roster, refreshed live from LINE), `GET /spaces/<id>/tasks`, and
`POST /tasks` — which pushes a Flex announcement *into the group they were removed from*.
Even if the row were deleted, re-presenting the retained group ID re-enrols them.

**Impact.** Complete, indefinite, unrevocable read access to one group's task data for a
principal the organisation has explicitly ejected, plus the ability to keep injecting
messages into that group's chat. The group has no mechanism — in the product or in the
database — to cut them off. The in-code justification for never deleting rows is that a
departed member should stay *assignable to outstanding tasks*; that is a narrower need
than "retains full read and create access forever".

**Fix.** Separate "is on the roster for assignment history" from "may currently read and
write". Add a `left_at` column, stamp it from a `memberLeft` webhook handler, exclude
stamped rows from `isGroupMember`/`ensureGroupMember` while keeping them joinable for
historical assignee display, and re-verify with `getChatMemberProfileStrict` (which
already exists, `line.service.ts:189-203`) on the enrolment path rather than trusting
possession of the ID alone.

---

### 3. INFORMATIONAL — co-members' LINE user IDs are disclosed to any group-ID holder

`GET /groups/:groupId/members` (`apps/api/src/routes/groups.ts:38-53`) returns
`toGroupMemberDto` (`packages/shared/src/types/task.ts:321-327`), which includes the raw
`lineUid`. The LIFF assignee picker needs an identifier, so this is defensible in
isolation and has no standalone exploit — but it is the targeting primitive that makes
finding #1 practical, and migration 043's own header names it as the reason a user ID
must never become a tenant key. Once #1 is fixed this is inert; consider an
opaque per-group member handle if the roster surface grows.

---

## Hardening notes (not findings)

- **`buildSearchOr` misses `*`.** `apps/api/src/routes/files.ts:89-95` escapes `%`, `_`
  and `\` to stop wildcard DoS, but PostgREST maps `*` to `%` inside `like`/`ilike`
  patterns, so `?search=*` still produces a full wildcard scan. No tenant impact —
  `space_id` is AND-ed and membership is checked first — so this is a completeness gap
  in the stated anti-DoS intent, not a boundary break.
- **Logout does not revoke.** `POST /auth/logout` (`routes/auth.ts:280`) clears the
  cookie but does not bump `users.session_version`, so a JWT captured before logout stays
  valid for up to 24 h. The cookie is HttpOnly and the app is same-origin, so there is no
  demonstrated capture path; bumping the version on logout would close it for free.
- **Share links are creator-revocable only.** Any space member can mint a public link for
  another member's file (`routes/share.ts:95`), but `DELETE …/shares/:shareId` filters on
  `created_by` (`:150`). The file owner's only remedy is deleting the file. Fine for a
  personal space (one member); worth revisiting for team spaces.
- **`/progress/*` is unauthenticated and exempt from the global rate limiter**
  (`index.ts:144`). The batch ID is an unguessable UUID and the payload is two counters,
  so there is nothing to steal — but it is an unmetered path to a Redis round-trip on
  infrastructure shared with the rate limiter and BullMQ.
- **`GET /tasks/:id/ics` leaks more than documented.** The route comment describes it as
  exposing title + deadline; it also emits every item title and every item *description*
  (`routes/tasks.ts:1182,1196`). Still capability-gated by an unguessable UUID — update
  the comment or trim the payload.
- **`PATCH /tasks/:id/items/:itemId/note` has no status gate** (`routes/tasks.ts:1046`),
  unlike its done/submit/approve/reject siblings, so an assignee can still edit their note
  after a task is closed. Assignee-scoped, so it is a state-machine wrinkle, not an authz
  gap.
- **CSP allows `'unsafe-inline'` for scripts** (`apps/web/next.config.mjs:42-47`). Already
  documented as a deliberate first step pending nonce middleware; no injection sink was
  found that would exercise it.

## Requires deployment testing (unverifiable from source)

- **`trustProxy: true` and per-IP limits.** With unbounded proxy trust, `X-Forwarded-For`
  is attacker-controlled for any client that can reach the Railway origin directly,
  which would defeat every per-IP control (`/auth/line` 10/min + ban 5, the share and
  legacy-box 30/min caps, the anonymous pro-interest limit) and would allow banning
  another user's IP. `index.ts:42-59` documents this as a known, accepted tradeoff with
  the reasoning spelled out. Whether it is exploitable depends entirely on whether the
  Railway origin is reachable without passing through Vercel — a deployment fact not in
  this repository. Test it against the live origin; if it is directly reachable, re-key
  the `/auth/line` limiter on the LINE login channel or user identity rather than IP,
  as that comment itself recommends.

## What this codebase does well

Worth stating plainly, because it is what makes the two findings above stand out:

- **Authentication.** HS256 pinned explicitly in `jwt.verify`; required claims checked;
  a `session_version` revocation channel with a 60 s Redis cache; tokens accepted only
  from an HttpOnly cookie or an `Authorization` header, never the URL. OAuth `state` is
  generated with `crypto.randomUUID()`, mirrored into a Lax cookie for Safari/LINE-in-app,
  and verified on the callback. LIFF id tokens are verified server-side against LINE with
  a correctly resolved audience.
- **Webhook verification.** Raw bytes preserved by a *scoped* content-type parser,
  length-guarded `timingSafeEqual`, checked before any JSON parse or side effect.
- **Secrets.** `DOWNLOAD_TOKEN_SECRET` is mandatory, ≥32 chars, and deliberately separate
  from `JWT_SECRET` (the previous derived default is called out as the bug it was);
  `VAULT_MASTER_KEY` is format-validated; `.env` is git-ignored and untracked; no
  credential appears in the tree.
- **Download tokens.** Bound to both file and user, 60 s TTL, single-use via Redis
  `GETDEL` on a SHA-256 of the token so the store never holds a usable value, with
  membership re-checked at redemption.
- **File authorization.** `getAuthorizedFile` is applied uniformly; cross-space folder and
  tag references are rejected explicitly; trash is uploader-scoped end to end.
- **Quota accounting.** Reserve-then-settle on upload, refund routed by the immutable
  `charged_to` ledger rather than the mutable `team_id`, affected-row checks guarding every
  refund against double-credit under concurrency, and charge rollback when a restore loses
  its race. This is better than most production code.
- **Vault.** Argon2id at sane parameters, per-user (not per-IP) lockout with exponential
  escalation, unlock sessions bound to `session_version`, no PIN-reset path by conscious
  decision, no presigned URLs, and an honest in-code statement of what watermarking cannot
  do.
- **Injection posture.** No `eval`/`Function`/`child_process`/`vm` anywhere. Google Sheets
  writes use `valueInputOption: 'RAW'` (no formula execution in the victim's sheet), and
  exceljs writes strings as string cells, so neither export path is formula-injectable.
  The one hand-built PostgREST filter strips the structural characters. The only
  `dangerouslySetInnerHTML` in the web app is `JSON.stringify` of a hardcoded constant.
- **The comments.** Nearly every non-obvious decision records why it was made and what
  broke last time. Two of this audit's leads came from the code documenting its own
  hazard — which is exactly what good comments are for.

## Coverage

Each audit run explores different paths; the skill's own guidance is that a single run
finds roughly half of what multiple runs find. This run weighted access control, the
task subsystem, auth/session protocol, and injection sinks. Areas that received lighter
treatment and would benefit from a second run: the `upload.worker.ts` job handlers and
BullMQ payload trust, the scan/OCR/PDF-merge/docx pipelines, the admin analytics RPC
bodies in migrations 026/042, the Google OAuth integration flow end-to-end, and the
legacy-box create/reorder paths. Re-running the audit is recommended.
