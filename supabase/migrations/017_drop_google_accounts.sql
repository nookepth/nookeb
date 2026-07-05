-- 017_drop_google_accounts.sql — remove the Google Drive integration storage.
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor.
-- Apply AFTER deploying the code that removes the /integrations routes (the old
-- code reads this table; the new code never references it).
--
-- The Drive export feature is removed: it stored plaintext Google refresh
-- tokens (durable third-party credential exposure on any DB leak) and buffered
-- whole files in RAM to upload. Dropping the table revokes nothing at Google —
-- users who connected should ideally also revoke the app's access at
-- https://myaccount.google.com/permissions, but the tokens are gone from us.
--
-- CASCADE removes the table's own PK/FK/indexes; no other table references
-- google_accounts, and it had no triggers.

DROP TABLE IF EXISTS google_accounts CASCADE;
