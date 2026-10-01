-- 005_workspace_chat.up.sql
-- Workspace Chat Persistence (last 200 messages)

CREATE TABLE IF NOT EXISTS workspace_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_workspace_created 
    ON workspace_messages(workspace_id, created_at ASC);
