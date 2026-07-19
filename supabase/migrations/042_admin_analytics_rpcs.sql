-- 042_admin_analytics_rpcs.sql
-- Task-3 admin-dashboard aggregate RPCs over usage_events + the demand-test /
-- referral / task tables. All read-only (STABLE, no writes), CREATE OR REPLACE
-- so the file is re-runnable, and daily buckets in Asia/Bangkok so "day" matches
-- the user's calendar day (the product is Thailand-facing) — same posture as the
-- migration-029 admin_* RPCs.
--
-- NOT auto-applied — run in the Supabase SQL editor. The /admin endpoints fail
-- soft to empty/zero when these are missing, so deploying code first only means
-- "those panels stay blank until this is applied", never a broken page.
--
-- Sections mirror the admin dashboard: 2 Pro-Interest, 4 Tasks, 1 Funnel/
-- Retention, 3 Feature adoption, 6 Storage, 5 Referral.

-- ============================================================================
-- Section 2 — Pro-Interest dashboard
-- ============================================================================

-- Task Pro features (task_auto_reminder / task_voice_command): the real
-- view -> click funnel from usage_events (deduped by user), plus the all-time
-- unique interested users from the deduped pro_interest table (migration 040).
-- feature_id rides in usage_events.metadata (set client-side, sanitised server-
-- side). These are the "unique users, deduped" features on the dashboard.
CREATE OR REPLACE FUNCTION admin_pro_interest_tasks(p_since TIMESTAMPTZ)
RETURNS TABLE(
  feature_id       TEXT,
  view_events      BIGINT,
  view_users       BIGINT,
  click_events     BIGINT,
  click_users      BIGINT,
  dismiss_events   BIGINT,
  registered_users BIGINT   -- all-time deduped (pro_interest table)
)
LANGUAGE sql STABLE AS $$
  WITH ev AS (
    SELECT metadata->>'feature_id' AS fid, event_type, user_id
    FROM usage_events
    WHERE created_at >= p_since
      AND event_type IN ('pro_interest_view','pro_interest_click','pro_interest_dismiss')
      AND metadata->>'feature_id' IN ('task_auto_reminder','task_voice_command')
  )
  SELECT
    f.fid,
    COUNT(*) FILTER (WHERE ev.event_type = 'pro_interest_view')::BIGINT,
    COUNT(DISTINCT ev.user_id) FILTER (WHERE ev.event_type = 'pro_interest_view')::BIGINT,
    COUNT(*) FILTER (WHERE ev.event_type = 'pro_interest_click')::BIGINT,
    COUNT(DISTINCT ev.user_id) FILTER (WHERE ev.event_type = 'pro_interest_click')::BIGINT,
    COUNT(*) FILTER (WHERE ev.event_type = 'pro_interest_dismiss')::BIGINT,
    (SELECT COUNT(*) FROM pro_interest p WHERE p.feature_id = f.fid)::BIGINT
  FROM (VALUES ('task_auto_reminder'), ('task_voice_command')) AS f(fid)
  LEFT JOIN ev ON ev.fid = f.fid
  GROUP BY f.fid;
$$;

