# Findings Detail

Complete data flows for every MEDIUM-or-above finding. Line numbers verified against
`main` @ `1ee62ae`.

---

## Finding 1 (HIGH) — LINE user ID accepted as `groupId` → targeted push into a private chat

### Data flow, input → sink

| # | Kind | Location | What happens |
|---|---|---|---|
| 1 | entrypoint | `apps/api/src/routes/tasks.ts:66` | `createTaskSchema.groupId` is `z.string().min(1).max(100).optional()`. No format constraint. The `superRefine` at `:85-105` only checks presence/absence per scope. |
| 2 | propagation | `apps/api/src/routes/tasks.ts:254` | `ensureGroupMember(app.supabase, body.groupId!, lineUid)` — the sole tenant guard for a group create. |
| 3 | propagation | `apps/api/src/services/task.service.ts:100-118` | No existing row → `getChatMemberProfile()` (display-only, non-gating) → `upsertGroupMember()` → **`return true`**. The function is documented as "Always returns true (enrolls) unless the DB write itself fails". |
| 4 | propagation | `apps/api/src/routes/tasks.ts:321-329` | `listGroupMembers(body.groupId!)` now contains exactly one row — the attacker's, created one step earlier — so `assignees: ["U<attacker>"]` validates. |
| 5 | propagation | `apps/api/src/routes/tasks.ts:354` → `services/task.service.ts:272` | `groupLineId: body.groupId!` is written verbatim to `tasks.group_line_id`. |
| 6 | propagation | `apps/api/src/services/task.service.ts:251-253` | `notifyTarget()` returns `task.group_line_id` for a non-personal task, with no validation. |
| 7 | sink | `apps/api/src/routes/tasks.ts:380-384` | `pushMessage(announceTo, [buildTaskCreatedFlex(task)])` — the Official Account sends the attacker's Flex card to `U<victim>`. |

### Why every candidate mitigation fails

- **Zod schema** — `z.string().min(1).max(100)`, `tasks.ts:66`. `"U"+32 hex` is 33 chars. Passes.
- **`ensureGroupMember`** — `task.service.ts:100-118`. Returns `true` on the enrolment path
  by design. The `getChatMemberProfile` call inside it is explicitly *not* a gate
  (`task.service.ts:106-108`: "This fetch is NOT a membership gate"). The strict variant
  that *would* gate, `getChatMemberProfileStrict` (`line.service.ts:189-203`), exists but
  is not called here.
- **DB constraint** — `supabase/migrations/036_tasks.sql:13` declares
  `group_line_id TEXT NOT NULL`; there is no format CHECK. `043_personal_tasks.sql:20-24`
  adds `tasks_scope_exclusive`, which only asserts that exactly one of
  `group_line_id` / `owner_line_uid` is non-NULL — it cannot distinguish `U…` from `C…`.
- **The correct validation exists but on the wrong side** — `apps/web/lib/liff.ts:248`
  defines `const LINE_CHAT_ID = /^[CR][0-9a-f]{32}$/` and applies it at `:264` to filter
  pseudo chat IDs. That file ships to the browser. Repo-wide grep confirms this regex has
  no server-side counterpart.
- **`notifyTarget`** — `task.service.ts:251-253` is a bare ternary returning the column.

### Exact requests

Step 1 — harvest a victim user ID (any group the attacker is legitimately in):

```
GET /api-proxy/groups/Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/members HTTP/1.1
Host: <web-origin>
Cookie: nookeb_session=<attacker session>
```

Response (`toGroupMemberDto`, `packages/shared/src/types/task.ts:321-327`):

```json
{"members":[{"lineUid":"U1111...","displayName":"Somchai","pictureUrl":"https://..."},
            {"lineUid":"U2222...","displayName":"Malee","pictureUrl":"https://..."}]}
```

Step 2 — fire the push:

```
POST /api-proxy/tasks HTTP/1.1
Host: <web-origin>
Cookie: nookeb_session=<attacker session>
Content-Type: application/json

{"scope":"group",
 "groupId":"U2222222222222222222222222222222222",
 "title":"บัญชีของคุณถูกระงับ กดยืนยันตัวตนที่นี่",
 "type":"single",
 "globalDeadline":"2026-12-31T18:00:00+07:00",
 "items":[{"title":"ยืนยันตัวตนภายในวันนี้",
           "description":"<1000 chars of attacker text>",
           "assignees":["U<attacker-own-uid>"]}]}
```

### What the attacker gets

`201 {"task":{...},"announced":true}` — and Malee receives a Flex card from the หนูเก็บ
Official Account she trusts, carrying the attacker's title and description. Repeat with a
new title for each subsequent message; repeat across the whole harvested roster for
broadcast. Each call consumes one metered push from the OA's shared quota (`POST /tasks`
is rate-limited to 10/min per IP, and `trustProxy: true` makes that IP spoofable for any
client reaching the origin directly — see the deployment-testing note in REPORT.md).

### Prerequisites

- An authenticated nookeb session (free; LINE Login or LIFF).
- Membership in at least one LINE group with the bot, purely to obtain victim user IDs.
  Any other source of a `U…` ID works equally well.
