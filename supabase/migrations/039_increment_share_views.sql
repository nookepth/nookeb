-- 039_increment_share_views.sql — atomic view_count increment for file_shares.
--
-- Audit 2026-07-19 (Low): GET /share/:token counted views via read-modify-write
-- (SELECT view_count → UPDATE view_count + 1 in the app layer), so concurrent
-- viewers could all read the same value and overshoot a share's max_views cap.
-- Mirror increment_box_views (migration 033): a single atomic UPDATE, called via
-- RPC from routes/share.ts.
--
-- NOT auto-applied. Apply before (or with) the share.ts change that calls it —
-- but either order is safe: the route logs a warning and keeps serving the view
-- if the RPC is missing, so the count just doesn't tick until this is applied.

CREATE OR REPLACE FUNCTION increment_share_views(p_share_id UUID)
RETURNS void LANGUAGE sql AS $$
  UPDATE file_shares SET view_count = view_count + 1 WHERE id = p_share_id;
$$;
