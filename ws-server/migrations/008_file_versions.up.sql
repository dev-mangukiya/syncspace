-- File version history: named + automatic snapshots of file content
CREATE TABLE IF NOT EXISTS file_versions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id     UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    content     TEXT NOT NULL,
    author_id   UUID NOT NULL REFERENCES users(id),
    author_name TEXT NOT NULL DEFAULT '',
    label       TEXT NOT NULL DEFAULT '',            -- user-provided name, or '' for auto snapshots
    kind        TEXT NOT NULL DEFAULT 'auto',        -- 'auto' | 'manual' | 'restore'
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_versions_workspace_path ON file_versions(workspace_id, path, created_at DESC);
