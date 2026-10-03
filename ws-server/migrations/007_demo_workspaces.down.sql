-- 007_demo_workspaces.down.sql
DROP INDEX IF EXISTS idx_workspaces_is_demo;
ALTER TABLE workspaces DROP COLUMN IF EXISTS is_demo;
