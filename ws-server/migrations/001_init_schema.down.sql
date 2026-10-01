-- 001_init_schema.down.sql
-- Rollback: drop everything in reverse dependency order

DROP TRIGGER IF EXISTS files_updated_at ON files;
DROP TRIGGER IF EXISTS workspaces_updated_at ON workspaces;
DROP TRIGGER IF EXISTS users_updated_at ON users;
DROP FUNCTION IF EXISTS update_updated_at();

DROP TABLE IF EXISTS executions;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS workspace_role;
DROP EXTENSION IF EXISTS "uuid-ossp";
