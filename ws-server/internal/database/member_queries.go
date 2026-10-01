package database

import (
	"database/sql"
	"fmt"

	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/models"
)

// MemberWithUser joins workspace_members with users for the member list response
type MemberWithUser struct {
	MemberID    uuid.UUID            `json:"member_id"`
	UserID      uuid.UUID            `json:"user_id"`
	Username    string               `json:"username"`
	Email       string               `json:"email"`
	DisplayName string               `json:"display_name"`
	AvatarURL   string               `json:"avatar_url"`
	Role        models.WorkspaceRole `json:"role"`
	ColorSlot   int                  `json:"color_slot"`
}

// ListWorkspaceMembers returns all members of a workspace with user info.
// color_slot is read from the persisted column (assigned once at invite time).
func (db *DB) ListWorkspaceMembers(workspaceID uuid.UUID) ([]MemberWithUser, error) {
	rows, err := db.Query(`
		SELECT wm.id, wm.user_id, u.username, u.email,
		       COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''),
		       wm.role, wm.color_slot
		FROM workspace_members wm
		JOIN users u ON wm.user_id = u.id
		WHERE wm.workspace_id = $1
		ORDER BY wm.color_slot ASC
	`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}
	defer rows.Close()

	var members []MemberWithUser
	for rows.Next() {
		var m MemberWithUser
		err := rows.Scan(&m.MemberID, &m.UserID, &m.Username, &m.Email,
			&m.DisplayName, &m.AvatarURL, &m.Role, &m.ColorSlot)
		if err != nil {
			return nil, fmt.Errorf("scan member: %w", err)
		}
		members = append(members, m)
	}
	return members, nil
}

// GetMemberColorSlot returns the persisted color slot for a specific user.
func (db *DB) GetMemberColorSlot(workspaceID, userID uuid.UUID) (int, error) {
	var slot int
	err := db.QueryRow(`
		SELECT color_slot FROM workspace_members
		WHERE workspace_id = $1 AND user_id = $2
	`, workspaceID, userID).Scan(&slot)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get color slot: %w", err)
	}
	return slot, nil
}

// AddWorkspaceMember adds a user as a member of a workspace.
// color_slot is assigned as max(existing slots) + 1, so it's stable across deletions.
func (db *DB) AddWorkspaceMember(workspaceID, userID uuid.UUID, role models.WorkspaceRole) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Get the next available slot (max + 1, not count — survives deletions)
	var nextSlot int
	err = tx.QueryRow(`
		SELECT COALESCE(MAX(color_slot), -1) + 1
		FROM workspace_members
		WHERE workspace_id = $1
	`, workspaceID).Scan(&nextSlot)
	if err != nil {
		return fmt.Errorf("get next slot: %w", err)
	}

	_, err = tx.Exec(`
		INSERT INTO workspace_members (workspace_id, user_id, role, color_slot)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (workspace_id, user_id) DO NOTHING
	`, workspaceID, userID, role, nextSlot)
	if err != nil {
		return fmt.Errorf("add member: %w", err)
	}

	return tx.Commit()
}

// UpdateMemberRole changes a member's role
func (db *DB) UpdateMemberRole(workspaceID, userID uuid.UUID, role models.WorkspaceRole) error {
	res, err := db.Exec(`
		UPDATE workspace_members SET role = $3
		WHERE workspace_id = $1 AND user_id = $2
	`, workspaceID, userID, role)
	if err != nil {
		return fmt.Errorf("update role: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("member not found")
	}
	return nil
}

// RemoveWorkspaceMember removes a user from a workspace
func (db *DB) RemoveWorkspaceMember(workspaceID, userID uuid.UUID) error {
	res, err := db.Exec(`
		DELETE FROM workspace_members
		WHERE workspace_id = $1 AND user_id = $2
	`, workspaceID, userID)
	if err != nil {
		return fmt.Errorf("remove member: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("member not found")
	}
	return nil
}
