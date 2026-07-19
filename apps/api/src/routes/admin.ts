import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SpaceRecord, UserRecord } from '@nookeb/shared';
import { isAdminLineUser } from '../config';

const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  // Gate: only configured admin LINE user ids
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminLineUser(request.authUser!.lineUserId)) {
      await reply.code(403).send({ error: 'Admin access required' });
    }
  });

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

  // GET /admin/pro-interest?days=30 — the fake-door demand test, split into two
  // deliberately non-comparable panels (they must NOT share a y-scale):
  //   * task features: real view→click funnel, deduped by user (usage_events +
  //     the deduped pro_interest table).
  //   * gift-box: anonymous tap counts only — no views, no dedup, no conversion.
  app.get<{ Querystring: { days?: string } }>('/admin/pro-interest', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 90);
    const [tasksRes, giftboxRes, dailyRes] = await Promise.all([
      app.supabase.rpc('admin_pro_interest_tasks', { p_since: sinceIso(days) }),
      app.supabase.rpc('admin_pro_interest_giftbox', { p_since: sinceIso(days) }),
      app.supabase.rpc('admin_pro_interest_daily', { p_days: days }),
    ]);

    const taskRows =
      (tasksRes.data as
        | {
            feature_id: string;
            view_events: number;
            view_users: number;
            click_events: number;
            click_users: number;
            dismiss_events: number;
            registered_users: number;
          }[]
        | null) ?? [];
    const giftRows = (giftboxRes.data as { feature: string; taps: number }[] | null) ?? [];
    const dailyRows =
      (dailyRes.data as { day: string; task_clicks: number; giftbox_taps: number }[] | null) ?? [];

    const tasks = taskRows
      .map((r) => {
        const viewUsers = Number(r.view_users);
        const clickUsers = Number(r.click_users);
        return {
          featureId: r.feature_id,
          viewEvents: Number(r.view_events),
          viewUsers,
          clickEvents: Number(r.click_events),
          clickUsers,
          dismissEvents: Number(r.dismiss_events),
          registeredUsers: Number(r.registered_users),
          // deduped-by-user conversion — unique clickers / unique viewers
          conversionRate: viewUsers > 0 ? Math.round((clickUsers / viewUsers) * 100) : null,
        };
      })
      // highest interest first (ranked list — spec Task 2)
      .sort((a, b) => b.registeredUsers - a.registeredUsers || b.clickUsers - a.clickUsers);

    return {
      days,
      tasks,
      giftbox: giftRows
        .map((r) => ({ feature: r.feature, taps: Number(r.taps) }))
        .sort((a, b) => b.taps - a.taps),
      daily: dailyRows.map((r) => ({
        day: r.day,
        taskClicks: Number(r.task_clicks),
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
};

export default adminRoutes;