-- Gift-box demand test (migration 034): tap counts only. The source table is
-- anonymous (no user_id), so NO views and NO conversion % are derivable here —
-- the dashboard renders this on its own axis, labelled "anonymous, event count".
CREATE OR REPLACE FUNCTION admin_pro_interest_giftbox(p_since TIMESTAMPTZ)
RETURNS TABLE(feature TEXT, taps BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT feature, COUNT(*)::BIGINT
  FROM pro_interest_log
  WHERE created_at >= p_since
  GROUP BY feature;
$$;

-- Daily interest trend. One shared date spine, SEPARATE columns so the UI draws
-- two independent charts (never one shared y-scale): task clicks (deduped source)
-- vs gift-box taps (anonymous source).
CREATE OR REPLACE FUNCTION admin_pro_interest_daily(p_days INT)
RETURNS TABLE(day DATE, task_clicks BIGINT, giftbox_taps BIGINT)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT (created_at AT TIME ZONE 'Asia/Bangkok')::date AS day, COUNT(*)::BIGINT AS c
    FROM usage_events
    WHERE event_type = 'pro_interest_click'
      AND created_at >= NOW() - (p_days || ' days')::interval
      AND metadata->>'feature_id' IN ('task_auto_reminder','task_voice_command')
    GROUP BY 1
  ),
  g AS (
    SELECT (created_at AT TIME ZONE 'Asia/Bangkok')::date AS day, COUNT(*)::BIGINT AS c
    FROM pro_interest_log
    WHERE created_at >= NOW() - (p_days || ' days')::interval
    GROUP BY 1
  )
  SELECT COALESCE(t.day, g.day), COALESCE(t.c, 0)::BIGINT, COALESCE(g.c, 0)::BIGINT
  FROM t FULL OUTER JOIN g ON t.day = g.day
  ORDER BY 1;
$$;

-- ============================================================================
-- Section 4 — Tasks dashboard (ระบบตามงาน, migration 036)
-- ============================================================================

-- Tasks created per day, split by type. Sourced from the authoritative tasks
-- table (a created task is a fact even if later soft-deleted), so this counts
-- creations regardless of deleted_at. Bangkok calendar day.
CREATE OR REPLACE FUNCTION admin_tasks_daily(p_days INT)
RETURNS TABLE(day DATE, single BIGINT, multi BIGINT, recurring BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT (created_at AT TIME ZONE 'Asia/Bangkok')::date AS day,
         COUNT(*) FILTER (WHERE type = 'single')::BIGINT,
         COUNT(*) FILTER (WHERE type = 'multi')::BIGINT,
         COUNT(*) FILTER (WHERE type = 'recurring')::BIGINT
  FROM tasks
  WHERE created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1
  ORDER BY 1;
$$;

-- Task rollups over the window: creation-by-type + current-status breakdown of
-- those tasks (authoritative tasks.status — recurring never reaches 'done', by
-- design), plus event-sourced ICS downloads and completion timing. avg_complete_sec
-- comes from task_mark_done's time_to_complete metadata (seconds); mark_done_count
-- is per-assignee-item completions (NOT the same as task-level done — surfaced
-- separately so the two are never conflated).
CREATE OR REPLACE FUNCTION admin_tasks_summary(p_since TIMESTAMPTZ)
RETURNS TABLE(
  total_created    BIGINT,
  type_single      BIGINT,
  type_multi       BIGINT,
  type_recurring   BIGINT,
  status_pending   BIGINT,
  status_progress  BIGINT,
  status_done      BIGINT,
  status_cancelled BIGINT,
  ics_downloads    BIGINT,
  mark_done_count  BIGINT,
  avg_complete_sec NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since)::BIGINT,
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since AND type = 'single')::BIGINT,
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since AND type = 'multi')::BIGINT,
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since AND type = 'recurring')::BIGINT,
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since AND status = 'pending')::BIGINT,
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since AND status = 'in_progress')::BIGINT,
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since AND status = 'done')::BIGINT,
    (SELECT COUNT(*) FROM tasks WHERE created_at >= p_since AND status = 'cancelled')::BIGINT,
    (SELECT COUNT(*) FROM usage_events
      WHERE created_at >= p_since AND event_type = 'task_ics_download')::BIGINT,
    (SELECT COUNT(*) FROM usage_events
      WHERE created_at >= p_since AND event_type = 'task_mark_done')::BIGINT,
    (SELECT AVG((metadata->>'time_to_complete')::numeric)
       FROM usage_events
      WHERE created_at >= p_since AND event_type = 'task_mark_done'
        AND metadata ? 'time_to_complete');
$$;

-- ============================================================================
-- Section 1 — Funnel Overview + retention cohorts
-- ============================================================================

