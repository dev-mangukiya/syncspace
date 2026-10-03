-- 007_demo_workspaces.up.sql
-- Add is_demo flag to workspaces for demo workspaces

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_workspaces_is_demo ON workspaces(is_demo);
