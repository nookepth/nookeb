import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { config } from '../config';
import { registerAdminGuard } from '../middleware/adminGuard';
import { currentPeriodStart, periodResetAtIso } from '../config/billing-period';
import { MONTHLY_QUOTAS, PLANS, normalizePlan, type Plan } from '../config/plans';
import {
  getFailedJobs,
  getQueueStats,
  QUEUE_KEYS,
  type FailedJobSummary,
  type QueueKey,
  type QueueStat,
} from '../services/queue-stats.service';
import { removeFailedJob, retryFailedJob, summariseJob } from '../services/queue-actions.service';
import { requireAdminAction } from '../services/admin-audit.service';
import {
  invalidatePushEnabledCache,
  readPushEnabledUncached,
  setPushEnabled,
} from '../services/push-flag.service';

/**
 * /admin/system — the OPERATIONS half of the admin surface.
 *
 * routes/admin.ts answers "how is the product doing" (users, adoption, funnels,
 * growth). This plugin answers "is the machine running": queue depth, failed
 * jobs, worker liveness, notification delivery, quota pressure, membership
 * state, the support SLA queue, and files wedged mid-pipeline.
 *
 * A SEPARATE plugin rather than more routes in admin.ts for two reasons: the
 * two files have different data sources (BullMQ/Redis and live tables here,
 * usage_events aggregates there), and admin.ts is already 700 lines. Both
 * register the SAME gate via registerAdminGuard, so they cannot drift on who
 * counts as an admin.
 *
 * ── Fail-soft contract, applied to EVERY endpoint in this file ──────────────
 * An ops page is read at exactly the moments the system is unhealthy. If a
 * panel throws when its data source is down, the page shows nothing precisely
 * when it is needed most. So: every fetch is caught, logged, and degraded to an
 * empty array / zero object, and the endpoint answers 200 with a partial
 * payload. A card that renders "—" is a working page reporting missing data; a
 * 500 is a broken page. This mirrors the migration-029/042 posture in admin.ts,
 * where an unapplied RPC leaves a panel blank rather than erroring.
 *
 * ── The fail-soft rule stops at the READ endpoints ──────────────────────────
 * TIER 2 added four mutating endpoints to this file (the push kill switch, job
 * retry/remove, ticket triage). They are the exact INVERSE of the contract
 * above: they validate with zod, they audit through requireAdminAction, and
 * they answer 4xx/5xx rather than degrading. `soft()` must never wrap one — an
 * admin told "done" about a write that silently did not happen is the worst
 * outcome available here, and the whole point of the audit log is that it
 * cannot occur.
 */