-- Six-stage product funnel: distinct-user REACH at each stage over the window
-- (NOT strict subsets — Referral/Retention are parallel AARRR outcomes, not a
-- linear drop-off). Definitions, each over usage_events in [now-p_days, now]:
--   awareness     = all registered users (the anchor — everyone who signed up)
--   consideration = users with ANY event in the window (engaged)
--   conversion    = users who completed a value action (stored/produced something)
--   activation    = users active on >= 2 distinct Bangkok days (formed a habit)
--   referral      = users with referral activity (entered/activated/checked code)
--   retention     = >= 2 active days AND active in the last 7 days (still around)
CREATE OR REPLACE FUNCTION admin_funnel_overview(p_days INT)
RETURNS TABLE(
  awareness     BIGINT,
  consideration BIGINT,
  conversion    BIGINT,
  activation    BIGINT,
  referral      BIGINT,
  retention     BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH win AS (
    SELECT user_id, event_type,
           (created_at AT TIME ZONE 'Asia/Bangkok')::date AS d,
           created_at
    FROM usage_events
    WHERE created_at >= NOW() - (p_days || ' days')::interval
      AND user_id IS NOT NULL
  ),
  per_user AS (
    SELECT user_id,
           COUNT(DISTINCT d) AS active_days,
           bool_or(event_type IN ('upload_done','scan_done','diary_done','docx_done',
                                  'box_created','vault_upload_done','task_create_submit')) AS did_value,
           bool_or(event_type IN ('referral_code_entered','referral_code_activated','cmd_referral')) AS did_referral,
           bool_or(created_at >= NOW() - INTERVAL '7 days') AS active_last7
    FROM win
    GROUP BY user_id
  )
  SELECT
    (SELECT COUNT(*) FROM users)::BIGINT,
    (SELECT COUNT(*) FROM per_user)::BIGINT,
    (SELECT COUNT(*) FROM per_user WHERE did_value)::BIGINT,
    (SELECT COUNT(*) FROM per_user WHERE active_days >= 2)::BIGINT,
    (SELECT COUNT(*) FROM per_user WHERE did_referral)::BIGINT,
    (SELECT COUNT(*) FROM per_user WHERE active_days >= 2 AND active_last7)::BIGINT;
$$;

-- Weekly signup cohorts × D1/D7/D30 return counts (any event ≥ k days after
-- signup — same "came back later" semantics as admin_retention). Returns raw
-- counts + cohort size; the web derives % and greys out cells whose cohort is
-- younger than the Dk horizon (not enough time to have returned yet).
CREATE OR REPLACE FUNCTION admin_retention_cohorts(p_weeks INT)
RETURNS TABLE(
  cohort_week DATE,
  cohort_size BIGINT,
  d1_n        BIGINT,
  d7_n        BIGINT,
  d30_n       BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH cohort AS (
    SELECT id,
           created_at,
           (date_trunc('week', created_at AT TIME ZONE 'Asia/Bangkok'))::date AS wk
    FROM users
    WHERE created_at >= NOW() - ((p_weeks * 7) || ' days')::interval
  )
  SELECT
    c.wk,
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM usage_events e WHERE e.user_id = c.id
        AND e.created_at >= c.created_at + INTERVAL '1 day'))::BIGINT,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM usage_events e WHERE e.user_id = c.id
        AND e.created_at >= c.created_at + INTERVAL '7 days'))::BIGINT,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM usage_events e WHERE e.user_id = c.id
        AND e.created_at >= c.created_at + INTERVAL '30 days'))::BIGINT
  FROM cohort c
  GROUP BY c.wk
  ORDER BY c.wk;
$$;

-- ============================================================================
-- Section 3 — Feature adoption (module level)
-- ============================================================================

