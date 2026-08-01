# ระบบสมาชิก (Membership) — Bug & Gap Report

Built on Nookeb's committed stack — **Fastify + Supabase (raw SQL migrations) + `node:test`** — per your answer to the stack question. The spec named Express + Prisma + Vitest; that stack does not exist anywhere in this repo, and building it standalone would have produced a parallel system that enforces nothing on the live bot. Every file below is wired into the real request/worker paths.

**Deliverable name mapping** (spec name → what was built):

| Spec | Delivered |
|---|---|
| `prisma/schema.prisma` | `supabase/migrations/051_membership.sql` |
| `src/config/plans.ts` | `apps/api/src/config/plans.ts` (+ `billing-period.ts`) |
| `src/middleware/quota.ts` | `apps/api/src/middleware/quota.ts` |
| `src/middleware/planGuard.ts` | `apps/api/src/middleware/planGuard.ts` |
| `src/services/*` | `quota.service.ts`, `membership.service.ts`, `boost.service.ts`, `support.service.ts`, `quota-message.ts` |
| `src/routes/*` | `routes/plans.ts`, `routes/boosts.ts`, `routes/support.ts` + quota/plan guards inserted into 6 existing route files |
| `src/jobs/*` | `apps/api/src/jobs/` (queue, worker, quotaReset, trashCleanup, boostExpiry, diaryReminder) |
| `tests/` (Vitest) | `node:test` — 100 new tests across 4 files; **419 total, 415 pass, 0 fail, 4 skipped** (pre-existing live-infra skips) |

Verification run: `npx turbo run typecheck` → 4/4 workspaces clean. Full API suite → 0 failures.

---

## Feature matrix status

