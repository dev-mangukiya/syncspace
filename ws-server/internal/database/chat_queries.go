package database

import (
	"fmt"

	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/models"
)

// CreateWorkspaceMessage inserts a new chat message and returns it with author metadata
func (db *DB) CreateWorkspaceMessage(workspaceID, userID uuid.UUID, content string) (*models.WorkspaceMessage, error) {
	msg := &models.WorkspaceMessage{}
	err := db.QueryRow(`
		WITH inserted AS (
			INSERT INTO workspace_messages (workspace_id, user_id, content)
			VALUES ($1, $2, $3)
			RETURNING id, workspace_id, user_id, content, created_at
		)
		SELECT 
			i.id, i.workspace_id, i.user_id, 
			u.username, COALESCE(u.avatar_url, ''),
			COALESCE(wm.color_slot, 0),
			i.content, i.created_at
		FROM inserted i
		JOIN users u ON u.id = i.user_id
		LEFT JOIN workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = i.user_id
	`, workspaceID, userID, content).Scan(
		&msg.ID, &msg.WorkspaceID, &msg.UserID,
		&msg.Username, &msg.AvatarURL,
		&msg.ColorSlot,
		&msg.Content, &msg.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("create workspace message: %w", err)
	}
	return msg, nil
}

// GetWorkspaceMessages retrieves the most recent messages up to limit (max 200), in chronological order
func (db *DB) GetWorkspaceMessages(workspaceID uuid.UUID, limit int) ([]models.WorkspaceMessage, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}

	rows, err := db.Query(`
		SELECT id, workspace_id, user_id, username, avatar_url, color_slot, content, created_at
		FROM (
			SELECT 
				m.id, m.workspace_id, m.user_id,
				u.username, COALESCE(u.avatar_url, '') AS avatar_url,
				COALESCE(wm.color_slot, 0) AS color_slot,
				m.content, m.created_at
			FROM workspace_messages m
			JOIN users u ON u.id = m.user_id
			LEFT JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = m.user_id
			WHERE m.workspace_id = $1
			ORDER BY m.created_at DESC
			LIMIT $2
		) sub
		ORDER BY created_at ASC
	`, workspaceID, limit)
	if err != nil {
		return nil, fmt.Errorf("get workspace messages: %w", err)
	}
	defer rows.Close()

	messages := make([]models.WorkspaceMessage, 0)
	for rows.Next() {
		var msg models.WorkspaceMessage
		if err := rows.Scan(
			&msg.ID, &msg.WorkspaceID, &msg.UserID,
			&msg.Username, &msg.AvatarURL,
			&msg.ColorSlot,
			&msg.Content, &msg.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan workspace message: %w", err)
		}
		messages = append(messages, msg)
	}
	return messages, nil
}