-- Module adoption: distinct users who touched each of the 6 product modules in
-- the window, the active-user denominator, and the avg Feature Depth Score
-- (distinct modules per active user). Event→module map is the source of truth —
-- keep it in sync with the event vocabulary (events.service.ts). Non-module
-- events (cmd_help, web_login, …) still count toward active_users but no module.
CREATE OR REPLACE FUNCTION admin_feature_adoption(p_days INT)
RETURNS TABLE(
  active_users BIGINT,
  avg_depth    NUMERIC,
  storage      BIGINT,
  vault        BIGINT,
  diary        BIGINT,
  gift_box     BIGINT,
  tasks        BIGINT,
  referral     BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH ev AS (
    SELECT user_id,
           CASE
             WHEN event_type IN ('upload_done','scan_done','file_download','web_search',
                                 'file_restored','file_purged_manual') THEN 'storage'
             WHEN event_type IN ('vault_setup','vault_open','vault_unlock_failed',
                                 'vault_upload_done') THEN 'vault'
             WHEN event_type IN ('diary_done','cmd_diary_arm','diary_streak_break') THEN 'diary'
             WHEN event_type IN ('box_created','box_viewed','box_deleted') THEN 'gift_box'
             WHEN event_type IN ('task_create_start','task_create_submit','task_view',
                                 'task_mark_done','task_ics_download','task_repeat_view') THEN 'tasks'
             WHEN event_type IN ('referral_code_entered','referral_code_activated',
                                 'cmd_referral') THEN 'referral'
             ELSE NULL
           END AS module
    FROM usage_events
    WHERE created_at >= NOW() - (p_days || ' days')::interval
      AND user_id IS NOT NULL
  ),
  um AS (SELECT DISTINCT user_id, module FROM ev WHERE module IS NOT NULL),
  depth AS (SELECT user_id, COUNT(*) AS modules FROM um GROUP BY user_id)
  SELECT
    (SELECT COUNT(DISTINCT user_id) FROM ev)::BIGINT,
    COALESCE((SELECT AVG(modules) FROM depth), 0),
    (SELECT COUNT(*) FROM um WHERE module = 'storage')::BIGINT,
    (SELECT COUNT(*) FROM um WHERE module = 'vault')::BIGINT,
    (SELECT COUNT(*) FROM um WHERE module = 'diary')::BIGINT,
    (SELECT COUNT(*) FROM um WHERE module = 'gift_box')::BIGINT,
    (SELECT COUNT(*) FROM um WHERE module = 'tasks')::BIGINT,
    (SELECT COUNT(*) FROM um WHERE module = 'referral')::BIGINT;
$$;

-- Error rate per feature — ONLY where a failure event actually exists. Uploads
-- have no failure event (a failed upload logs nothing), so no upload error rate
-- is derivable; the two computable ones are the convert-to-Word pipeline and
-- vault unlock. The web computes fail / (ok + fail).
CREATE OR REPLACE FUNCTION admin_feature_error_rates(p_days INT)
RETURNS TABLE(feature TEXT, ok_count BIGINT, fail_count BIGINT)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT event_type, COUNT(*) AS n
    FROM usage_events
    WHERE created_at >= NOW() - (p_days || ' days')::interval
    GROUP BY event_type
  )
  SELECT * FROM (VALUES
    ('convert',
      COALESCE((SELECT n FROM c WHERE event_type = 'docx_done'), 0)::BIGINT,
      COALESCE((SELECT n FROM c WHERE event_type = 'docx_failed'), 0)::BIGINT),
    ('vault_unlock',
      COALESCE((SELECT n FROM c WHERE event_type = 'vault_open'), 0)::BIGINT,
      COALESCE((SELECT n FROM c WHERE event_type = 'vault_unlock_failed'), 0)::BIGINT)
  ) AS t(feature, ok_count, fail_count);
$$;

-- ============================================================================
-- Section 6 — Storage / quota dashboard
-- ============================================================================