const adminOpsRoutes: FastifyPluginAsync = async (app) => {
  registerAdminGuard(app);

  const clampDays = (raw: string | undefined): number =>
    Math.min(Math.max(Number(raw) || 30, 1), 90);

  /** Acting admin's LINE id — always present, registerAdminGuard authenticates first. */
  const actor = (request: FastifyRequest): string => request.authUser!.lineUserId;

  /**
   * Run a fetch, or return `fallback` if it throws. The one place this file's
   * fail-soft rule is implemented, so no endpoint can forget it.
   */
  async function soft<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      app.log.error({ err, panel: label }, 'admin-ops panel failed — degrading to empty');
      return fallback;
    }
  }

  /** Unwrap a supabase result, treating an error as a throw so `soft` catches it. */
  async function rows<T>(
    build: (db: SupabaseClient) => PromiseLike<{ data: unknown; error: unknown }>,
  ): Promise<T[]> {
    const { data, error } = await build(app.supabase);
    if (error) throw error;
    return ((data ?? []) as T[]);
  }

  // ==========================================================================
  // 1–2. GET /admin/system/queues?failed=1 — depth per queue + recent failures
  //
  // `?failed=1` additionally pulls the 20 most recent failed jobs FOR EVERY
  // queue. Opt-in because it is 4 more Redis reads with job payloads attached,
  // and the page polls the counts every 10 s but loads failures only when an
  // admin expands the table.
  // ==========================================================================
  app.get<{ Querystring: { failed?: string } }>('/admin/system/queues', async (request) => {
    const wantFailed = request.query.failed === '1';

    const queues = await soft<QueueStat[]>(
      'queues',
      () => getQueueStats(app.fileQueue),
      [],
    );

    let failed: Record<QueueKey, FailedJobSummary[]> | null = null;
    if (wantFailed) {
      const lists = await Promise.all(
        QUEUE_KEYS.map((key) =>
          soft<FailedJobSummary[]>(`failed:${key}`, () => getFailedJobs(app.fileQueue, key), []),
        ),
      );
      failed = Object.fromEntries(QUEUE_KEYS.map((key, i) => [key, lists[i]])) as Record<
        QueueKey,
        FailedJobSummary[]
      >;
    }

    return {
      queues,
      failed,
      // Total backlog across every queue — the one number worth alerting on.
      backlog: queues.reduce((n, q) => n + q.waiting + q.active + q.delayed, 0),
      failedTotal: queues.reduce((n, q) => n + q.failed, 0),
      checkedAt: new Date().toISOString(),
    };
  });

  // ==========================================================================
  // 3–4. GET /admin/system/health — API self-check + worker liveness
  //
  // The API half repeats GET /health's two dependency probes rather than
  // calling itself over HTTP (a self-request through the ingress would report
  // the proxy's health, not this process's).
  //
  // The WORKER half is the reason this endpoint exists: the worker is a
  // SEPARATE Railway service with its own /health on WORKER_HEALTH_PORT, and
  // nothing else in the product can see it. When WORKER_HEALTH_URL is unset the
  // worker card reports `configured: false` — an honest "not wired up", never a
  // red "down", because an unset env var says nothing about the worker.
  //
  // The fetch is hard-bounded at 4 s. An unreachable worker must fail the card,
  // not hang the admin request until Fastify's own timeout.
  // ==========================================================================
  interface WorkerHealth {
    configured: boolean;
    reachable: boolean;
    healthy: boolean;
    status: string;
    commit: string | null;
    checks: Record<string, string> | null;
  }

  app.get('/admin/system/health', async () => {
    const api = { redis: 'error' as 'ok' | 'error', db: 'error' as 'ok' | 'error' };

    api.redis = app.redis?.status === 'ready' ? 'ok' : 'error';
    api.db = await soft(
      'health:db',
      async () => {
        const { error } = await app.supabase.from('users').select('id').limit(1).maybeSingle();
        return error ? ('error' as const) : ('ok' as const);
      },
      'error' as const,
    );

    const workerUrl = config.WORKER_HEALTH_URL;
    const worker: WorkerHealth = workerUrl
      ? await soft<WorkerHealth>(
          'health:worker',
          async () => {
            const res = await fetch(workerUrl, { signal: AbortSignal.timeout(4000) });
            const body = (await res.json().catch(() => null)) as {
              status?: string;
              commit?: string;
              checks?: Record<string, string>;
            } | null;
            return {
              configured: true,
              reachable: true,
              healthy: res.ok,
              status: body?.status ?? (res.ok ? 'ok' : 'degraded'),
              commit: body?.commit ?? null,
              checks: body?.checks ?? null,
            };
          },
          {
            configured: true,
            reachable: false,
            healthy: false,
            status: 'unreachable',
            commit: null,
            checks: null,
          },
        )
      : {
          configured: false,
          reachable: false,
          healthy: false,
          status: 'not_configured',
          commit: null,
          checks: null,
        };

    return {
      api: {
        healthy: api.redis === 'ok' && api.db === 'ok',
        checks: api,
        commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
      },
      worker,
      checkedAt: new Date().toISOString(),
    };
  });

  // ==========================================================================
  // 5–8. GET /admin/notifications?days=30
  //
  //   5. reminder delivery per day    (RPC admin_reminder_outcomes_daily, 058)
  //   6. the recent failed pushes     (task_reminders.failed_at, live rows)
  //   7. push allowance burndown      (user_quotas feature='task_notifications')
  //   8. diary add-on nudges per day  (RPC admin_diary_addon_daily, 058)
  //
  // §7 is the one that matters commercially: LINE push allowance is metered and
  // FAILS SILENTLY when spent, so "how much of this month's per-user budget is
  // gone" is not visible anywhere else in the product.
  // ==========================================================================
  app.get<{ Querystring: { days?: string } }>('/admin/notifications', async (request) => {
    const days = clampDays(request.query.days);
    const period = currentPeriodStart();

    const [daily, diaryDaily, failures, allowanceRows] = await Promise.all([
      soft(
        'notifications:daily',
        () =>
          rows<{
            day: string;
            scheduled: number;
            sent: number;
            failed: number;
            cancelled: number;
            pending: number;
          }>((db) => db.rpc('admin_reminder_outcomes_daily', { p_days: days })),
        [],
      ),
      soft(
        'notifications:diary',
        () =>
          rows<{
            day: string;
            sent: number;
            skipped: number;
            skipped_wrote: number;
            skipped_lapsed: number;
          }>((db) => db.rpc('admin_diary_addon_daily', { p_days: days })),
        [],
      ),
      // The failure list is a triage queue, not a report: newest 50, and only
      // rows the worker actually gave up on (failed_at is stamped by the
      // final-attempt handler, so a row here has already burnt its 3 attempts).
      soft(
        'notifications:failures',
        () =>
          rows<{
            id: string;
            remind_type: string;
            remind_at: string;
            failed_at: string;
            task_id: string | null;
            tasks: { title: string; status: string; group_line_id: string | null } | null;
          }>((db) =>
            db
              .from('task_reminders')
              .select('id, remind_type, remind_at, failed_at, task_id, tasks(title, status, group_line_id)')
              .not('failed_at', 'is', null)
              .gte('remind_at', new Date(Date.now() - days * 86_400_000).toISOString())
              .order('failed_at', { ascending: false })
              .limit(50),
          ),
        [],
      ),
      soft(
        'notifications:allowance',
        () =>
          rows<{ user_id: string; used: number; limit_value: number }>((db) =>
            db
              .from('user_quotas')
              .select('user_id, used, limit_value')
              .eq('feature', 'task_notifications')
              .eq('period_start', period)
              .order('used', { ascending: false })
              .limit(50),
          ),
        [],
      ),
    ]);

    // Attach display names to the burndown rows. A second bounded query rather
    // than a PostgREST embed: user_quotas has no FK-derived relationship name
    // to `users` that PostgREST exposes under every schema-cache state, and a
    // 50-id `in` filter is one cheap indexed read.
    const names = await soft(
      'notifications:names',
      async () => {
        const ids = [...new Set(allowanceRows.map((r) => r.user_id))];
        if (ids.length === 0) return new Map<string, { name: string | null; plan: string }>();
        const found = await rows<{ id: string; display_name: string | null; plan: string }>((db) =>
          db.from('users').select('id, display_name, plan').in('id', ids),
        );
        return new Map(found.map((u) => [u.id, { name: u.display_name, plan: u.plan }]));
      },
      new Map<string, { name: string | null; plan: string }>(),
    );

    const totals = daily.reduce(
      (acc, d) => ({
        scheduled: acc.scheduled + Number(d.scheduled ?? 0),
        sent: acc.sent + Number(d.sent ?? 0),
        failed: acc.failed + Number(d.failed ?? 0),
        cancelled: acc.cancelled + Number(d.cancelled ?? 0),
        pending: acc.pending + Number(d.pending ?? 0),
      }),
      { scheduled: 0, sent: 0, failed: 0, cancelled: 0, pending: 0 },
    );

    return {
      days,
      period,
      resetAt: periodResetAtIso(),
      totals,
      // Delivery rate over ATTEMPTED shots only (sent + failed). Cancelled shots
      // were withdrawn because the task completed — counting them as misses
      // would make a healthy product look broken.
      deliveryRate:
        totals.sent + totals.failed > 0
          ? Math.round((totals.sent / (totals.sent + totals.failed)) * 100)
          : null,
      daily: daily.map((d) => ({
        day: d.day,
        scheduled: Number(d.scheduled ?? 0),
        sent: Number(d.sent ?? 0),
        failed: Number(d.failed ?? 0),
        cancelled: Number(d.cancelled ?? 0),
        pending: Number(d.pending ?? 0),
      })),
      diaryDaily: diaryDaily.map((d) => ({
        day: d.day,
        sent: Number(d.sent ?? 0),
        skipped: Number(d.skipped ?? 0),
        skippedWrote: Number(d.skipped_wrote ?? 0),
        skippedLapsed: Number(d.skipped_lapsed ?? 0),
      })),
      failures: failures.map((f) => ({
        id: f.id,
        taskId: f.task_id,
        taskTitle: f.tasks?.title ?? null,
        taskStatus: f.tasks?.status ?? null,
        remindType: f.remind_type,
        remindAt: f.remind_at,
        failedAt: f.failed_at,
      })),
      allowance: allowanceRows.map((r) => {
        const limit = Number(r.limit_value);
        const used = Number(r.used);
        const meta = names.get(r.user_id);
        return {
          userId: r.user_id,
          displayName: meta?.name ?? null,
          plan: meta?.plan ?? null,
          used,
          limit,
          unlimited: limit < 0,
          // null for unlimited — a percentage of infinity is not a number an
          // ops page should invent.
          pctUsed: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null,
        };
      }),
    };
  });

  // ==========================================================================
  // 9. GET /admin/quotas — quota pressure across every monthly counter
  //
  // Reads the CURRENT Bangkok period only. Rows are keyed by period_start
  // (migration 051), so "this month" is a plain equality filter and last
  // month's rows are simply out of scope — the reset is structural and needs no
  // date arithmetic here.
  //
  // Paged rather than aggregated: there is no RPC for this (058 defines three,
  // none of them quota-shaped), and PostgREST cannot compare two COLUMNS, so
  // `used >= limit_value * 0.8` cannot be a server-side filter. The rows are
  // pulled in bounded pages and the comparison happens here. Cap is 3 pages —
  // a month's rows are (users × features actually used), so this covers the
  // product comfortably, and `truncated` tells the page when it did not.
  // ==========================================================================
  const QUOTA_PAGE = 1000;
  const QUOTA_MAX_PAGES = 3;

  app.get('/admin/quotas', async () => {
    const period = currentPeriodStart();

    const all = await soft(
      'quotas:rows',
      async () => {
        const collected: { feature: string; scope_id: string; user_id: string; used: number; limit_value: number }[] =
          [];
        for (let page = 0; page < QUOTA_MAX_PAGES; page += 1) {
          const batch = await rows<{
            feature: string;
            scope_id: string;
            user_id: string;
            used: number;
            limit_value: number;
          }>((db) =>
            db
              .from('user_quotas')
              .select('feature, scope_id, user_id, used, limit_value')
              .eq('period_start', period)
              .order('used', { ascending: false })
              .range(page * QUOTA_PAGE, page * QUOTA_PAGE + QUOTA_PAGE - 1),
          );
          collected.push(...batch);
          if (batch.length < QUOTA_PAGE) break;
        }
        return collected;
      },
      [] as { feature: string; scope_id: string; user_id: string; used: number; limit_value: number }[],
    );

    const truncated = all.length >= QUOTA_PAGE * QUOTA_MAX_PAGES;

    // Per-feature roll-up. `atLimit` and `nearLimit` are DISJOINT (>=100% is not
    // also counted as >=80%) so the two numbers can be shown side by side
    // without explaining an overlap.
    const byFeature = new Map<
      string,
      { feature: string; rows: number; totalUsed: number; nearLimit: number; atLimit: number }
    >();
    const pressure: {
      userId: string;
      feature: string;
      scopeId: string;
      used: number;
      limit: number;
      pctUsed: number;
    }[] = [];

    for (const r of all) {
      const used = Number(r.used);
      const limit = Number(r.limit_value);
      const agg =
        byFeature.get(r.feature) ??
        { feature: r.feature, rows: 0, totalUsed: 0, nearLimit: 0, atLimit: 0 };
      agg.rows += 1;
      agg.totalUsed += used;

      if (limit > 0) {
        const pct = (used / limit) * 100;
        if (pct >= 100) agg.atLimit += 1;
        else if (pct >= 80) agg.nearLimit += 1;
        if (pct >= 80) {
          pressure.push({
            userId: r.user_id,
            feature: r.feature,
            scopeId: r.scope_id,
            used,
            limit,
            pctUsed: Math.round(pct),
          });
        }
      }
      byFeature.set(r.feature, agg);
    }

    pressure.sort((a, b) => b.pctUsed - a.pctUsed || b.used - a.used);
    const top = pressure.slice(0, 50);

    const names = await soft(
      'quotas:names',
      async () => {
        const ids = [...new Set(top.map((p) => p.userId))];
        if (ids.length === 0) return new Map<string, { name: string | null; plan: string }>();
        const found = await rows<{ id: string; display_name: string | null; plan: string }>((db) =>
          db.from('users').select('id, display_name, plan').in('id', ids),
        );
        return new Map(found.map((u) => [u.id, { name: u.display_name, plan: u.plan }]));
      },
      new Map<string, { name: string | null; plan: string }>(),
    );

    return {
      period,
      resetAt: periodResetAtIso(),
      truncated,
      byFeature: [...byFeature.values()].sort((a, b) => b.atLimit - a.atLimit || b.rows - a.rows),
      pressure: top.map((p) => ({
        ...p,
        displayName: names.get(p.userId)?.name ?? null,
        plan: names.get(p.userId)?.plan ?? null,
      })),
    };
  });

  // ==========================================================================
  // 10–11. GET /admin/membership — plan mix + renewals (10), live boosts (11)
  //
  // Plan mix uses one HEAD count per plan value instead of selecting `users`
  // and grouping in JS: a plain select is capped at 1000 rows by PostgREST and
  // would silently undercount the moment the product passes that (the exact
  // failure migration 026 was written to fix).
  //
  // Counted by the RAW users.plan value, then folded to the normalized plan, so
  // legacy 'team' rows are visible as themselves AND correctly rolled into
  // premium — hiding the raw value would make a 'team' row look like it
  // vanished.
  // ==========================================================================
  const RAW_PLAN_VALUES = ['free', 'pro', 'premium', 'team'] as const;
  interface PlanCount {
    raw: (typeof RAW_PLAN_VALUES)[number];
    count: number;
  }

  app.get('/admin/membership', async () => {
    const nowIso = new Date().toISOString();
    const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const count = async (
      build: (db: SupabaseClient) => PromiseLike<{ count: number | null; error: unknown }>,
    ): Promise<number> => {
      const { count: n, error } = await build(app.supabase);
      if (error) throw error;
      return Number(n ?? 0);
    };

    const [planCounts, subs, renew7, renew30, boostRows, addonActive] = await Promise.all([
      soft<PlanCount[]>(
        'membership:planmix',
        async () => {
          const counts = await Promise.all(
            RAW_PLAN_VALUES.map((p) =>
              count((db) =>
                db.from('users').select('id', { count: 'exact', head: true }).eq('plan', p),
              ),
            ),
          );
          return RAW_PLAN_VALUES.map((raw, i) => ({ raw, count: counts[i] ?? 0 }));
        },
        [],
      ),
      soft(
        'membership:subscriptions',
        () =>
          rows<{
            id: string;
            user_id: string;
            plan: string;
            billing_cycle: string;
            price_thb: number;
            status: string;
            current_period_end: string;
            cancelled_at: string | null;
          }>((db) =>
            db
              .from('subscriptions')
              .select('id, user_id, plan, billing_cycle, price_thb, status, current_period_end, cancelled_at')
              .eq('status', 'active')
              .order('current_period_end', { ascending: true })
              .limit(50),
          ),
        [],
      ),
      soft(
        'membership:renew7',
        () =>
          count((db) =>
            db
              .from('subscriptions')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active')
              .gte('current_period_end', nowIso)
              .lt('current_period_end', in7),
          ),
        0,
      ),
      soft(
        'membership:renew30',
        () =>
          count((db) =>
            db
              .from('subscriptions')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active')
              .gte('current_period_end', nowIso)
              .lt('current_period_end', in30),
          ),
        0,
      ),
      // Live boost = not released AND not expired, evaluated at read time. The
      // daily expiry job stamps released_at, but a boost must stop counting the
      // instant it expires whether or not that job has run yet.
      soft(
        'membership:boosts',
        () =>
          rows<{ id: string; user_id: string; group_id: string; activated_at: string; expires_at: string }>(
            (db) =>
              db
                .from('user_group_boosts')
                .select('id, user_id, group_id, activated_at, expires_at')
                .is('released_at', null)
                .gt('expires_at', nowIso)
                .order('expires_at', { ascending: true })
                .limit(100),
          ),
        [],
      ),
      soft(
        'membership:addon',
        () =>
          count((db) =>
            db
              .from('diary_addon_subscriptions')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active')
              .gt('expires_at', nowIso),
          ),
        0,
      ),
    ]);

    // Fold the raw values onto the three canonical plans.
    const normalized = new Map<Plan, number>(PLANS.map((p) => [p, 0]));
    for (const { raw, count: n } of planCounts) {
      const p = normalizePlan(raw);
      normalized.set(p, (normalized.get(p) ?? 0) + n);
    }
    const totalUsers = planCounts.reduce((n, p) => n + p.count, 0);

    const subUserIds = [...new Set([...subs.map((s) => s.user_id), ...boostRows.map((b) => b.user_id)])];
    const names = await soft(
      'membership:names',
      async () => {
        if (subUserIds.length === 0) return new Map<string, string | null>();
        const found = await rows<{ id: string; display_name: string | null }>((db) =>
          db.from('users').select('id, display_name').in('id', subUserIds),
        );
        return new Map(found.map((u) => [u.id, u.display_name]));
      },
      new Map<string, string | null>(),
    );

    // MRR from ACTIVE rows only, normalised to a monthly figure so a yearly and
    // a monthly subscriber are comparable. Bounded by the same 50-row page as
    // `subs`, so it is a floor, not an audited total — labelled as such.
    const mrrThb = subs.reduce(
      (sum, s) => sum + (s.billing_cycle === 'yearly' ? Number(s.price_thb) / 12 : Number(s.price_thb)),
      0,
    );

    return {
      totalUsers,
      planMix: PLANS.map((plan) => ({
        plan,
        count: normalized.get(plan) ?? 0,
        pct: totalUsers > 0 ? Math.round(((normalized.get(plan) ?? 0) / totalUsers) * 100) : 0,
      })),
      // Kept alongside the folded mix so a legacy 'team' row stays visible.
      rawPlanCounts: planCounts,
      renewals: {
        activeSubscriptions: subs.length,
        dueIn7Days: renew7,
        dueIn30Days: renew30,
        mrrThb: Math.round(mrrThb),
        mrrIsBounded: subs.length >= 50,
      },
      subscriptions: subs.map((s) => ({
        id: s.id,
        userId: s.user_id,
        displayName: names.get(s.user_id) ?? null,
        plan: s.plan,
        billingCycle: s.billing_cycle,
        priceThb: Number(s.price_thb),
        status: s.status,
        currentPeriodEnd: s.current_period_end,
        cancelledAt: s.cancelled_at,
      })),
      boosts: boostRows.map((b) => ({
        id: b.id,
        userId: b.user_id,
        displayName: names.get(b.user_id) ?? null,
        groupId: b.group_id,
        activatedAt: b.activated_at,
        expiresAt: b.expires_at,
      })),
      diaryAddonActive: addonActive,
      // Surfaced so the page can show what a plan is entitled to next to what
      // it is using, without hardcoding the matrix a second time in the client.
      monthlyQuotas: MONTHLY_QUOTAS,
    };
  });

  // ==========================================================================
  // 12. GET /admin/support/tickets?status=open — the SLA queue
  //
  // `due_at` and `sla_hours` are STORED on the ticket (migration 051), not
  // derived from the user's current plan: the promise made when the ticket was
  // opened must not change because the user downgraded afterwards. This
  // endpoint therefore never consults plans.ts — it reports what was promised.
  //
  // NOTE: POST/GET /support/* are 503-disabled today (no admin reply surface
  // exists). This is the read side that closes that gap, and it is deliberately
  // read-only — answering a ticket is still not possible from here.
  // ==========================================================================
  const TICKET_STATUSES = ['open', 'answered', 'closed'] as const;

  app.get<{ Querystring: { status?: string } }>('/admin/support/tickets', async (request) => {
    const requested = request.query.status;
    const status = (TICKET_STATUSES as readonly string[]).includes(requested ?? '')
      ? (requested as (typeof TICKET_STATUSES)[number])
      : 'open';

    const tickets = await soft(
      'support:tickets',
      () =>
        rows<{
          id: string;
          user_id: string;
          subject: string;
          plan_at_creation: string;
          sla_hours: number;
          due_at: string;
          onboarding_call: boolean;
          status: string;
          first_response_at: string | null;
          created_at: string;
        }>((db) =>
          db
            .from('support_tickets')
            .select(
              'id, user_id, subject, plan_at_creation, sla_hours, due_at, onboarding_call, status, first_response_at, created_at',
            )
            .eq('status', status)
            // Closest to breaching first — the order an ops queue is worked in.
            .order('due_at', { ascending: true })
            .limit(100),
        ),
      [],
    );

    const names = await soft(
      'support:names',
      async () => {
        const ids = [...new Set(tickets.map((t) => t.user_id))];
        if (ids.length === 0) return new Map<string, string | null>();
        const found = await rows<{ id: string; display_name: string | null }>((db) =>
          db.from('users').select('id, display_name').in('id', ids),
        );
        return new Map(found.map((u) => [u.id, u.display_name]));
      },
      new Map<string, string | null>(),
    );

    const now = Date.now();
    const mapped = tickets.map((t) => {
      const dueMs = new Date(t.due_at).getTime();
      // An ANSWERED ticket is judged on when it was answered, not on now — a
      // ticket answered inside its window never becomes a breach later.
      const settledMs = t.first_response_at ? new Date(t.first_response_at).getTime() : now;
      return {
        id: t.id,
        userId: t.user_id,
        displayName: names.get(t.user_id) ?? null,
        subject: t.subject,
        planAtCreation: t.plan_at_creation,
        slaHours: Number(t.sla_hours),
        dueAt: t.due_at,
        onboardingCall: t.onboarding_call,
        status: t.status,
        firstResponseAt: t.first_response_at,
        createdAt: t.created_at,
        breached: settledMs > dueMs,
        hoursRemaining: Math.round(((dueMs - now) / 3_600_000) * 10) / 10,
      };
    });

    return {
      status,
      tickets: mapped,
      breachedCount: mapped.filter((t) => t.breached).length,
    };
  });

  // ==========================================================================
  // 14–15. GET /admin/system/stuck-files — wedged uploads (14) + ledger (15)
  //
  // "Stuck" = still 'pending' or 'processing' well after the batch that created
  // it should have settled. `upload_batch` retries internally and never throws,
  // so a row left in 'processing' means the WORKER died mid-file — the one
  // failure mode that leaves no failed job in Redis to find. That is exactly
  // what makes this list worth having next to the queue table.
  //
  // 30 minutes is the threshold: the debounce window is 1.5 s and the longest
  // legitimate job (finalize_scan with OCR over many pages) is minutes, so
  // anything past half an hour is not slow, it is abandoned. Purged rows are
  // excluded — a tombstone keeps its last status forever and would pin the
  // count permanently.
  // ==========================================================================
  const STUCK_AFTER_MINUTES = 30;

  app.get('/admin/system/stuck-files', async () => {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString();

    const [totalsRow, stuck, errored] = await Promise.all([
      soft(
        'stuck:totals',
        async () => {
          const list = await rows<Record<string, number>>((db) => db.rpc('admin_storage_totals'));
          return list[0] ?? null;
        },
        null,
      ),
      soft(
        'stuck:files',
        () =>
          rows<{
            id: string;
            original_name: string;
            status: string;
            file_size: number;
            space_id: string | null;
            uploaded_by: string | null;
            line_source: string | null;
            created_at: string;
          }>((db) =>
            db
              .from('files')
              .select('id, original_name, status, file_size, space_id, uploaded_by, line_source, created_at')
              .in('status', ['pending', 'processing'])
              .is('purged_at', null)
              .lt('created_at', cutoff)
              .order('created_at', { ascending: true })
              .limit(100),
          ),
        [],
      ),
      soft(
        'stuck:errored',
        () =>
          rows<{
            id: string;
            original_name: string;
            status: string;
            file_size: number;
            uploaded_by: string | null;
            created_at: string;
          }>((db) =>
            db
              .from('files')
              .select('id, original_name, status, file_size, uploaded_by, created_at')
              .eq('status', 'error')
              .is('purged_at', null)
              .order('created_at', { ascending: false })
              .limit(50),
          ),
        [],
      ),
    ]);

    const num = (k: string): number => Number(totalsRow?.[k] ?? 0);

    return {
      thresholdMinutes: STUCK_AFTER_MINUTES,
      ledger: {
        liveFiles: num('live_files'),
        liveBytes: num('live_bytes'),
        trashedFiles: num('trashed_files'),
        trashedBytes: num('trashed_bytes'),
        purgedFiles: num('purged_files'),
        processingFiles: num('processing_files'),
        errorFiles: num('error_files'),
        vaultLiveFiles: num('vault_live_files'),
        vaultLiveBytes: num('vault_live_bytes'),
        usersTotal: num('users_total'),
        usersOver80: num('users_over_80'),
        usersOverLimit: num('users_over_limit'),
        storageUsedSum: num('storage_used_sum'),
        storageLimitSum: num('storage_limit_sum'),
        // null when the RPC is missing (migration 058 not applied) so the page
        // renders "—" instead of a confident zero.
        available: totalsRow !== null,
      },
      stuck: stuck.map((f) => ({
        id: f.id,
        name: f.original_name,
        status: f.status,
        bytes: Number(f.file_size ?? 0),
        spaceId: f.space_id,
        uploadedBy: f.uploaded_by,
        lineSource: f.line_source,
        createdAt: f.created_at,
        stuckMinutes: Math.round((Date.now() - new Date(f.created_at).getTime()) / 60_000),
      })),
      errored: errored.map((f) => ({
        id: f.id,
        name: f.original_name,
        status: f.status,
        bytes: Number(f.file_size ?? 0),
        uploadedBy: f.uploaded_by,
        createdAt: f.created_at,
      })),
    };
  });

  // ==========================================================================
  // TIER 2 — the OPS write actions. Read the fail-soft caveat in the file
  // header first: none of the four below may be wrapped in `soft()`.
  // ==========================================================================

  // --------------------------------------------------------------------------
  // GET /admin/settings — the product-wide switches.
  //
  // Reads UNCACHED. getPushEnabled()'s 60 s Redis cache exists to keep the push
  // path cheap; showing an admin a value that may be a minute stale — on the
  // very page whose job is to tell them what the setting is — would make a flip
  // look like it did not take.
  //
  // This is the one endpoint in the file that answers 500 on a read failure
  // rather than degrading, and deliberately so: a toggle rendered from a
  // fabricated default is a switch that lies about its own position.
  // --------------------------------------------------------------------------
  app.get('/admin/settings', async () => {
    const pushEnabled = await readPushEnabledUncached(app.supabase);
    return { push_enabled: pushEnabled };
  });

  // --------------------------------------------------------------------------
  // PUT /admin/settings/push_enabled — the global LINE push kill switch.
  //
  // Composes with TASK_NOTIFICATIONS_ENABLED rather than replacing it: that env
  // flag gates SCHEDULING at deploy time, this row gates DELIVERY at incident
  // time and takes effect on jobs already queued (see push-flag.service.ts).
  //
  // Idempotent — setting the value it already holds writes, audits and returns
  // 200. Auditing the no-op is deliberate: "an admin asserted push should be
  // off at 02:14" is exactly the kind of thing an incident timeline needs, and
  // suppressing it would lose that.
  // --------------------------------------------------------------------------
  app.put('/admin/settings/push_enabled', async (request, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const next = parsed.data.enabled;

    // Captured BEFORE the write so the compensating revert has a real prior
    // value rather than assuming it was the negation (a no-op flip would then
    // revert to the wrong thing).
    const before = await readPushEnabledUncached(app.supabase);

    try {
      // setPushEnabled writes the row, invalidates the cache and audits, in
      // that order. It throws AdminAuditError when the audit insert fails.
      await setPushEnabled(next, app.supabase, actor(request));
    } catch (err) {
      const { error: revertErr } = await app.supabase
        .from('system_settings')
        .upsert(
          { key: 'push_enabled', value: before, updated_at: new Date().toISOString() },
          { onConflict: 'key' },
        );
      if (revertErr) {
        // The narrow hole in the compensation design: the write stands and is
        // unaudited. This log line IS the recovery path, so it carries both
        // values rather than just the error.
        app.log.error(
          { err: revertErr, before, attempted: next },
          'push_enabled revert FAILED — the switch is applied but unaudited',
        );
      }
      // Re-invalidate regardless: the revert changed what the DB says, and the
      // cache was populated (or cleared) against the value being undone.
      await invalidatePushEnabledCache();
      throw err;
    }

    return { push_enabled: next };
  });

  // --------------------------------------------------------------------------
  // POST /admin/system/queues/:queue/jobs/:jobId/{retry,remove}
  //
  // Both refuse anything that is not in the FAILED set — the reasoning (an
  // active job's payload pulled from under a running worker, a delayed reminder
  // promoted to fire early) is in queue-actions.service.ts.
  //
  // AUDIT ORDERING IS INVERTED HERE. Every other TIER 2 write reads, writes,
  // audits and reverts on failure. A removed BullMQ job cannot be put back, so
  // these two audit FIRST and act second: a failed audit insert then means
  // nothing happened at all. The cost is that a crash between the two leaves an
  // audit row for an action that did not occur, which is the safe direction.
  // Both hold the job's summary in `before`, since after a removal there is
  // nothing left to describe.
  // --------------------------------------------------------------------------
  const QUEUE_PARAM = z.enum(QUEUE_KEYS);

  interface JobActionParams {
    queue: string;
    jobId: string;
  }

  /** Map a queue-action result onto its HTTP answer. One place, both routes. */
  function jobActionFailure(
    result: Exclude<Awaited<ReturnType<typeof retryFailedJob>>, { ok: true }>,
  ): { code: number; body: Record<string, unknown> } {
    switch (result.reason) {
      case 'not_found':
        return { code: 404, body: { error: 'Job not found', code: 'JOB_NOT_FOUND' } };
      case 'not_failed':
        return {
          code: 409,
          body: { error: 'job is not failed', code: 'JOB_NOT_FAILED', state: result.state },
        };
      case 'queue_unavailable':
        return { code: 503, body: { error: 'Queue unavailable', code: 'QUEUE_UNAVAILABLE' } };
      default:
        return { code: 502, body: { error: 'Queue operation failed', code: 'QUEUE_ERROR' } };
    }
  }

  app.post<{ Params: JobActionParams }>(
    '/admin/system/queues/:queue/jobs/:jobId/retry',
    async (request, reply) => {
      const parsed = QUEUE_PARAM.safeParse(request.params.queue);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Unknown queue', queue: request.params.queue });
      }
      const key: QueueKey = parsed.data;
      const jobId = request.params.jobId;

      const snapshot = await summariseJob(app.fileQueue, key, jobId);
      if (!snapshot) return reply.code(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });

      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'job_retry',
        targetType: 'job',
        targetId: `${key}:${jobId}`,
        before: { queue: key, ...snapshot },
        after: { queue: key, requeued: true },
      });

      const result = await retryFailedJob(app.fileQueue, key, jobId);
      if (!result.ok) {
        const { code, body } = jobActionFailure(result);
        // The audit row stays. It records an authorised attempt, which is true
        // and is what an "why is there a retry row but the job is still failed?"
        // question needs to see.
        return reply.code(code).send(body);
      }
      return { ok: true };
    },
  );

  app.post<{ Params: JobActionParams }>(
    '/admin/system/queues/:queue/jobs/:jobId/remove',
    async (request, reply) => {
      const parsed = QUEUE_PARAM.safeParse(request.params.queue);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Unknown queue', queue: request.params.queue });
      }
      const key: QueueKey = parsed.data;
      const jobId = request.params.jobId;

      const snapshot = await summariseJob(app.fileQueue, key, jobId);
      if (!snapshot) return reply.code(404).send({ error: 'Job not found', code: 'JOB_NOT_FOUND' });

      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'job_remove',
        targetType: 'job',
        targetId: `${key}:${jobId}`,
        before: { queue: key, ...snapshot },
        // null, not an object: the job no longer exists, and "removed" is the
        // whole of its resulting state.
        after: null,
      });

      const result = await removeFailedJob(app.fileQueue, key, jobId);
      if (!result.ok) {
        const { code, body } = jobActionFailure(result);
        return reply.code(code).send(body);
      }
      return { ok: true };
    },
  );

  // --------------------------------------------------------------------------
  // PATCH /admin/support/tickets/:id — the reply/close half of the SLA queue.
  //
  // This is the admin surface whose absence 503-disabled POST/GET /support/*
  // (see "Temporarily Disabled Endpoints" in CLAUDE.md). It does NOT re-enable
  // those routes — intake stays closed, and closing that loop is a separate
  // decision — but it is the half that was missing.
  //
  // `reply` HAS NO COLUMN, and one is not being added here. support_tickets
  // (migration 051) has subject/body/status/first_response_at and no thread. So
  // the reply text is recorded in the AUDIT ROW's `after`, which is a real,
  // queryable record of what was said and by whom, and first_response_at is
  // stamped because that is what "we responded" MEANS to the SLA clock. A
  // proper reply thread is a schema decision, not something to smuggle in as a
  // side effect of a triage endpoint.
  //
  // 409 on an already-closed ticket: reopening is not a transition this
  // endpoint offers, and silently editing a closed ticket would move a
  // first_response_at that a settled SLA was already judged against.
  //
  // The response omits `body` — the user's own free text has no business being
  // echoed back into an admin payload that nothing renders.
  // --------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>('/admin/support/tickets/:id', async (request, reply) => {
    const parsed = z
      .object({
        status: z.enum(['answered', 'closed']).optional(),
        reply: z.string().max(2000).optional(),
      })
      .refine((d) => d.status !== undefined || d.reply !== undefined, {
        message: 'Provide status, reply, or both',
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const { status: nextStatus, reply: replyText } = parsed.data;
    const ticketId = request.params.id;

    const { data: current, error: readErr } = await app.supabase
      .from('support_tickets')
      .select('id, user_id, subject, status, first_response_at, sla_hours, due_at, plan_at_creation, created_at')
      .eq('id', ticketId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) return reply.code(404).send({ error: 'Ticket not found' });

    const before = current as {
      id: string;
      user_id: string;
      subject: string;
      status: string;
      first_response_at: string | null;
      sla_hours: number;
      due_at: string;
      plan_at_creation: string;
      created_at: string;
    };

    if (before.status === 'closed') {
      return reply
        .code(409)
        .send({ error: 'Ticket is already closed', code: 'TICKET_CLOSED' });
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updated_at: now };
    if (nextStatus !== undefined) patch.status = nextStatus;
    // Stamped once and never moved: the SLA is judged on the FIRST response, so
    // a second edit must not reset the clock in the admin's favour.
    if (before.first_response_at === null) patch.first_response_at = now;

    const { data: updated, error: updErr } = await app.supabase
      .from('support_tickets')
      .update(patch)
      .eq('id', ticketId)
      .select('id, user_id, subject, status, first_response_at, sla_hours, due_at, plan_at_creation, created_at')
      .maybeSingle();
    if (updErr) throw updErr;
    if (!updated) return reply.code(404).send({ error: 'Ticket not found' });

    const after = updated as typeof before;

    try {
      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'support_ticket_update',
        targetType: 'ticket',
        targetId: ticketId,
        before: { status: before.status, firstResponseAt: before.first_response_at },
        after: {
          status: after.status,
          firstResponseAt: after.first_response_at,
          // The only place the reply text is persisted at all — see the note
          // above. Omitted entirely when none was sent, so a bare status change
          // does not record an empty reply.
          ...(replyText !== undefined ? { reply: replyText } : {}),
        },
      });
    } catch (err) {
      await app.supabase
        .from('support_tickets')
        .update({ status: before.status, first_response_at: before.first_response_at })
        .eq('id', ticketId);
      throw err;
    }

    return {
      ticket: {
        id: after.id,
        userId: after.user_id,
        subject: after.subject,
        status: after.status,
        firstResponseAt: after.first_response_at,
        slaHours: Number(after.sla_hours),
        dueAt: after.due_at,
        planAtCreation: after.plan_at_creation,
        createdAt: after.created_at,
      },
    };
  });
};

export default adminOpsRoutes;