| Feature | Status | Notes |
|---|---|---|
| **1. Locker — FREE 1 GB + 1 GB/referral, cap 4 GB** | ✅ Implemented | `lockerLimitBytes()`. Mirrored into `users.storage_limit` by `syncStorageLimit()` so the existing atomic `increment_personal_storage` RPC keeps enforcing it unchanged. ⚠️ **This supersedes migration 030's `referral_tiers` ladder (0→1, 3→2.5, 5→4 GB) for FREE.** The `redeem_referral` RPC still writes the old tier value; it uses `GREATEST()`, so it can only ever raise the limit above the new formula, never lower it. See "Known gaps" #1. |
| **1. Locker — PRO 15 GB / PREMIUM 60 GB flat, no referral bonus** | ✅ Implemented | `referral_storage_bonus` is a FREE-only feature flag; `referralCount` is ignored for paid plans by design, and that is unit-tested. |
| **1. Pre-check on every upload** | ✅ Implemented | Pre-existing and preserved: `incrementPersonalStorage(enforce:true)` reserves before a byte is written (LINE worker, vault, gift box, docx). |
| **2. Group file quota 50 / 500 / 1500 per group per month** | ✅ Implemented | `quota.service` feature `group_files`, `scope_id` = LINE group id. Charged in `upload.worker.ts` **per file, before storing**, using the **uploader's** plan. Not counted on message send; not counted for personal uploads. Refunded if `storeUpload` throws. |
| **3. Boost — FREE 0 / PRO 1 / PREMIUM 3** | ✅ Implemented | `user_group_boosts` + `claim_group_boost` RPC, which locks the `users` row before counting so two concurrent claims can't both take the last slot. |
| **3a. UI group picker with max** | ✅ Implemented (API) | `GET /boosts` returns `{limit, used, available, boosts[]}` — everything a checkbox picker needs to render and enforce. ⚠️ **No React page was built** — the spec's OUTPUT FORMAT lists no web deliverables. See "Known gaps" #2. |
| **3a. Chat command "บูธ" → inline group selector** | ✅ Implemented | `routes/webhook/boost-handlers.ts`. Works bare in a group (like `ผูกทีม`) and prefixed anywhere. Rendered as LINE quick replies — LINE has no multi-select control. ⚠️ Group labels are `กลุ่ม …{last 6 of id}`: **there is no groups table with names in this codebase**, and inventing one would be fabrication. |
| **3b. Must un-boost before switching (or replace if under limit)** | ✅ Implemented | `boostGroup` returns `BOOST_LIMIT_REACHED` **naming the occupying groups** so the caller can offer a swap; `POST /boosts/replace` does it in one call and rolls back if the claim fails. |
| **3c. 30-day boost duration** | ✅ Implemented | `BOOST_DURATION_DAYS = 30`; live = `released_at IS NULL AND expires_at > NOW()`, evaluated at read time so a boost is never live a minute past its end. |
| **3d. `user_group_boosts` table** | ✅ Implemented | Exactly the specified columns plus `released_at` (soft release keeps history and lets the same group be re-boosted later). |
| **4a. Notification quota 7 / 30 / 100 per month** | ✅ Implemented | Charged **per push** to the task creator in `taskReminderWorker`. Over-quota stamps `cancelled_at`, not `failed_at` — nothing broke. **Fails open** on a quota lookup error: a missed deadline is worse than an uncounted push. ⚠️ Dormant while `TASK_NOTIFICATIONS_ENABLED = false` (pre-existing). |
| **4b. Reminder intervals as checkboxes, [3h,6h,1d,2d,3d], max 1/2/4** | ✅ Implemented | `tasks.reminder_intervals INT[]`, validated **server-side** by `resolveReminderConfig` and backed by a DB CHECK (closed set, 1–4 entries, no duplicates via an IMMUTABLE helper). Required extending `RemindType` and `task_reminders.remind_type` — the original four shots could not express 6h or 2d. **Every plan sees the same five options**; `maxSelectable` is the only thing a plan changes, and a test asserts each plan can select each of the five. |
| **4b. "PRO selects [6h,1d] → notified 1d before AND 6h before"** | ✅ Implemented | That exact example is a test case. Selections are deduped **before** counting, so a double-ticked box can't consume a FREE user's single slot. |
| **4c. Notify only non-submitters** | ✅ Implemented | `tasks.notify_only_pending`, gated at write time AND **re-checked at delivery time**, so a downgrade takes effect on the next shot. Excludes items in `submitted` status. |
| **4d. FREE single deadline reminder** | ✅ Removed per instruction | The §4b/§4d conflict was **resolved by you in favour of §4b**: FREE picks exactly 1 checkbox from the same five options as PRO and PREMIUM. All fallback logic is gone — `ReminderPolicy.fallbackAtDeadline` deleted, the `at_deadline` `RemindType` and its zero offset deleted, dropped from the `task_reminders.remind_type` CHECK, and `resolveShots()` now returns `[]` when nothing is selected. A regression test asserts `REMINDER_POLICY` exposes only `maxSelectable` and `notifyOnlyPending`, so a fallback cannot creep back in. ⚠️ **Behaviour change:** a task created with no interval selection now schedules **no reminders at all** (previously the pre-membership default was the full 4-shot schedule). Existing LIFF clients do not yet send `reminderIntervals`, so until the picker ships they will create tasks with no reminders — see gap #9. |
| **5. Task creation quota 7 / 25 / 100** | ✅ Implemented | `quotaCheck('tasks')` on `POST /tasks`. Reserved by middleware, auto-released if the handler answers 4xx (bad deadline, unregistered assignee). **Deleting a task does not refund** — the delete path simply never calls `releaseQuota`. |
| **6. Sub-tasks / recurring / attachments / submit→accept→reject, all plans** | ✅ Implemented | Pre-existing; **verified no gate was added**. |
| **7. Word conversion 10 / 30 / 100 pages** | ✅ Implemented | Page count extracted **before** processing (`pdf-lib` page tree for PDFs, 1 for images) so an over-quota document never costs a Mistral call. Refunded on every non-producing exit path **including retry rethrows** — without that, a doc needing 3 attempts would be charged 3×. |
| **8. Scan 10 / 30 / 100** | ✅ Implemented | Read-only pre-check when the session opens (fail fast before the user sends 12 photos); charged at `เสร็จ`, after the compare-and-set guarantees one winner; refunded if `finalize_scan` exhausts its retries. A rejected charge restores the session to `collecting`. |
| **9. PDF merge 10 / 30 / 100** | ✅ Implemented | Same machinery as scan, keyed on `session_kind`. |
| **10. Vault capacity 10 / 30 / 100, `VAULT_FULL`** | ✅ Implemented | Checked before the storage reservation and before any bytes stream. ⚠️ Two simultaneous uploads at 9/10 can both pass — bounded at **+1 item**, accepted deliberately rather than locking the table per upload (documented in `evaluateCapacity`). |
| **11. Gift box 3 / 10 / 30 per month** | ✅ Implemented | `quotaCheck('gift_boxes')`. Independent of the pre-existing `MAX_BOXES_PER_USER = 10` *live-boxes* cap; a user can hit either first. |
| **12. Trash retention 5 / 30 / 30** | ✅ Implemented | **Fixed a latent bug**: the old test was `plan === 'pro' \|\| plan === 'team'`, which would have silently given every PREMIUM user the 5-day FREE window. Policy now comes from the plan table via `jobs/trashCleanup.job.ts`. No second daily job — the existing `purge_deleted` repeatable already sweeps everything in one pass. |
| **13. Share links unlimited** | ✅ Implemented | No quota added; verified none exists. |
| **14. Export task summary — FREE ❌** | ✅ Implemented | `planGuard('export_task_summary')` on `GET /tasks/export`, before the expensive task load. Answers **403** `PLAN_UPGRADE_REQUIRED` with `current_plan` / `required_plan`. ⚠️ Spec said "403 with message 'upgrade to Pro'"; the message is Thai, matching the rest of the product. |
| **15. Google Sheets — PREMIUM only** | ✅ Implemented | Gated in **three** places: the OAuth start (`/auth`), the callback (re-checked against the bound user before the refresh token is stored — no session survives Google's redirect, so `planGuard` can't run there), and the sync worker at **delivery** time, so a downgraded user's sheet stops receiving rows without their credential being deleted. |
| **16. Individual performance report — PREMIUM only** | ✅ Implemented | The 📊 tab is replaced with an upgrade notice rather than removed — removing it would shorten the 9-link nav strip and change `sizeOf` for every other tab, so upgrading would force a full workspace reflow. Gate is stated **explicitly** in the worker, not inherited from the §15 gate. |
| **17. Diary reminder — FREE 5/month, paid daily** | ⚠️ Partial + 🔌 External | Scheduler implemented (`diaryReminder.job.ts`, daily 20:00 ICT, quota-metered, skips users who already wrote today, injectable `push` for testability). **🔌 Requires `LINE_CHANNEL_ACCESS_TOKEN` on the worker service.** ⚠️ The per-user `diary_notification_settings.notify_time` is **not honoured** — one 20:00 sweep only; per-user times need an hourly sweep. ⚠️ This is a **new sanctioned exception to the reply-only push rule** (project rule 10) introduced by §17. |
| **18. Support SLA 24 / 24 / 4h + premium onboarding call** | ✅ Implemented | `sla_hours` **derived** from `config/plans.ts` at creation, never hard-coded at the route, and **stored** so a later downgrade can't retract a promise already made. `listBreachedTickets()` gives ops the queue. ⚠️ No ticket **response** surface (agent reply UI/API) — `markResponded()` exists but nothing calls it. |
| **19. Team room — all plans** | ✅ Implemented | Pre-existing; verified no gate was added. |
| **Quota enforcement — pre-check before action** | ✅ Implemented | **Reserve-then-settle.** A read-only pre-check is unsafe under concurrency (two requests both read 9/10). `consume_quota` does the check and the increment in one locked statement; failure is side-effect-free. |
| **Quota enforcement — structured error** | ✅ Implemented | `{ error: "QUOTA_EXCEEDED", feature, limit, used, reset_at }`, returned as **429** (429 = out of quota, retry after `reset_at`; 403 = plan gate). LINE paths get a Thai sentence from the same state, so the numbers can't disagree. |
| **Quota enforcement — reset 1st, 00:00 ICT** | ✅ Implemented | **Structural, not a job**: rows are keyed by Bangkok `period_start`, so at 00:00 ICT the lookup key changes and the first call creates a fresh row at 0. The reset cannot fail, run late, or double-run. The monthly job is *housekeeping only* (prunes periods older than 6 months). |
| **Quota state in `user_quotas`** | ✅ Implemented | Plus `scope_id` (NOT NULL DEFAULT `''`) so group-scoped and user-global quotas share one engine, one reset, one shape. `limit_value` not `limit` (reserved word). |
| **Upgrade mid-month: new limit, keep `used`** | ✅ Implemented | Falls out of the design — `consume_quota` re-stamps `limit_value` from the current plan on every call. **Zero quota rows are rewritten on a plan change.** Asserted by `quotaUsageReset: false` in the change-plan response. |
| **Downgrade: lower limit immediately, block new usage, keep data** | ✅ Implemented | Same mechanism. `evaluateQuota` returns `allowed:false, remaining:0` (never negative) for an over-limit user, and nothing in the codebase deletes on downgrade. Unit-tested. |
| **Schema: users, plans, subscriptions, user_quotas** | ✅ Implemented | `users` extended (plan CHECK widened); "plans" is `config/plans.ts` — code, not a table, so limits can't drift from the enforcement that reads them. |
| **Schema: groups, group_members, group_files** | ⚠️ Partial — pre-existing model kept | This codebase has **no `groups` table**: the LINE group id *is* the tenant key (CLAUDE.md §8), `group_members` already exists, and group files live in `files` with a `space_id`. Adding parallel tables would fork the source of truth on a live system. Group file *quota* is fully implemented. |
| **Schema: tasks, task_subtasks, task_submissions, task_reminders** | ⚠️ Partial — pre-existing names | `task_items` (= sub-tasks), `task_reminders`, and submissions modelled as status + `submitted_at`/`submission_note` on `task_items` rather than a separate table. All functionally present. |
| **Schema: locker_files, vault_files, share_links, gift_boxes, trash_items** | ⚠️ Partial — pre-existing names | `files` (= locker_files), `vault_files` ✅, `file_shares` (= share_links), `legacy_boxes` (= gift_boxes). **No `trash_items` table** — trash is `files.deleted_at` (soft delete, project rule 6); a parallel table would fork it. |
| **Schema: support_tickets** | ✅ Implemented | New table, exactly as specified. |
| **Schema: user_integrations** | ⚠️ Partial — deliberate | Created for LINE and future providers. **Google deliberately stays in `google_integrations` (migration 046)**, which already holds live AES-256-GCM-encrypted refresh tokens in the same shape. Moving live ciphertext between tables is a data-loss risk with no functional payoff. |
| **Indexes: `(user_id, period_start)`; unique `(user_id, group_id, period_start)`** | ✅ Implemented | Both, verbatim. The group-file unique is a partial index on `feature='group_files'`, kept as a named backstop alongside the generic 4-column unique. |
| **API: domain-grouped routes** | ✅ Implemented | `/plans`, `/boosts`, `/support` added; quota/plan guards inserted into `/tasks`, `/vault`, `/legacy-box`, `/integrations`. ⚠️ No `/scan`, `/pdf`, `/convert` HTTP routes exist — **those features are LINE-chat-only in this product**, and their quotas are enforced in the webhook + worker instead. |
| **API: explicit middleware order** | ✅ Implemented | `authenticate → planGuard → quotaCheck → handler`, stated in a comment on every guarded route and in both middleware file headers. |
| **API: `quotaCheck('group_files', getGroupScope)` factory** | ✅ Implemented | Plus `groupScope()`, `groupScopeFromBody()`, `userScope` resolvers so the scope is readable at each call site. |
| **Jobs: quota reset, trash cleanup, reminders** | ✅ Implemented | Own BullMQ queue (`nookeb-membership`) so a wedged sweep can't stop task reminders. IANA timezone on every repeat — "the 1st at 00:00 ICT" expressed as a UTC cron is a different day number each month. |
| **Tests: every quota check and limit enforcement** | ✅ Implemented | 100 new tests: every matrix number as a literal, boundary cases (last unit allowed / next blocked), 0-limit ≠ unlimited, over-limit post-downgrade, Bangkok month boundaries at ±1 ms, DST-free offset, plan-gate matrix, reminder selection limits, retention per plan. |

