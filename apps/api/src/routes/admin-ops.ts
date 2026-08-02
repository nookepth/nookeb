import type { FastifyPluginAsync } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
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
 * Nothing here mutates. There is no retry-job, no drain, no ticket reply — the
 * page observes, and every write path stays where it already lives.
 */
const adminOpsRoutes: FastifyPluginAsync = async (app) => {
  registerAdminGuard(app);

  const clampDays = (raw: string | undefined): number =>
    Math.min(Math.max(Number(raw) || 30, 1), 90);

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
};

export default adminOpsRoutes;