-- Distribution of per-user storage fill (storage_used / storage_limit) into
-- fixed 20%-wide buckets, plus a 100%+ overflow bucket (vault uploads can push a
-- user past their limit — see CLAUDE.md). Guards storage_limit = 0.
CREATE OR REPLACE FUNCTION admin_storage_histogram()
RETURNS TABLE(bucket TEXT, users BIGINT)
LANGUAGE sql STABLE AS $$
  WITH u AS (
    SELECT CASE WHEN storage_limit > 0
                THEN (storage_used::numeric / storage_limit) * 100
                ELSE 0 END AS pct
    FROM users
  )
  SELECT bucket, COUNT(*)::BIGINT
  FROM (
    SELECT CASE
      WHEN pct >= 100 THEN '100+'
      WHEN pct >= 80  THEN '80-100'
      WHEN pct >= 60  THEN '60-80'
      WHEN pct >= 40  THEN '40-60'
      WHEN pct >= 20  THEN '20-40'
      ELSE '0-20'
    END AS bucket
    FROM u
  ) x
  GROUP BY bucket;
$$;

-- Distinct users hitting each storage signal per Bangkok day: the two soft
-- warning thresholds (80 / 95 — see STORAGE_WARN_THRESHOLD_LOW/HIGH; NOT 100)
-- and the true 100%-full/upload-blocked case, which is the SEPARATE
-- feature_blocked_quota event (storage_quota_warning_shown never carries 100).
CREATE OR REPLACE FUNCTION admin_storage_warnings_daily(p_days INT)
RETURNS TABLE(day DATE, warn80 BIGINT, warn95 BIGINT, blocked BIGINT)
LANGUAGE sql STABLE AS $$
  WITH e AS (
    SELECT (created_at AT TIME ZONE 'Asia/Bangkok')::date AS day,
           event_type, user_id,
           metadata->>'threshold' AS thr
    FROM usage_events
    WHERE created_at >= NOW() - (p_days || ' days')::interval
      AND event_type IN ('storage_quota_warning_shown', 'feature_blocked_quota')
  )
  SELECT day,
    COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'storage_quota_warning_shown' AND thr = '80')::BIGINT,
    COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'storage_quota_warning_shown' AND thr = '95')::BIGINT,
    COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'feature_blocked_quota')::BIGINT
  FROM e
  GROUP BY day
  ORDER BY day;
$$;

-- ============================================================================
-- Section 5 — Referral / marketing dashboard
-- ============================================================================
-- NOTE: there is NO campaign/creator/hook_id/content tagging in the schema
-- (confirmed). This section is built ONLY on per-user referral_code + the
-- referrals ledger; campaign attribution is a "Coming soon" placeholder on the
-- web, not a fabricated scheme.

-- Referral funnel: codes issued (cumulative — every user gets one lazily) →
-- redemption attempts (referral_code_entered) → successful redemptions
-- (referral_code_activated) within the window. issued_codes is all-time; the two
-- event counts are windowed (they are events, not a standing population).
CREATE OR REPLACE FUNCTION admin_referral_funnel(p_since TIMESTAMPTZ)
RETURNS TABLE(issued_codes BIGINT, entered BIGINT, activated BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COUNT(*) FROM users WHERE referral_code IS NOT NULL)::BIGINT,
    (SELECT COUNT(*) FROM usage_events
      WHERE event_type = 'referral_code_entered' AND created_at >= p_since)::BIGINT,
    (SELECT COUNT(*) FROM usage_events
      WHERE event_type = 'referral_code_activated' AND created_at >= p_since)::BIGINT;
$$;

-- Creator leaderboard: users ranked by cumulative successful referrals
-- (users.referral_count, bumped atomically by redeem_referral — migration 010).
CREATE OR REPLACE FUNCTION admin_top_referrers(p_limit INT)
RETURNS TABLE(
  user_id        UUID,
  display_name   TEXT,
  referral_code  TEXT,
  referral_count BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT id, display_name, referral_code, referral_count::BIGINT
  FROM users
  WHERE COALESCE(referral_count, 0) > 0
  ORDER BY referral_count DESC
  LIMIT p_limit;
$$;
