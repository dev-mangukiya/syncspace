-- 003_widen_short_id.up.sql
-- Widen short_id to 32 chars (full UUID hex) and backfill existing rows

-- Widen column
ALTER TABLE workspaces ALTER COLUMN short_id TYPE VARCHAR(36);

-- Re-backfill existing rows that have the truncated 10-char version
UPDATE workspaces
SET short_id = REPLACE(uuid_generate_v4()::text, '-', '')
WHERE LENGTH(short_id) < 32;
