import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SpaceRecord, UserRecord } from '@nookeb/shared';
import { isAdminLineUser } from '../config';
import { registerAdminGuard } from '../middleware/adminGuard';
import { currentPeriodStart } from '../config/billing-period';
import { MONTHLY_FEATURES, normalizePlan, type MonthlyFeature, type Plan } from '../config/plans';
import { listMonthlyQuotas } from '../services/quota.service';
import { reconcileBoostsForPlan, syncStorageLimit } from '../services/membership.service';
import { requireAdminAction } from '../services/admin-audit.service';

/**
 * The RAW values `users.plan` may hold. Wider than PLANS (the three canonical
 * plans) because migration 051's CHECK still accepts the legacy 'team', and
 * normalizePlan folds it onto premium. An admin must be able to see and set the
 * raw value — hiding 'team' behind normalization would make an existing row
 * un-editable without also silently rewriting it.
 */
const RAW_PLAN_VALUES = ['free', 'pro', 'premium', 'team'] as const;
type RawPlanValue = (typeof RAW_PLAN_VALUES)[number];

/** Locker ceiling an admin may set by hand: 1 TiB. */
const MAX_STORAGE_OVERRIDE_BYTES = 1_099_511_627_776;

const adminRoutes: FastifyPluginAsync = async (app) => {
  registerAdminGuard(app);

  /**
   * The acting admin's LINE user id, for the audit row.
   *
   * Non-null by construction: registerAdminGuard runs app.authenticate before
   * any handler, so `authUser` is always populated here. The helper exists so
   * the non-null assertion is written once rather than at eight call sites.
   */
  const actor = (request: FastifyRequest): string => request.authUser!.lineUserId;

  // GET /admin/users — all users with storage + file counts
  app.get('/admin/users', async () => {
    const { data: users, error } = await app.supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Count files per user in SQL (GROUP BY) — a plain select is capped at
    // 1000 rows by PostgREST, which would silently undercount.
    const { data: counts, error: fErr } = await app.supabase.rpc('admin_file_counts_by_user');
    if (fErr) throw fErr;
    const countByUser = new Map<string, number>();
    for (const row of (counts as { uploaded_by: string; file_count: number }[] | null) ?? []) {
      countByUser.set(row.uploaded_by, Number(row.file_count));
    }

    return {
      users: (users as UserRecord[]).map((u) => ({
        id: u.id,
        lineUserId: u.line_user_id,
        displayName: u.display_name,
        plan: u.plan,
        storageUsed: u.storage_used,
        storageLimit: u.storage_limit,
        fileCount: countByUser.get(u.id) ?? 0,
        createdAt: u.created_at,
        isAdmin: isAdminLineUser(u.line_user_id),
      })),
    };
  });

  // GET /admin/spaces — all spaces with member + file counts
  app.get('/admin/spaces', async () => {
    const { data: spaces, error } = await app.supabase
      .from('spaces')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const { data: members, error: mErr } = await app.supabase
      .from('space_members')
      .select('space_id');
    if (mErr) throw mErr;
    const memberCount = new Map<string, number>();
    for (const m of members ?? []) {
      const k = m.space_id as string;
      memberCount.set(k, (memberCount.get(k) ?? 0) + 1);
    }

    // Count + sum file sizes per space in SQL (GROUP BY) — a plain select is
    // capped at 1000 rows by PostgREST, which would silently undercount.
    const { data: statRows, error: fErr } = await app.supabase.rpc('admin_file_stats_by_space');
    if (fErr) throw fErr;
    const fileStats = new Map<string, { count: number; bytes: number }>();
    for (const row of (statRows as
      | { space_id: string; file_count: number; total_bytes: number }[]
      | null) ?? []) {
      fileStats.set(row.space_id, {
        count: Number(row.file_count),
        bytes: Number(row.total_bytes),
      });
    }

    return {
      spaces: (spaces as SpaceRecord[]).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        lineGroupId: s.line_group_id,
        memberCount: memberCount.get(s.id) ?? 0,
        fileCount: fileStats.get(s.id)?.count ?? 0,
        bytes: fileStats.get(s.id)?.bytes ?? 0,
        createdAt: s.created_at,
      })),
    };
  });

  // ==========================================================================
  // Product analytics (migration 029 / usage_events). These read the append-only
  // event log through the admin_* aggregate RPCs. If the migration hasn't been
  // applied yet the RPCs 404 — each endpoint fails soft to empty/zero so the
  // dashboard renders "no data yet" instead of erroring.
  // ==========================================================================

  const DAY_MS = 24 * 60 * 60 * 1000;
  const sinceIso = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

  // GET /admin/overview — the KPI header: active users, growth, engagement,
  // and the buy-signal counter, in one round trip.
  app.get('/admin/overview', async () => {
    const [countsRes, summary7Res, usersRes, retentionRes] = await Promise.all([
      app.supabase.rpc('admin_active_user_counts'),
      app.supabase.rpc('admin_event_summary', { p_since: sinceIso(7) }),
      app.supabase.from('users').select('id, created_at'),
      app.supabase.rpc('admin_retention', { p_cohort_days: 30, p_min_age_days: 7 }),
    ]);

    const counts = (countsRes.data as { dau: number; wau: number; mau: number }[] | null)?.[0] ?? {
      dau: 0,
      wau: 0,
      mau: 0,
    };
    const summary7 =
      (summary7Res.data as { event_type: string; unique_users: number; event_count: number }[] | null) ??
      [];
    const allUsers = (usersRes.data as { id: string; created_at: string }[] | null) ?? [];
    const retention = (retentionRes.data as
      | { cohort_size: number; d1_returned: number; d7_returned: number }[]
      | null)?.[0] ?? { cohort_size: 0, d1_returned: 0, d7_returned: 0 };

    const now = Date.now();
    const newUsers7 = allUsers.filter((u) => now - new Date(u.created_at).getTime() <= 7 * DAY_MS).length;
    const newUsers30 = allUsers.filter((u) => now - new Date(u.created_at).getTime() <= 30 * DAY_MS).length;

    const quotaBlocks7 =
      summary7.find((s) => s.event_type === 'feature_blocked_quota')?.event_count ?? 0;

    // Stickiness — the share of monthly users who show up on a given day. >20% is
    // healthy for a utility; it's the single best "is this a habit" number.
    const stickiness = counts.mau > 0 ? Math.round((counts.dau / counts.mau) * 100) : 0;

    return {
      totalUsers: allUsers.length,
      newUsers7,
      newUsers30,
      dau: counts.dau,
      wau: counts.wau,
      mau: counts.mau,
      stickiness, // percent
      quotaBlocks7, // buy signal — how many quota walls hit in 7 days
      retention, // { cohort_size, d1_returned, d7_returned }
    };
  });

  // GET /admin/timeseries?days=30 — daily active users, events, and new signups
  // for the growth chart. Merged into one array of { day, activeUsers, events, newUsers }.
  app.get<{ Querystring: { days?: string } }>('/admin/timeseries', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 7), 90);
    const [activeRes, newRes] = await Promise.all([
      app.supabase.rpc('admin_active_users_daily', { p_days: days }),
      app.supabase.rpc('admin_new_users_daily', { p_days: days }),
    ]);

    const active =
      (activeRes.data as { day: string; active_users: number; events: number }[] | null) ?? [];
    const news = (newRes.data as { day: string; new_users: number }[] | null) ?? [];
    const newByDay = new Map(news.map((n) => [n.day, Number(n.new_users)]));

    const byDay = new Map<string, { day: string; activeUsers: number; events: number; newUsers: number }>();
    for (const a of active) {
      byDay.set(a.day, {
        day: a.day,
        activeUsers: Number(a.active_users),
        events: Number(a.events),
        newUsers: newByDay.get(a.day) ?? 0,
      });
    }
    for (const n of news) {
      if (!byDay.has(n.day)) {
        byDay.set(n.day, { day: n.day, activeUsers: 0, events: 0, newUsers: Number(n.new_users) });
      }
    }
    const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    return { days, series };
  });

  // GET /admin/features?days=30 — feature-adoption table: per event_type, how
  // many distinct users used it and how many times, plus a naive scan→done and
  // convert-arm→done funnel completion rate computed from the same rows.
  app.get<{ Querystring: { days?: string } }>('/admin/features', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const { data } = await app.supabase.rpc('admin_event_summary', { p_since: sinceIso(days) });
    const rows =
      (data as { event_type: string; unique_users: number; event_count: number }[] | null) ?? [];
    const count = (t: string): number => rows.find((r) => r.event_type === t)?.event_count ?? 0;

    const funnels = [
      {
        name: 'สแกน → เสร็จ (PDF)',
        started: count('cmd_scan'),
        completed: count('scan_done'),
      },
      {
        name: 'แปลงไฟล์ → ได้ Word',
        started: count('cmd_convert_arm'),
        completed: count('docx_done'),
      },
      {
        name: 'ไดอารี่ → บันทึกสำเร็จ',
        started: count('cmd_diary_arm'),
        completed: count('diary_done'),
      },
    ].map((f) => ({
      ...f,
      completionRate: f.started > 0 ? Math.round((f.completed / f.started) * 100) : null,
    }));

    return {
      days,
      features: rows.map((r) => ({
        eventType: r.event_type,
        uniqueUsers: Number(r.unique_users),
        eventCount: Number(r.event_count),
      })),
      funnels,
    };
  });

  // GET /admin/power-users?days=30 — the revenue-signal leaderboard (most active
  // users + their quota-wall hits and paid-feature usage). The "who to talk to
  // / who's ready for a paid plan" list.
  app.get<{ Querystring: { days?: string } }>('/admin/power-users', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const { data } = await app.supabase.rpc('admin_power_users', {
      p_since: sinceIso(days),
      p_limit: 20,
    });
    const rows =
      (data as
        | {
            user_id: string;
            display_name: string | null;
            storage_used: number;
            storage_limit: number;
            total_events: number;
            quota_blocks: number;
            docx_converts: number;
            last_active: string;
          }[]
        | null) ?? [];
    return {
      days,
      users: rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        storageUsed: Number(r.storage_used),
        storageLimit: Number(r.storage_limit),
        totalEvents: Number(r.total_events),
        quotaBlocks: Number(r.quota_blocks),
        docxConverts: Number(r.docx_converts),
        lastActive: r.last_active,
      })),
    };
  });

  // GET /admin/pro-interest?days=30 — the gift-box fake-door demand test:
  // anonymous tap counts only, so no views, no dedup and no conversion % are
  // derivable here (the source table has no user_id).
  //
  // The task half of this panel (task_auto_reminder / task_voice_command, the
  // deduped view→click funnel over admin_pro_interest_tasks) was removed with
  // those two fake doors; historical pro_interest rows are left untouched.
  app.get<{ Querystring: { days?: string } }>('/admin/pro-interest', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const [giftboxRes, dailyRes] = await Promise.all([
      app.supabase.rpc('admin_pro_interest_giftbox', { p_since: sinceIso(days) }),
      app.supabase.rpc('admin_pro_interest_daily', { p_days: days }),
    ]);

    const giftRows = (giftboxRes.data as { feature: string; taps: number }[] | null) ?? [];
    const dailyRows = (dailyRes.data as { day: string; giftbox_taps: number }[] | null) ?? [];

    return {
      days,
      giftbox: giftRows
        .map((r) => ({ feature: r.feature, taps: Number(r.taps) }))
        .sort((a, b) => b.taps - a.taps),
      daily: dailyRows.map((r) => ({
        day: r.day,
        giftboxTaps: Number(r.giftbox_taps),
      })),
    };
  });

  // GET /admin/tasks?days=30 — ระบบตามงาน dashboard: creation-by-type (daily +
  // totals), current status breakdown, ICS downloads, and completion timing.
  app.get<{ Querystring: { days?: string } }>('/admin/tasks', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const [summaryRes, dailyRes] = await Promise.all([
      app.supabase.rpc('admin_tasks_summary', { p_since: sinceIso(days) }),
      app.supabase.rpc('admin_tasks_daily', { p_days: days }),
    ]);

    const s = (summaryRes.data as
      | {
          total_created: number;
          type_single: number;
          type_multi: number;
          type_recurring: number;
          status_pending: number;
          status_progress: number;
          status_done: number;
          status_cancelled: number;
          ics_downloads: number;
          mark_done_count: number;
          avg_complete_sec: number | null;
        }[]
      | null)?.[0] ?? {
      total_created: 0,
      type_single: 0,
      type_multi: 0,
      type_recurring: 0,
      status_pending: 0,
      status_progress: 0,
      status_done: 0,
      status_cancelled: 0,
      ics_downloads: 0,
      mark_done_count: 0,
      avg_complete_sec: null,
    };
    const dailyRows =
      (dailyRes.data as { day: string; single: number; multi: number; recurring: number }[] | null) ??
      [];

    const totalCreated = Number(s.total_created);
    const typeRecurring = Number(s.type_recurring);
    const statusDone = Number(s.status_done);
    // Completion % over COMPLETABLE tasks only: recurring never reaches 'done'
    // (self-reschedules forever), so excluding it keeps the rate honest.
    const completable = totalCreated - typeRecurring;

    return {
      days,
      totals: {
        totalCreated,
        byType: {
          single: Number(s.type_single),
          multi: Number(s.type_multi),
          recurring: typeRecurring,
        },
        byStatus: {
          pending: Number(s.status_pending),
          inProgress: Number(s.status_progress),
          done: statusDone,
          cancelled: Number(s.status_cancelled),
        },
        completionRate: completable > 0 ? Math.round((statusDone / completable) * 100) : null,
        icsDownloads: Number(s.ics_downloads),
        markDoneCount: Number(s.mark_done_count),
        avgCompleteSec: s.avg_complete_sec === null ? null : Math.round(Number(s.avg_complete_sec)),
      },
      daily: dailyRows.map((r) => ({
        day: r.day,
        single: Number(r.single),
        multi: Number(r.multi),
        recurring: Number(r.recurring),
      })),
    };
  });

  // GET /admin/funnel?days=30 — the 6-stage product funnel + weekly D1/D7/D30
  // retention cohorts. DAU/WAU/MAU already live in /admin/overview.
  app.get<{ Querystring: { days?: string } }>('/admin/funnel', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const weeks = Math.min(Math.max(Math.ceil(days / 7), 4), 12);
    const [funnelRes, cohortsRes] = await Promise.all([
      app.supabase.rpc('admin_funnel_overview', { p_days: days }),
      app.supabase.rpc('admin_retention_cohorts', { p_weeks: weeks }),
    ]);

    const f = (funnelRes.data as
      | {
          awareness: number;
          consideration: number;
          conversion: number;
          activation: number;
          referral: number;
          retention: number;
        }[]
      | null)?.[0] ?? {
      awareness: 0,
      consideration: 0,
      conversion: 0,
      activation: 0,
      referral: 0,
      retention: 0,
    };
    const cohortRows =
      (cohortsRes.data as
        | { cohort_week: string; cohort_size: number; d1_n: number; d7_n: number; d30_n: number }[]
        | null) ?? [];

    return {
      days,
      funnel: [
        { stage: 'awareness', count: Number(f.awareness) },
        { stage: 'consideration', count: Number(f.consideration) },
        { stage: 'conversion', count: Number(f.conversion) },
        { stage: 'activation', count: Number(f.activation) },
        { stage: 'referral', count: Number(f.referral) },
        { stage: 'retention', count: Number(f.retention) },
      ],
      cohorts: cohortRows.map((r) => ({
        week: r.cohort_week,
        size: Number(r.cohort_size),
        d1: Number(r.d1_n),
        d7: Number(r.d7_n),
        d30: Number(r.d30_n),
      })),
    };
  });

  // GET /admin/adoption?days=30 — module-level adoption (% of active users
  // touching each module), the avg Feature Depth Score, and per-feature error
  // rates (only where a failure event exists).
  app.get<{ Querystring: { days?: string } }>('/admin/adoption', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const [adoptionRes, errorsRes] = await Promise.all([
      app.supabase.rpc('admin_feature_adoption', { p_days: days }),
      app.supabase.rpc('admin_feature_error_rates', { p_days: days }),
    ]);

    const a = (adoptionRes.data as
      | {
          active_users: number;
          avg_depth: number;
          storage: number;
          vault: number;
          diary: number;
          gift_box: number;
          tasks: number;
          referral: number;
        }[]
      | null)?.[0] ?? {
      active_users: 0,
      avg_depth: 0,
      storage: 0,
      vault: 0,
      diary: 0,
      gift_box: 0,
      tasks: 0,
      referral: 0,
    };
    const errorRows =
      (errorsRes.data as { feature: string; ok_count: number; fail_count: number }[] | null) ?? [];

    const activeUsers = Number(a.active_users);
    const pct = (n: number): number | null =>
      activeUsers > 0 ? Math.round((n / activeUsers) * 100) : null;

    const modules = (
      [
        ['storage', a.storage],
        ['vault', a.vault],
        ['diary', a.diary],
        ['gift_box', a.gift_box],
        ['tasks', a.tasks],
        ['referral', a.referral],
      ] as const
    )
      .map(([module, users]) => ({ module, users: Number(users), pctOfActive: pct(Number(users)) }))
      .sort((x, y) => y.users - x.users);

    return {
      days,
      activeUsers,
      avgDepth: Math.round(Number(a.avg_depth) * 100) / 100,
      modules,
      errorRates: errorRows.map((r) => {
        const ok = Number(r.ok_count);
        const fail = Number(r.fail_count);
        const total = ok + fail;
        return {
          feature: r.feature,
          ok,
          fail,
          errorRate: total > 0 ? Math.round((fail / total) * 100) : null,
        };
      }),
    };
  });

  // GET /admin/storage?days=30 — per-user fill histogram + daily quota-warning
  // counts (80 / 95 soft thresholds and the true 100%-blocked event).
  const STORAGE_BUCKETS = ['0-20', '20-40', '40-60', '60-80', '80-100', '100+'];
  app.get<{ Querystring: { days?: string } }>('/admin/storage', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const [histRes, warnRes] = await Promise.all([
      app.supabase.rpc('admin_storage_histogram'),
      app.supabase.rpc('admin_storage_warnings_daily', { p_days: days }),
    ]);

    const histRows = (histRes.data as { bucket: string; users: number }[] | null) ?? [];
    const byBucket = new Map(histRows.map((r) => [r.bucket, Number(r.users)]));
    const warnRows =
      (warnRes.data as { day: string; warn80: number; warn95: number; blocked: number }[] | null) ??
      [];

    return {
      days,
      histogram: STORAGE_BUCKETS.map((bucket) => ({ bucket, users: byBucket.get(bucket) ?? 0 })),
      warningsDaily: warnRows.map((r) => ({
        day: r.day,
        warn80: Number(r.warn80),
        warn95: Number(r.warn95),
        blocked: Number(r.blocked),
      })),
    };
  });

  // GET /admin/referral?days=30 — referral funnel (issued → entered → activated)
  // + the creator leaderboard. NO campaign attribution exists in the schema; the
  // web renders that as a "Coming soon" placeholder.
  app.get<{ Querystring: { days?: string } }>('/admin/referral', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const [funnelRes, topRes] = await Promise.all([
      app.supabase.rpc('admin_referral_funnel', { p_since: sinceIso(days) }),
      app.supabase.rpc('admin_top_referrers', { p_limit: 20 }),
    ]);

    const f = (funnelRes.data as
      | { issued_codes: number; entered: number; activated: number }[]
      | null)?.[0] ?? { issued_codes: 0, entered: 0, activated: 0 };
    const topRows =
      (topRes.data as
        | { user_id: string; display_name: string | null; referral_code: string | null; referral_count: number }[]
        | null) ?? [];

    const entered = Number(f.entered);
    const activated = Number(f.activated);

    return {
      days,
      funnel: {
        issuedCodes: Number(f.issued_codes),
        entered,
        activated,
        activationRate: entered > 0 ? Math.round((activated / entered) * 100) : null,
      },
      topReferrers: topRows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        referralCode: r.referral_code,
        referralCount: Number(r.referral_count),
      })),
    };
  });

  // GET /admin/users/:id — the per-user drawer behind a row click in the users
  // table. Everything membership-shaped about one account in a single round
  // trip: plan + storage, this month's quota counters, billing state, live
  // group boosts, the Google Sheets link, and the two content counts that are
  // not derivable from `users` (vault items, locker files/bytes).
  //
  // NEVER selects google_integrations.encrypted_token. That column holds a live
  // third-party credential; an admin needs to know the link EXISTS and whether
  // it is erroring, which `google_email` + `last_error` answer completely.
  // Selecting it explicitly by column list (rather than '*') is what keeps a
  // future column addition from leaking into this payload by default.
  //
  // Fails soft per-section, matching the analytics endpoints above: an
  // unapplied migration 051/046 leaves that card empty instead of 500-ing the
  // whole drawer.
  app.get<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const userId = request.params.id;

    const { data: user, error } = await app.supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const u = user as UserRecord;
    const plan: Plan = normalizePlan(u.plan as string | null);

    const [quotasRes, subsRes, boostsRes, googleRes, vaultRes, filesRes] = await Promise.allSettled([
      listMonthlyQuotas(app.supabase, { userId, plan, features: MONTHLY_FEATURES }),
      app.supabase
        .from('subscriptions')
        .select('id, plan, billing_cycle, price_thb, status, started_at, current_period_end, cancelled_at')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('current_period_end', { ascending: false }),
      // Live = not released AND not expired, evaluated at read time (the boost
      // service's own definition — never trust released_at alone, the expiry
      // job may not have swept yet).
      app.supabase
        .from('user_group_boosts')
        .select('id, group_id, activated_at, expires_at')
        .eq('user_id', userId)
        .is('released_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('expires_at', { ascending: true }),
      app.supabase
        .from('google_integrations')
        .select('google_email, sheet_id, sheet_url, last_synced_at, last_error, created_at')
        .eq('user_id', userId)
        .maybeSingle(),
      app.supabase
        .from('vault_files')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('deleted_at', null),
      app.supabase
        .from('files')
        .select('file_size')
        .eq('uploaded_by', userId)
        .is('deleted_at', null)
        .is('purged_at', null),
    ]);

    const quotas =
      quotasRes.status === 'fulfilled'
        ? quotasRes.value.map((q) => ({
            feature: q.feature,
            used: q.used,
            limit: q.limit,
            // `remaining` is Infinity for unlimited, which JSON.stringify turns
            // into null. Send the boolean and let the client render the dash.
            unlimited: q.unlimited,
            resetAt: q.resetAt,
          }))
        : [];

    const subscriptions =
      subsRes.status === 'fulfilled'
        ? ((subsRes.value.data as
            | {
                id: string;
                plan: string;
                billing_cycle: string;
                price_thb: number;
                status: string;
                started_at: string;
                current_period_end: string;
                cancelled_at: string | null;
              }[]
            | null) ?? []
          ).map((s) => ({
            id: s.id,
            plan: s.plan,
            billingCycle: s.billing_cycle,
            priceThb: Number(s.price_thb),
            status: s.status,
            startedAt: s.started_at,
            currentPeriodEnd: s.current_period_end,
            cancelledAt: s.cancelled_at,
          }))
        : [];

    const boosts =
      boostsRes.status === 'fulfilled'
        ? ((boostsRes.value.data as
            | { id: string; group_id: string; activated_at: string; expires_at: string }[]
            | null) ?? []
          ).map((b) => ({
            id: b.id,
            groupId: b.group_id,
            activatedAt: b.activated_at,
            expiresAt: b.expires_at,
          }))
        : [];

    const gRow =
      googleRes.status === 'fulfilled'
        ? (googleRes.value.data as {
            google_email: string | null;
            sheet_id: string | null;
            sheet_url: string | null;
            last_synced_at: string | null;
            last_error: string | null;
            created_at: string;
          } | null)
        : null;
    const google = gRow
      ? {
          connected: true,
          googleEmail: gRow.google_email,
          sheetId: gRow.sheet_id,
          sheetUrl: gRow.sheet_url,
          lastSyncedAt: gRow.last_synced_at,
          lastError: gRow.last_error,
          connectedAt: gRow.created_at,
        }
      : { connected: false as const };

    const vaultFileCount =
      vaultRes.status === 'fulfilled' ? Number(vaultRes.value.count ?? 0) : 0;

    const fileRows =
      filesRes.status === 'fulfilled'
        ? ((filesRes.value.data as { file_size: number }[] | null) ?? [])
        : [];
    const fileBytes = fileRows.reduce((sum, f) => sum + Number(f.file_size ?? 0), 0);

    return {
      user: {
        id: u.id,
        lineUserId: u.line_user_id,
        displayName: u.display_name,
        plan: u.plan,
        normalizedPlan: plan,
        storageUsed: Number(u.storage_used),
        storageLimit: Number(u.storage_limit),
        // migration 059. `undefined` (column not yet added) and SQL NULL both
        // mean "no override", and both must render as "ใช้ค่าจากแผน" rather
        // than as a 0-byte ceiling — so they collapse to null here, never 0.
        storageLimitOverride: overrideOf(user),
        createdAt: u.created_at,
        isAdmin: isAdminLineUser(u.line_user_id),
        // migration 060. `undefined` (column not yet added) and SQL NULL both
        // mean "active" — the same collapse-to-null the storage override does
        // above, so the drawer renders an honest state on a pre-060 API.
        suspendedAt: (user as Record<string, unknown>).suspended_at
          ? String((user as Record<string, unknown>).suspended_at)
          : null,
        suspendedReason: (user as Record<string, unknown>).suspended_reason
          ? String((user as Record<string, unknown>).suspended_reason)
          : null,
      },
      quotas,
      subscriptions,
      boosts,
      google,
      content: {
        // Capped at PostgREST's 1000-row page: this is the drawer's "roughly
        // how much has this one person put in" line, not the ledger. The
        // authoritative account total is users.storage_used, shown above it.
        fileCount: fileRows.length,
        fileBytes,
        vaultFileCount,
      },
    };
  });

  // PATCH /admin/users/:id — adjust a user's storage quota.
  // This is the only place that may set storage_limit to an arbitrary value.
  // redeem_referral uses GREATEST() to avoid overwriting this.
  app.patch<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const parsed = z
      .object({ storageLimit: z.number().int().positive() })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const { data, error } = await app.supabase
      .from('users')
      .update({ storage_limit: parsed.data.storageLimit, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'User not found' });
    return { id: (data as UserRecord).id, storageLimit: (data as UserRecord).storage_limit };
  });

  // ==========================================================================
  // TIER 2 — privileged WRITES.
  //
  // Everything below changes someone else's account. Three rules hold for all
  // of them, and none is optional:
  //
  //  1. zod-validated body. No handler reads request.body directly.
  //  2. requireAdminAction() before the 200. A failed audit insert throws
  //     AdminAuditError → 500, so an unaudited write cannot be reported as a
  //     success.
  //  3. COMPENSATING ROLLBACK. PostgREST has no multi-statement transaction
  //     (see the contract in admin-audit.service.ts), so each handler reads its
  //     `before` state, writes, audits, and on an audit failure writes `before`
  //     back before letting the error propagate. `rollback()` below is that
  //     step, and it swallows nothing: a revert that itself fails is logged with
  //     both values, because at that point the log line IS the recovery path.
  //
  // These are ADMIN OVERRIDES, not purchases. None of them touches
  // `subscriptions` and none calls changePlan() — that function is the seam a
  // future payment webhook will use, and a second caller would be a second way
  // to mint a paid subscription without payment (see "Temporarily Disabled
  // Endpoints" in CLAUDE.md).
  // ==========================================================================

  /**
   * Undo a write whose audit row could not be written. Never throws — the
   * AdminAuditError it is compensating for must be the error the admin sees.
   */
  async function rollback(label: string, undo: () => PromiseLike<{ error: unknown }>): Promise<void> {
    try {
      const { error } = await undo();
      if (error) {
        app.log.error({ err: error, step: label }, 'admin rollback FAILED — write is applied but unaudited');
      }
    } catch (err) {
      app.log.error({ err, step: label }, 'admin rollback THREW — write is applied but unaudited');
    }
  }

  // --------------------------------------------------------------------------
  // PATCH /admin/users/:id/plan — direct plan override.
  //
  // Writes users.plan, then re-derives storage_limit and releases boosts the
  // new plan no longer entitles the user to. Deliberately does NOT create,
  // cancel or touch a `subscriptions` row: this grants the ENTITLEMENT without
  // claiming money changed hands, which is the honest shape for an override and
  // keeps the billing seam single-caller.
  //
  // Consequence worth knowing: an admin-granted paid plan has no
  // current_period_end, so the nightly expireLapsedSubscriptions() sweep will
  // never downgrade it. It is permanent until an admin sets it back.
  // --------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>('/admin/users/:id/plan', async (request, reply) => {
    const parsed = z.object({ plan: z.enum(RAW_PLAN_VALUES) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const userId = request.params.id;
    const nextRaw: RawPlanValue = parsed.data.plan;

    const { data: current, error: readErr } = await app.supabase
      .from('users')
      .select('id, plan, referral_count, storage_limit, storage_limit_override')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) return reply.code(404).send({ error: 'User not found' });

    const previousRaw = (current.plan as string | null) ?? 'free';
    const previousLimit = Number(current.storage_limit ?? 0);
    const override = overrideOf(current);
    const referralCount = Number((current.referral_count as number | null) ?? 0);

    // Idempotent: setting the plan a user already has is a no-op that still
    // reports success, so a double-submitted form cannot 409 or double-audit.
    if (previousRaw === nextRaw) {
      return {
        id: userId,
        plan: previousRaw,
        normalizedPlan: normalizePlan(previousRaw),
        storageLimit: previousLimit,
        storageLimitOverride: override,
        changed: false,
      };
    }

    const { error: updErr } = await app.supabase
      .from('users')
      .update({ plan: nextRaw, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (updErr) throw updErr;

    // The plan column is written raw; everything downstream reasons in
    // normalized plans, so 'team' correctly buys premium limits.
    const nextPlan: Plan = normalizePlan(nextRaw);
    const storageLimit = await syncStorageLimit(app.supabase, userId, {
      plan: nextPlan,
      referralCount,
      overrideBytes: override,
    });
    await reconcileBoostsForPlan(app.supabase, userId, nextPlan);

    try {
      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'user_plan_change',
        targetType: 'user',
        targetId: userId,
        before: { plan: previousRaw, storageLimit: previousLimit },
        after: { plan: nextRaw, storageLimit },
      });
    } catch (err) {
      // Boost releases are NOT reverted: releasing a boost is itself a
      // recorded, benign action (the user simply reclaims the slot), and
      // re-activating one would fabricate a fresh 30-day window.
      await rollback('user_plan_change', () =>
        app.supabase
          .from('users')
          .update({ plan: previousRaw, storage_limit: previousLimit })
          .eq('id', userId),
      );
      throw err;
    }

    return {
      id: userId,
      plan: nextRaw,
      normalizedPlan: nextPlan,
      storageLimit,
      storageLimitOverride: override,
      changed: true,
    };
  });

  // --------------------------------------------------------------------------
  // PATCH /admin/users/:id/storage-override — manual locker ceiling.
  //
  // `bytes: null` REMOVES the override and hands the user back to their plan's
  // computed allowance. syncStorageLimit() is called in BOTH branches, not just
  // the non-null one: clearing an override that is still mirrored into
  // storage_limit would leave the old ceiling in force with nothing recording
  // why, which is the exact failure the override column was added to end.
  //
  // 0 is a REAL value, not "clear it" — it pins the user to a zero-byte locker,
  // which is a legitimate (if blunt) way to stop an abusive account from
  // uploading. Only null clears.
  // --------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>('/admin/users/:id/storage-override', async (request, reply) => {
    const parsed = z
      .object({
        bytes: z.union([z.number().int().min(0).max(MAX_STORAGE_OVERRIDE_BYTES), z.null()]),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const userId = request.params.id;
    const nextOverride = parsed.data.bytes;

    const { data: current, error: readErr } = await app.supabase
      .from('users')
      .select('id, plan, referral_count, storage_limit, storage_limit_override')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) return reply.code(404).send({ error: 'User not found' });

    const previousOverride = overrideOf(current);
    const previousLimit = Number(current.storage_limit ?? 0);
    const plan = normalizePlan(current.plan as string | null);
    const referralCount = Number((current.referral_count as number | null) ?? 0);

    const { error: updErr } = await app.supabase
      .from('users')
      .update({ storage_limit_override: nextOverride, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (updErr) throw updErr;

    // Pass the value we just wrote rather than letting syncStorageLimit re-read
    // it — one fewer round trip, and it cannot read back a concurrent write.
    const storageLimit = await syncStorageLimit(app.supabase, userId, {
      plan,
      referralCount,
      overrideBytes: nextOverride,
    });

    try {
      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'user_storage_override',
        targetType: 'user',
        targetId: userId,
        before: { storageLimitOverride: previousOverride, storageLimit: previousLimit },
        after: { storageLimitOverride: nextOverride, storageLimit },
      });
    } catch (err) {
      await rollback('user_storage_override', () =>
        app.supabase
          .from('users')
          .update({ storage_limit_override: previousOverride, storage_limit: previousLimit })
          .eq('id', userId),
      );
      throw err;
    }

    return { id: userId, storageLimitOverride: nextOverride, storageLimit };
  });

  // --------------------------------------------------------------------------
  // POST /admin/users/:id/quotas/:feature/reset — zero one monthly counter.
  //
  // Scoped to the CURRENT Bangkok period only. user_quotas rows are keyed by
  // period_start (migration 051), so past months are immutable history and a
  // reset can never reach them.
  //
  // 404 when no row exists for this period, rather than creating one at 0: a
  // missing row already MEANS zero used (consume_quota inserts on first use),
  // so creating one would write a row that says nothing and hand back a
  // success that did nothing.
  //
  // Resets EVERY scope for the feature. `group_files` is scoped per group, so a
  // user can hold several rows for one feature; an admin clicking "reset ไฟล์ใน
  // กลุ่ม" means all of them, and asking for a group id in that UI would be a
  // worse question than the one it answers.
  // --------------------------------------------------------------------------
  app.post<{ Params: { id: string; feature: string } }>(
    '/admin/users/:id/quotas/:feature/reset',
    async (request, reply) => {
      const { id: userId, feature } = request.params;
      if (!(MONTHLY_FEATURES as readonly string[]).includes(feature)) {
        return reply.code(400).send({ error: 'Unknown quota feature', feature });
      }
      const monthlyFeature = feature as MonthlyFeature;
      const period = currentPeriodStart();

      const { data: existing, error: readErr } = await app.supabase
        .from('user_quotas')
        .select('id, scope_id, used, limit_value')
        .eq('user_id', userId)
        .eq('feature', monthlyFeature)
        .eq('period_start', period);
      if (readErr) throw readErr;

      const rows = (existing ?? []) as { id: string; scope_id: string; used: number; limit_value: number }[];
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'No quota row for this user, feature and period', period });
      }

      const { error: updErr } = await app.supabase
        .from('user_quotas')
        .update({ used: 0 })
        .eq('user_id', userId)
        .eq('feature', monthlyFeature)
        .eq('period_start', period);
      if (updErr) throw updErr;

      try {
        await requireAdminAction({
          supabase: app.supabase,
          adminLineId: actor(request),
          action: 'user_quota_reset',
          targetType: 'user',
          targetId: userId,
          before: {
            feature: monthlyFeature,
            period,
            rows: rows.map((r) => ({ scopeId: r.scope_id, used: Number(r.used) })),
          },
          after: { feature: monthlyFeature, period, used: 0 },
        });
      } catch (err) {
        // Restore each scope's own prior counter. A single blanket UPDATE
        // cannot do this — the rows had different `used` values.
        for (const r of rows) {
          await rollback('user_quota_reset', () =>
            app.supabase
              .from('user_quotas')
              .update({ used: r.used })
              .eq('id', r.id),
          );
        }
        throw err;
      }

      return {
        userId,
        feature: monthlyFeature,
        period,
        rowsReset: rows.length,
        previousUsed: rows.reduce((n, r) => n + Number(r.used ?? 0), 0),
      };
    },
  );

  // --------------------------------------------------------------------------
  // POST /admin/users/:id/revoke-sessions — invalidate every issued JWT.
  //
  // Bumping users.session_version (migration 009) makes every outstanding token
  // for that user fail the auth middleware's version check.
  //
  // The UPDATE carries `.eq('session_version', before)` so a concurrent bump
  // cannot be lost: read-modify-write without it would let two admins both read
  // 4 and both write 5, and the second revocation would silently not happen.
  // A lost race answers 409 and the admin clicks again.
  //
  // The auth middleware caches session_version in Redis for 60 s, so the key is
  // deleted here — otherwise a revocation an admin just performed would appear
  // not to work for up to a minute, which is exactly when it matters most.
  // --------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/admin/users/:id/revoke-sessions', async (request, reply) => {
    const userId = request.params.id;

    const { data: current, error: readErr } = await app.supabase
      .from('users')
      .select('id, session_version')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) return reply.code(404).send({ error: 'User not found' });

    // Rows predating migration 009 have no value; the middleware treats missing
    // as 1, so the same default is used here.
    const before = Number((current.session_version as number | null) ?? 1);
    const next = before + 1;

    const { data: updated, error: updErr } = await app.supabase
      .from('users')
      .update({ session_version: next, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .eq('session_version', before)
      .select('id')
      .maybeSingle();
    if (updErr) throw updErr;
    if (!updated) {
      return reply
        .code(409)
        .send({ error: 'Session version changed concurrently — retry', code: 'CONCURRENT_REVOKE' });
    }

    await bustSessionCache(userId);

    try {
      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'user_revoke_sessions',
        targetType: 'user',
        targetId: userId,
        before: { sessionVersion: before },
        after: { sessionVersion: next },
      });
    } catch (err) {
      await rollback('user_revoke_sessions', () =>
        app.supabase
          .from('users')
          .update({ session_version: before })
          .eq('id', userId)
          .eq('session_version', next),
      );
      // Bust again: the revert changed the value the first bust re-populated.
      await bustSessionCache(userId);
      throw err;
    }

    return { id: userId, sessionVersion: next };
  });

  /**
   * Drop the auth middleware's 60 s session_version cache for one user.
   * Never throws — a failed delete only costs up to 60 s of staleness, which
   * the TTL already bounds, and must not fail a completed revocation.
   */
  async function bustSessionCache(userId: string): Promise<void> {
    try {
      await app.redis.del(`sv:${userId}`);
    } catch (err) {
      app.log.warn({ err, userId }, 'session_version cache bust failed (TTL will expire it)');
    }
  }

  // ==========================================================================
  // TIER 3 — account suspension (migration 060).
  //
  // The verb TIER 2 was missing. An admin could already zero a quota, pin a
  // locker ceiling to 0 bytes and revoke every session — but none of those
  // STOPS an account: the user logs back in a second later with a fresh JWT.
  // Suspension is enforced in middleware/auth.ts, which every authenticated
  // request passes through, and it answers 403 ACCOUNT_SUSPENDED rather than
  // 401 so the web app does not loop the user through LINE Login forever.
  //
  // SUSPENDING ALSO BUMPS session_version. The column check alone stops the
  // NEXT login; the bump kills the tokens already in the user's browser without
  // waiting for the auth middleware's 60 s cache to expire. Both are needed —
  // one closes the door, the other empties the room.
  //
  // SCOPE, stated once: this stops the WEB and LIFF surfaces only. The LINE
  // webhook is signature-authenticated and never reaches the auth middleware,
  // so a suspended user can still message the OA and still have files stored.
  // See the column comment in migration 060 — cutting the chat path would
  // silently swallow uploads a user believes were saved, and is a separate,
  // louder decision.
  // ==========================================================================

  /** Free text, but bounded — this lands on a user row and in an audit payload. */
  const SUSPEND_REASON_MAX = 500;

  app.post<{ Params: { id: string } }>('/admin/users/:id/suspend', async (request, reply) => {
    const parsed = z
      .object({
        // Required, and non-empty after trimming. A suspension with no recorded
        // reason is one nobody can justify a week later, and an empty string
        // would satisfy a plain `z.string()` while recording nothing.
        reason: z.string().trim().min(1).max(SUSPEND_REASON_MAX),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const userId = request.params.id;
    const reason = parsed.data.reason;

    const { data: current, error: readErr } = await app.supabase
      .from('users')
      .select('id, suspended_at, suspended_reason, session_version')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) return reply.code(404).send({ error: 'User not found' });

    // 409 rather than a silent re-suspend: overwriting would move suspended_at
    // forward and replace the ORIGINAL reason, losing when and why the account
    // was actually stopped. An admin who wants to amend the reason unsuspends
    // and suspends again, which leaves both events in the audit log.
    if (current.suspended_at) {
      return reply.code(409).send({
        error: 'User is already suspended',
        code: 'ALREADY_SUSPENDED',
        suspendedAt: current.suspended_at as string,
      });
    }

    const beforeVersion = Number((current.session_version as number | null) ?? 1);
    const nextVersion = beforeVersion + 1;
    const suspendedAt = new Date().toISOString();

    // Both writes in ONE statement, guarded on the session_version we read —
    // the same lost-update guard POST /revoke-sessions uses. Two admins acting
    // at once cannot both write version+1 and lose one revocation.
    const { data: updated, error: updErr } = await app.supabase
      .from('users')
      .update({
        suspended_at: suspendedAt,
        suspended_reason: reason,
        session_version: nextVersion,
        updated_at: suspendedAt,
      })
      .eq('id', userId)
      .eq('session_version', beforeVersion)
      .select('id')
      .maybeSingle();
    if (updErr) throw updErr;
    if (!updated) {
      return reply
        .code(409)
        .send({ error: 'Session version changed concurrently — retry', code: 'CONCURRENT_REVOKE' });
    }

    await bustSessionCache(userId);

    try {
      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'user_suspend',
        targetType: 'user',
        targetId: userId,
        before: { suspendedAt: null, sessionVersion: beforeVersion },
        after: { suspendedAt, reason, sessionVersion: nextVersion },
      });
    } catch (err) {
      await rollback('user_suspend', () =>
        app.supabase
          .from('users')
          .update({
            suspended_at: null,
            suspended_reason: null,
            session_version: beforeVersion,
          })
          .eq('id', userId)
          .eq('session_version', nextVersion),
      );
      // Bust again: the revert changed the value the first bust re-populated.
      await bustSessionCache(userId);
      throw err;
    }

    return { id: userId, suspendedAt, suspendedReason: reason, sessionVersion: nextVersion };
  });

  // --------------------------------------------------------------------------
  // POST /admin/users/:id/unsuspend
  //
  // Does NOT bump session_version, unlike its counterpart. The tokens that
  // suspending killed are gone for good and the user signs in fresh; bumping
  // again would revoke the sessions of a user who has none, and would be one
  // more thing to revert if the audit write failed. The cache IS busted, so the
  // 403 stops within the same request rather than up to 60 s later.
  // --------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/admin/users/:id/unsuspend', async (request, reply) => {
    const userId = request.params.id;

    const { data: current, error: readErr } = await app.supabase
      .from('users')
      .select('id, suspended_at, suspended_reason')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) return reply.code(404).send({ error: 'User not found' });

    if (!current.suspended_at) {
      return reply
        .code(409)
        .send({ error: 'User is not suspended', code: 'NOT_SUSPENDED' });
    }

    const beforeAt = current.suspended_at as string;
    const beforeReason = (current.suspended_reason as string | null) ?? null;

    const { error: updErr } = await app.supabase
      .from('users')
      .update({
        suspended_at: null,
        suspended_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);
    if (updErr) throw updErr;

    await bustSessionCache(userId);

    try {
      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'user_unsuspend',
        targetType: 'user',
        targetId: userId,
        before: { suspendedAt: beforeAt, reason: beforeReason },
        after: { suspendedAt: null },
      });
    } catch (err) {
      await rollback('user_unsuspend', () =>
        app.supabase
          .from('users')
          .update({ suspended_at: beforeAt, suspended_reason: beforeReason })
          .eq('id', userId),
      );
      await bustSessionCache(userId);
      throw err;
    }

    return { id: userId, suspendedAt: null, suspendedReason: null };
  });

  // --------------------------------------------------------------------------
  // POST /admin/tasks/:taskId/cancel-reminders — stop a task's pending pushes.
  //
  // The narrow, per-task counterpart to the global push_enabled switch: one
  // task is chasing a group at 03:00 and only that one should stop.
  //
  // Cancels only rows that are BOTH unsent and not already cancelled. Never
  // deletes: task_reminders rows are stamped (sent_at / failed_at /
  // cancelled_at) and kept, which is what makes the delivery panel on
  // /admin/system able to distinguish "withdrawn" from "never scheduled".
  //
  // A cancelled row's delayed BullMQ job is NOT removed — it still fires, and
  // the worker's own cancelled_at check stands it down. That is the same shape
  // the product's existing completion path uses (rollUpCompletion cancels rows,
  // not jobs), so there is one cancellation mechanism rather than two.
  // --------------------------------------------------------------------------
  app.post<{ Params: { taskId: string } }>('/admin/tasks/:taskId/cancel-reminders', async (request, reply) => {
    const taskId = request.params.taskId;

    const { data: task, error: taskErr } = await app.supabase
      .from('tasks')
      .select('id, title, status')
      .eq('id', taskId)
      .maybeSingle();
    if (taskErr) throw taskErr;
    if (!task) return reply.code(404).send({ error: 'Task not found' });

    const cancelledAt = new Date().toISOString();
    const { data: affected, error: updErr } = await app.supabase
      .from('task_reminders')
      .update({ cancelled_at: cancelledAt })
      .eq('task_id', taskId)
      .is('cancelled_at', null)
      .is('sent_at', null)
      .select('id, remind_type, remind_at');
    if (updErr) throw updErr;

    const rows = (affected ?? []) as { id: string; remind_type: string; remind_at: string }[];

    try {
      await requireAdminAction({
        supabase: app.supabase,
        adminLineId: actor(request),
        action: 'task_cancel_reminders',
        targetType: 'task',
        targetId: taskId,
        before: {
          taskTitle: (task as { title: string }).title,
          taskStatus: (task as { status: string }).status,
          pending: rows.map((r) => ({ id: r.id, remindType: r.remind_type, remindAt: r.remind_at })),
        },
        after: { cancelled: rows.length, cancelledAt },
      });
    } catch (err) {
      if (rows.length > 0) {
        await rollback('task_cancel_reminders', () =>
          app.supabase
            .from('task_reminders')
            .update({ cancelled_at: null })
            .in(
              'id',
              rows.map((r) => r.id),
            ),
        );
      }
      throw err;
    }

    return { taskId, cancelled: rows.length };
  });
};

/**
 * users.storage_limit_override, normalised to `number | null`.
 *
 * Three shapes collapse to null: SQL NULL, and `undefined` from a row read
 * before migration 059 added the column. A BIGINT can arrive as a string from
 * PostgREST, so anything present is coerced through Number().
 */
function overrideOf(row: unknown): number | null {
  const raw = (row as { storage_limit_override?: number | string | null } | null)?.storage_limit_override;
  return raw === null || raw === undefined ? null : Number(raw);
}

export default adminRoutes;
