-- 014_personal_quota_enforcement.sql — atomic per-file personal quota enforcement.
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor.
-- MUST be applied BEFORE deploying worker code that calls increment_personal_storage,
-- or every personal upload will fail at the reservation step.
--
-- Mirrors increment_team_storage (migration 005) for users.storage_used: the
-- worker RESERVES the declared size with p_enforce = TRUE before streaming a
-- file, and settles the declared-vs-actual drift (or refunds a failed upload)
-- with p_enforce = FALSE afterwards. The old batch-level snapshot check let a
-- user overshoot their limit by an entire batch; a single guarded UPDATE cannot.
--
-- Contract:
--   p_enforce = TRUE and p_delta > 0 → the increment is applied ONLY if it stays
--     within storage_limit; otherwise nothing changes and over_limit = TRUE.
--   p_enforce = FALSE (or p_delta <= 0) → unconditional adjustment, clamped at 0
--     (settle drift after upload / refund on failure / free space on delete).
--   Returns the row's resulting counters either way.
--
-- increment_storage_used (migration 003) is kept as-is — existing callers
-- (delete refunds, backfill script) still use it for unenforced adjustments.

CREATE OR REPLACE FUNCTION increment_personal_storage(
  p_user_id UUID,
  p_delta   BIGINT,
  p_enforce BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (storage_used BIGINT, storage_limit BIGINT, over_limit BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  v_used  BIGINT;
  v_limit BIGINT;
BEGIN
  IF p_enforce AND p_delta > 0 THEN
    UPDATE users u
       SET storage_used = COALESCE(u.storage_used, 0) + p_delta,
           updated_at   = NOW()
     WHERE u.id = p_user_id
       AND COALESCE(u.storage_used, 0) + p_delta <= u.storage_limit
    RETURNING u.storage_used, u.storage_limit INTO v_used, v_limit;

    IF v_used IS NULL THEN
      -- Guarded UPDATE matched nothing → the increment would exceed the limit
      -- (or the user doesn't exist). Nothing was changed.
      SELECT COALESCE(u.storage_used, 0), u.storage_limit
        INTO v_used, v_limit
        FROM users u
       WHERE u.id = p_user_id;
      RETURN QUERY SELECT v_used, v_limit, TRUE;
      RETURN;
    END IF;

    RETURN QUERY SELECT v_used, v_limit, FALSE;
  ELSE
    UPDATE users u
       SET storage_used = GREATEST(0, COALESCE(u.storage_used, 0) + p_delta),
           updated_at   = NOW()
     WHERE u.id = p_user_id
    RETURNING u.storage_used, u.storage_limit INTO v_used, v_limit;

    RETURN QUERY SELECT v_used, v_limit, FALSE;
  END IF;
END;
$$;