---

## Known gaps and decisions you should review

1. **Referral ladder conflict (§1).** Migration 030's `redeem_referral` RPC still writes the old tier values (0→1, 3→2.5, 5→4 GB) into `users.storage_limit`. It uses `GREATEST()`, so it can only raise above the new 1+1/referral formula — a user with 3 referrals gets 4 GB from `syncStorageLimit` and 2.5 GB from the RPC, and keeps 4 GB. Harmless today, but two formulas for one number. **Recommended follow-up:** replace the RPC body with a call to the same formula, or drop `referral_tiers`.

2. **No web UI.** The boost group picker, pricing page, quota meters and upgrade prompts are API-complete but have no React pages. The spec's OUTPUT FORMAT listed only backend deliverables, so I did not build them.

3. **No payment provider.** `POST /plans/change` records the plan change and is the seam a payment webhook would call, but **it takes no money and is currently self-service** — it must be moved behind a real billing callback (or admin-only) before this ships to production. Nothing in the spec described a gateway.

4. **Migration 051 was not executed.** No local Postgres and the Docker daemon is not running, so it was reviewed but not run. I found and fixed three defects by review that would have failed at runtime: PL/pgSQL OUT-parameter/column ambiguity in `consume_quota` and `release_quota` (would raise "column reference is ambiguous" on **every** call), a subquery inside a CHECK constraint (illegal in Postgres), and `array_length` returning NULL for `'{}'` making an empty-array check pass. **Please apply it to a staging database before production.**