- The victim must have added the OA as a friend for LINE to accept the push — true of
  every dashboard and LIFF user.

### How the baseline handles this

Slack and Discord bot frameworks type their channel identifiers and reject a user ID
where a channel ID is required; a Slack `chat.postMessage` to a user ID opens a DM only
when the app holds `im:write`, a separately granted scope. The equivalent control here is
the `[CR][0-9a-f]{32}` shape check — which this codebase wrote, and shipped to the wrong
side of the boundary.

### Fix

```ts
// apps/api/src/routes/tasks.ts (and mirror in routes/groups.ts:28, routes/spaces.ts:171)
const LINE_CHAT_ID = /^[CR][0-9a-f]{32}$/;
// inside createTaskSchema:
groupId: z.string().regex(LINE_CHAT_ID, 'invalid LINE chat id').optional(),
```

```sql
-- new migration, after backfilling/removing any offending rows
ALTER TABLE tasks ADD CONSTRAINT tasks_group_line_id_shape
  CHECK (group_line_id IS NULL OR group_line_id ~ '^[CR][0-9a-f]{32}$');
ALTER TABLE group_members ADD CONSTRAINT group_members_group_line_id_shape
  CHECK (group_line_id ~ '^[CR][0-9a-f]{32}$');
```

Belt-and-braces: have `notifyTarget()` return `null` for a destination that does not match
the chat-ID shape, so no future path can reach `pushMessage` with a user ID through the
group branch.

---

## Finding 2 (MEDIUM) — group task access cannot be revoked

### Data flow

| # | Kind | Location | What happens |
|---|---|---|---|
| 1 | entrypoint | `apps/api/src/routes/groups.ts:88-98` | `GET /groups/:groupId/room` — authenticated, then gated only by `ensureGroupMember`. |
| 2 | propagation | `apps/api/src/services/task.service.ts:100-118` | Possession of the group ID *is* the membership proof; the function enrols and returns `true`. A pre-existing row short-circuits at `:105`. |
| 3 | propagation | `apps/api/src/routes/webhook/line.ts:1149-1179` | `autoUpsertGroupMember` is the only writer of roster rows. Its own doc comment states "the row is NEVER deleted/expired". No `memberLeft` handler exists anywhere in `apps/api/src` (verified by repo-wide grep). |
| 4 | sink | `apps/api/src/routes/groups.ts:100` → `services/team-room.service.ts` `getTeamRoom` | Returns the group's full task room to the caller. |

### Attack sequence

1. Attacker is added to a company LINE group; sends one message (or opens any task page).
   `group_members(group_line_id, line_uid)` row is created.
2. Attacker is removed from the LINE group. Nothing in the application observes this —
   `handleEvent` (`webhook/line.ts:1181`) branches on `follow`, `join`, `message`,
   `postback`, `unsend`, `memberJoined`; there is no `memberLeft` case.
3. From any browser, still holding a valid session:

```
GET /api-proxy/groups/C<group-id>/room     → every task: titles, descriptions,
                                              assignees, deadlines, statuses,
                                              submission notes, rejection notes
GET /api-proxy/groups/C<group-id>/members  → live roster, re-synced from LINE
GET /api-proxy/spaces/<space-id>/tasks?groupId=C<group-id>  → same room, second path
POST /api-proxy/tasks {"scope":"group","groupId":"C<group-id>",...}
                                            → creates a task AND pushes a Flex
                                              announcement into the group chat
```

4. Even deleting the roster row by hand does not help: step 3 re-enrols on the next call,
   because `ensureGroupMember` treats the retained group ID as sufficient proof.

### What the attacker gets

Indefinite read access to one group's entire task history — which for this product
includes work descriptions, per-person assignments and deadlines, and free-text
submission and rejection notes — plus the ability to keep publishing messages into the
chat of a group they were removed from. There is no product or database mechanism to
stop them.

### How the baseline handles this

Slack, Discord and Asana all revoke channel/project visibility at the moment of removal;
a retained channel ID grants nothing because every read re-checks current membership
against the platform. The equivalent primitive already exists here —
`getChatMemberProfileStrict` (`line.service.ts:189-203`), documented as "a success IS
proof of current membership in that chat" — but `ensureGroupMember` deliberately stopped
calling it (`task.service.ts:90-95`) because it produced false negatives for quiet
members and unverified OAs. The fix is to reintroduce it as a *revocation* check rather
than an *admission* check, so a false negative degrades to "cannot enrol right now"
instead of "locked out".

### Fix

1. Add `group_members.left_at TIMESTAMPTZ` (nullable).
2. Handle `memberLeft` in `webhook/line.ts` `handleEvent`: stamp `left_at` for each
   departing `userId`.
3. `isGroupMember` / `ensureGroupMember`: treat a row with `left_at IS NOT NULL` as
   not-a-member; on the enrol path, call `getChatMemberProfileStrict` and only clear
   `left_at` when LINE confirms current membership.
4. Keep stamped rows joinable for historical assignee display, satisfying the original
   reason the rows were never deleted.
