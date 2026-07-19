-- 038_rls_backstop.sql — enable RLS (deny-all backstop) on every remaining table.
--
-- Security audit 2026-07-19 finding (High): RLS was enabled on only ~half the
-- tables. The others (users, spaces, folders, tags, legacy_boxes, …) were left
-- with RLS OFF, which — under Supabase's default grants — makes them reachable
-- by the anon/authenticated PostgREST roles with only the (publishable) anon
-- key, bypassing the API's membership checks entirely.
--
-- Fix: ALTER TABLE ... ENABLE ROW LEVEL SECURITY with NO policies. This app
-- never issues Supabase Auth sessions (auth.uid() can't map to a tenant here),
-- so "no policies" = deny-all for every non-service-role path. The API and
-- worker use the SERVICE ROLE key, which BYPASSES RLS — so this is purely a
-- backstop and has ZERO application impact (same spirit as rule 4 and the
-- migration 036 task tables).
--
-- Additive and idempotent-safe: ENABLE ROW LEVEL SECURITY is a no-op if already
-- enabled. NOT auto-applied; apply any time — no code change accompanies it.

-- Core tenant tables (migration 001) — only `files` had RLS before this.
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE spaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags          ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_tags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_pages    ENABLE ROW LEVEL SECURITY;

-- Referral system (migration 010).
ALTER TABLE referrals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_tiers ENABLE ROW LEVEL SECURITY;

-- Per-group notify toggle (migration 021).
ALTER TABLE group_notify_settings ENABLE ROW LEVEL SECURITY;

-- Legacy Box (migrations 033/034).
ALTER TABLE legacy_boxes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_box_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE pro_interest_log  ENABLE ROW LEVEL SECURITY;
