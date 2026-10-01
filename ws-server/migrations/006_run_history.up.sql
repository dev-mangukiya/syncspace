-- 006_run_history.up.sql
CREATE TABLE IF NOT EXISTS workspace_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id VARCHAR(64) NOT NULL UNIQUE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    username VARCHAR(64) NOT NULL,
    file_path VARCHAR(255) NOT NULL,
    language VARCHAR(32) NOT NULL,
    exit_code INT NOT NULL,
    duration_ms BIGINT NOT NULL,
    timed_out BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    output TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_runs_ws_created ON workspace_runs(workspace_id, created_at DESC);
