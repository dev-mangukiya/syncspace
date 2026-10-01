-- 002_refresh_tokens_and_workspace_ids.up.sql
-- Adds refresh tokens table and workspace short IDs

-- Refresh tokens for token rotation
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- family_id groups tokens from the same login session for rotation detection
    family_id UUID NOT NULL DEFAULT uuid_generate_v4()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- CSRF tokens (stored per-session in Redis, but we track them here for audit)
-- Actually, CSRF tokens will be derived from the session, not stored separately.

-- Add short_id to workspaces for opaque URLs (replacing guessable slugs in routes)
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS short_id VARCHAR(12);

-- Generate short_ids for existing workspaces using left(replace(uuid, '-', ''), 10)
UPDATE workspaces SET short_id = LEFT(REPLACE(id::text, '-', ''), 10) WHERE short_id IS NULL;

-- Make short_id NOT NULL and unique after backfill
ALTER TABLE workspaces ALTER COLUMN short_id SET NOT NULL;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_short_id_unique UNIQUE (short_id);

CREATE INDEX idx_workspaces_short_id ON workspaces(short_id);
