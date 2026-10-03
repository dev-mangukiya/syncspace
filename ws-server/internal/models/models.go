package models

import (
	"time"

	"github.com/google/uuid"
)

// User represents a registered user
type User struct {
	ID           uuid.UUID `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"` // never expose
	DisplayName  string    `json:"display_name"`
	AvatarURL    string    `json:"avatar_url"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Workspace represents a collaborative code workspace
type Workspace struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	ShortID     string    `json:"short_id"`
	Description string    `json:"description"`
	OwnerID     uuid.UUID `json:"owner_id"`
	Template    string    `json:"template"`
	Language    string    `json:"language"`
	IsPublic    bool      `json:"is_public"`
	IsDemo      bool      `json:"is_demo"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// WorkspaceRole defines access levels
type WorkspaceRole string

const (
	RoleOwner  WorkspaceRole = "owner"
	RoleEditor WorkspaceRole = "editor"
	RoleViewer WorkspaceRole = "viewer"
)

// WorkspaceMember represents a user's membership in a workspace
type WorkspaceMember struct {
	ID          uuid.UUID     `json:"id"`
	WorkspaceID uuid.UUID     `json:"workspace_id"`
	UserID      uuid.UUID     `json:"user_id"`
	Role        WorkspaceRole `json:"role"`
	JoinedAt    time.Time     `json:"joined_at"`
}

// File represents a file within a workspace
type File struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	Path        string    `json:"path"`
	Content     string    `json:"content"`
	Language    string    `json:"language"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Snapshot stores CRDT state for persistence
type Snapshot struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	FileID      uuid.UUID `json:"file_id"`
	CRDTState   []byte    `json:"-"`
	Version     int       `json:"version"`
	CreatedAt   time.Time `json:"created_at"`
}

// Execution records a code execution event
type Execution struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	UserID      uuid.UUID `json:"user_id"`
	Language    string    `json:"language"`
	Status      string    `json:"status"`
	ExitCode    *int      `json:"exit_code,omitempty"`
	DurationMs  *int      `json:"duration_ms,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

// RefreshToken represents a stored refresh token for token rotation
type RefreshToken struct {
	ID        uuid.UUID `json:"id"`
	UserID    uuid.UUID `json:"user_id"`
	TokenHash string    `json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
	FamilyID  uuid.UUID `json:"family_id"`
}

// WorkspaceWithRole is a workspace with the requesting user's role
type WorkspaceWithRole struct {
	Workspace
	Role WorkspaceRole `json:"role"`
}

// WorkspaceMessage represents a persisted chat message within a workspace
type WorkspaceMessage struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspace_id"`
	UserID      uuid.UUID `json:"user_id"`
	Username    string    `json:"username"`
	AvatarURL   string    `json:"avatar_url"`
	ColorSlot   int       `json:"color_slot"`
	Content     string    `json:"content"`
	CreatedAt   time.Time `json:"created_at"`
}

// WorkspaceRun represents an execution run recorded in history
type WorkspaceRun struct {
	ID          uuid.UUID  `json:"id"`
	RunID       string     `json:"run_id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	UserID      *uuid.UUID `json:"user_id,omitempty"`
	Username    string     `json:"username"`
	FilePath    string     `json:"file_path"`
	Language    string     `json:"language"`
	ExitCode    int        `json:"exit_code"`
	DurationMs  int64      `json:"duration_ms"`
	TimedOut    bool       `json:"timed_out"`
	Cancelled   bool       `json:"cancelled"`
	Truncated   bool       `json:"truncated"`
	Output      string     `json:"output"`
	CreatedAt   time.Time  `json:"created_at"`
}