5. **`support_tickets` has no agent-side surface.** Tickets are created and listed; `markResponded()` and `listBreachedTickets()` exist but nothing calls them.

6. **Diary reminder ignores per-user `notify_time`.** One 20:00 ICT sweep. Honouring the column needs an hourly sweep bucketed by hour.

7. **`task_notifications` and all reminder behaviour are dormant** behind the pre-existing `TASK_NOTIFICATIONS_ENABLED = false`. The code is complete and correct; flipping that constant activates §4a–§4c together.

8. **Deploy order matters.** Migration 051 **before** the API/worker deploy. `packages/shared` must be rebuilt (`RemindType` changed). Per CLAUDE.md, env is per-Railway-service — the worker needs `LINE_CHANNEL_ACCESS_TOKEN` for §17.

9. **No client sends `reminderIntervals` yet.** With the fallback removed, a task created without a selection schedules zero reminders. The LIFF create flow and the dashboard modal need the 5-checkbox picker (capped at the caller's `maxSelectable`, which `GET /plans/me` already returns) before reminders are switched on. Until then, `resolveShots()` returning `[]` is correct but silent. Related to gap #2 (no web UI).

10. **`resolveShots()` has no unit test.** It lives in `taskScheduler.ts`, which imports the BullMQ/Redis plugin and therefore requires a valid `.env` at import time — the pure config layer around it is fully covered instead. Verified by direct runtime execution: no selection → `[]`, `[6]` → `["6_hours"]`, `[6,24]` → `["1_day","6_hours"]`, all five → all five in chronological order, legacy `reminder_count: 2` → `["1_day","3_hours"]`. Extracting it into a pure module would make it testable.
