package database

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/models"
	"golang.org/x/crypto/bcrypt"
)

// CreateUser inserts a new user
func (db *DB) CreateUser(username, email, passwordHash string) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow(`
		INSERT INTO users (username, email, password_hash, display_name)
		VALUES ($1, $2, $3, $1)
		RETURNING id, username, email, password_hash, COALESCE(display_name,''), COALESCE(avatar_url,''),
		          email_verified, COALESCE(oauth_provider,''), terms_accepted_at, created_at, updated_at
	`, username, email, passwordHash).Scan(
		&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL,
		&user.EmailVerified, &user.OAuthProvider, &user.TermsAcceptedAt, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return user, nil
}

// userSelectCols is the standard column list for user queries
const userSelectCols = `id, username, email, password_hash, COALESCE(display_name,''), COALESCE(avatar_url,''),
	email_verified, COALESCE(oauth_provider,''), terms_accepted_at, created_at, updated_at`

func scanUser(row interface{ Scan(dest ...interface{}) error }, user *models.User) error {
	return row.Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL,
		&user.EmailVerified, &user.OAuthProvider, &user.TermsAcceptedAt, &user.CreatedAt, &user.UpdatedAt)
}

// GetUserByEmail retrieves a user by email, including password hash for auth
func (db *DB) GetUserByEmail(email string) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow(`SELECT `+userSelectCols+` FROM users WHERE email = $1`, email)
	if e := scanUser(err, user); e != nil {
		if e == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by email: %w", e)
	}
	return user, nil
}

// GetUserByID retrieves a user by ID
func (db *DB) GetUserByID(id uuid.UUID) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow(`SELECT `+userSelectCols+` FROM users WHERE id = $1`, id)
	if e := scanUser(err, user); e != nil {
		if e == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by id: %w", e)
	}
	return user, nil
}

// GetUserByUsername retrieves a user by username
func (db *DB) GetUserByUsername(username string) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow(`SELECT `+userSelectCols+` FROM users WHERE username = $1`, username)
	if e := scanUser(err, user); e != nil {
		if e == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by username: %w", e)
	}
	return user, nil
}

// ── Email Verification ──────────────────────────────────────

// SetEmailVerifyToken stores a verification token for a user
func (db *DB) SetEmailVerifyToken(userID uuid.UUID, token string, expires time.Time) error {
	_, err := db.Exec(`UPDATE users SET email_verify_token = $1, email_verify_expires = $2 WHERE id = $3`,
		token, expires, userID)
	return err
}

// GetUserByVerifyToken finds a user by their email verification token
func (db *DB) GetUserByVerifyToken(token string) (*models.User, error) {
	user := &models.User{}
	row := db.QueryRow(`SELECT `+userSelectCols+` FROM users WHERE email_verify_token = $1 AND email_verify_expires > NOW()`, token)
	if e := scanUser(row, user); e != nil {
		if e == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by verify token: %w", e)
	}
	return user, nil
}

// SetEmailVerified marks a user's email as verified and clears the token
func (db *DB) SetEmailVerified(userID uuid.UUID) error {
	_, err := db.Exec(`UPDATE users SET email_verified = true, email_verify_token = NULL, email_verify_expires = NULL WHERE id = $1`, userID)
	return err
}

// ── OAuth ────────────────────────────────────────────────────

// CreateOAuthUser creates a user from OAuth (no password, email pre-verified)
func (db *DB) CreateOAuthUser(username, email, provider, providerID, displayName, avatarURL string) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow(`
		INSERT INTO users (username, email, password_hash, display_name, avatar_url, email_verified, oauth_provider, oauth_provider_id, terms_accepted_at)
		VALUES ($1, $2, '', $3, $4, true, $5, $6, NOW())
		RETURNING `+userSelectCols,
		username, email, displayName, avatarURL, provider, providerID).Scan(
		&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL,
		&user.EmailVerified, &user.OAuthProvider, &user.TermsAcceptedAt, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create oauth user: %w", err)
	}
	return user, nil
}

// GetUserByOAuth finds a user by OAuth provider and provider-specific ID
func (db *DB) GetUserByOAuth(provider, providerID string) (*models.User, error) {
	user := &models.User{}
	row := db.QueryRow(`SELECT `+userSelectCols+` FROM users WHERE oauth_provider = $1 AND oauth_provider_id = $2`, provider, providerID)
	if e := scanUser(row, user); e != nil {
		if e == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by oauth: %w", e)
	}
	return user, nil
}

// LinkOAuth links an OAuth identity to an existing user
func (db *DB) LinkOAuth(userID uuid.UUID, provider, providerID string) error {
	_, err := db.Exec(`UPDATE users SET oauth_provider = $1, oauth_provider_id = $2, email_verified = true WHERE id = $3`,
		provider, providerID, userID)
	return err
}

// ── Terms ────────────────────────────────────────────────────

// AcceptTerms records that the user accepted terms of service
func (db *DB) AcceptTerms(userID uuid.UUID) error {
	_, err := db.Exec(`UPDATE users SET terms_accepted_at = NOW() WHERE id = $1`, userID)
	return err
}

// CreateWorkspace creates a new workspace and adds the owner as a member.
// CreateWorkspace creates a new workspace and adds the owner as a member.
// short_id is generated as the first 10 hex chars of a new UUID (opaque, non-guessable).
func (db *DB) CreateWorkspace(name, slug, description string, ownerID uuid.UUID, template, language string, isDemo bool) (*models.Workspace, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Generate opaque short_id from a fresh UUID (full 32 hex chars = 128 bits entropy)
	shortID := strings.ReplaceAll(uuid.New().String(), "-", "")

	ws := &models.Workspace{}
	err = tx.QueryRow(`
		INSERT INTO workspaces (name, slug, short_id, description, owner_id, template, language, is_demo)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, name, slug, short_id, description, owner_id, template, language, is_public, is_demo, created_at, updated_at
	`, name, slug, shortID, description, ownerID, template, language, isDemo).Scan(
		&ws.ID, &ws.Name, &ws.Slug, &ws.ShortID, &ws.Description, &ws.OwnerID,
		&ws.Template, &ws.Language, &ws.IsPublic, &ws.IsDemo, &ws.CreatedAt, &ws.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("insert workspace: %w", err)
	}

	_, err = tx.Exec(`
		INSERT INTO workspace_members (workspace_id, user_id, role, color_slot)
		VALUES ($1, $2, 'owner', 0)
	`, ws.ID, ownerID)
	if err != nil {
		return nil, fmt.Errorf("add owner as member: %w", err)
	}

	// If this is a demo workspace, ensure demo-bot is enrolled as an editor
	if isDemo {
		var botID uuid.UUID
		err := tx.QueryRow(`SELECT id FROM users WHERE email = 'demo-bot@syncspace.internal'`).Scan(&botID)
		if err == nil {
			_, _ = tx.Exec(`
				INSERT INTO workspace_members (workspace_id, user_id, role, color_slot)
				VALUES ($1, $2, 'editor', 7)
				ON CONFLICT (workspace_id, user_id) DO NOTHING
			`, ws.ID, botID)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}
	return ws, nil
}

// GetWorkspaceBySlug retrieves a workspace by its slug
func (db *DB) GetWorkspaceBySlug(slug string) (*models.Workspace, error) {
	ws := &models.Workspace{}
	err := db.QueryRow(`
		SELECT id, name, slug, short_id, description, owner_id, template, language, is_public, is_demo, created_at, updated_at
		FROM workspaces WHERE slug = $1
	`, slug).Scan(&ws.ID, &ws.Name, &ws.Slug, &ws.ShortID, &ws.Description, &ws.OwnerID,
		&ws.Template, &ws.Language, &ws.IsPublic, &ws.IsDemo, &ws.CreatedAt, &ws.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace by slug: %w", err)
	}
	return ws, nil
}

// GetWorkspaceByID retrieves a workspace by its ID
func (db *DB) GetWorkspaceByID(id uuid.UUID) (*models.Workspace, error) {
	ws := &models.Workspace{}
	err := db.QueryRow(`
		SELECT id, name, slug, short_id, description, owner_id, template, language, is_public, is_demo, created_at, updated_at
		FROM workspaces WHERE id = $1
	`, id).Scan(&ws.ID, &ws.Name, &ws.Slug, &ws.ShortID, &ws.Description, &ws.OwnerID,
		&ws.Template, &ws.Language, &ws.IsPublic, &ws.IsDemo, &ws.CreatedAt, &ws.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace by id: %w", err)
	}
	return ws, nil
}

// ListUserWorkspaces returns all workspaces a user is a member of
func (db *DB) ListUserWorkspaces(userID uuid.UUID) ([]models.WorkspaceWithRole, error) {
	rows, err := db.Query(`
		SELECT w.id, w.name, w.slug, w.short_id, w.description, w.owner_id, w.template, w.language, w.is_public, w.is_demo,
		       w.created_at, w.updated_at, wm.role
		FROM workspaces w
		JOIN workspace_members wm ON w.id = wm.workspace_id
		WHERE wm.user_id = $1
		ORDER BY w.updated_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list user workspaces: %w", err)
	}
	defer rows.Close()

	var workspaces []models.WorkspaceWithRole
	for rows.Next() {
		var wsr models.WorkspaceWithRole
		err := rows.Scan(&wsr.ID, &wsr.Name, &wsr.Slug, &wsr.ShortID, &wsr.Description, &wsr.OwnerID,
			&wsr.Template, &wsr.Language, &wsr.IsPublic, &wsr.IsDemo, &wsr.CreatedAt, &wsr.UpdatedAt, &wsr.Role)
		if err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		workspaces = append(workspaces, wsr)
	}
	return workspaces, nil
}

// EnsureDemoBotUser checks if the demo-bot account exists and creates it if missing.
// Race-safe: if two instances race on first startup, the loser's INSERT fails on the
// unique constraint and we re-fetch the winner's row instead of returning an error.
func (db *DB) EnsureDemoBotUser(password string) (*models.User, error) {
	user, err := db.GetUserByEmail("demo-bot@syncspace.internal")
	if err == nil && user != nil {
		return user, nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash bot password: %w", err)
	}
	user, err = db.CreateUser("demo-bot", "demo-bot@syncspace.internal", string(hash))
	if err != nil {
		// Unique constraint violation — another instance won the race.
		// Re-fetch and return the existing row.
		user, fetchErr := db.GetUserByEmail("demo-bot@syncspace.internal")
		if fetchErr == nil && user != nil {
			return user, nil
		}
		return nil, fmt.Errorf("create demo bot user: %w (re-fetch also failed: %v)", err, fetchErr)
	}
	return user, nil
}

// SetWorkspaceDemo toggles a workspace's is_demo flag and enrolls demo-bot as editor if true.
func (db *DB) SetWorkspaceDemo(workspaceID uuid.UUID, isDemo bool) error {
	_, err := db.Exec(`UPDATE workspaces SET is_demo = $2, updated_at = NOW() WHERE id = $1`, workspaceID, isDemo)
	if err != nil {
		return fmt.Errorf("set workspace demo: %w", err)
	}
	if isDemo {
		var botID uuid.UUID
		err := db.QueryRow(`SELECT id FROM users WHERE email = 'demo-bot@syncspace.internal'`).Scan(&botID)
		if err == nil {
			_, _ = db.Exec(`
				INSERT INTO workspace_members (workspace_id, user_id, role, color_slot)
				VALUES ($1, $2, 'editor', 7)
				ON CONFLICT (workspace_id, user_id) DO NOTHING
			`, workspaceID, botID)
		}
	}
	return nil
}

// GetMemberRole returns the role of a user in a workspace
func (db *DB) GetMemberRole(workspaceID, userID uuid.UUID) (models.WorkspaceRole, error) {
	var role models.WorkspaceRole
	err := db.QueryRow(`
		SELECT role FROM workspace_members
		WHERE workspace_id = $1 AND user_id = $2
	`, workspaceID, userID).Scan(&role)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get member role: %w", err)
	}
	return role, nil
}

// CreateFile creates a new file in a workspace
func (db *DB) CreateFile(workspaceID uuid.UUID, path, content, language string) (*models.File, error) {
	file := &models.File{}
	err := db.QueryRow(`
		INSERT INTO files (workspace_id, path, content, language)
		VALUES ($1, $2, $3, $4)
		RETURNING id, workspace_id, path, content, language, created_at, updated_at
	`, workspaceID, path, content, language).Scan(
		&file.ID, &file.WorkspaceID, &file.Path, &file.Content,
		&file.Language, &file.CreatedAt, &file.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create file: %w", err)
	}
	return file, nil
}

// GetFileByID retrieves a file by ID
func (db *DB) GetFileByID(id uuid.UUID) (*models.File, error) {
	file := &models.File{}
	err := db.QueryRow(`
		SELECT id, workspace_id, path, content, language, created_at, updated_at
		FROM files WHERE id = $1
	`, id).Scan(&file.ID, &file.WorkspaceID, &file.Path, &file.Content,
		&file.Language, &file.CreatedAt, &file.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get file by id: %w", err)
	}
	return file, nil
}

// ListFiles returns all files in a workspace
func (db *DB) ListFiles(workspaceID uuid.UUID) ([]models.File, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, path, content, language, created_at, updated_at
		FROM files WHERE workspace_id = $1
		ORDER BY path
	`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list files: %w", err)
	}
	defer rows.Close()

	var files []models.File
	for rows.Next() {
		var f models.File
		err := rows.Scan(&f.ID, &f.WorkspaceID, &f.Path, &f.Content,
			&f.Language, &f.CreatedAt, &f.UpdatedAt)
		if err != nil {
			return nil, fmt.Errorf("scan file: %w", err)
		}
		files = append(files, f)
	}
	return files, nil
}

// GetFile retrieves a single file by workspace and path
func (db *DB) GetFile(workspaceID uuid.UUID, path string) (*models.File, error) {
	file := &models.File{}
	err := db.QueryRow(`
		SELECT id, workspace_id, path, content, language, created_at, updated_at
		FROM files WHERE workspace_id = $1 AND path = $2
	`, workspaceID, path).Scan(&file.ID, &file.WorkspaceID, &file.Path, &file.Content,
		&file.Language, &file.CreatedAt, &file.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get file: %w", err)
	}
	return file, nil
}

// UpdateFileContent updates a file's content
func (db *DB) UpdateFileContent(workspaceID uuid.UUID, path, content string) (*models.File, error) {
	file := &models.File{}
	err := db.QueryRow(`
		UPDATE files SET content = $1, updated_at = NOW()
		WHERE workspace_id = $2 AND path = $3
		RETURNING id, workspace_id, path, content, language, created_at, updated_at
	`, content, workspaceID, path).Scan(
		&file.ID, &file.WorkspaceID, &file.Path, &file.Content,
		&file.Language, &file.CreatedAt, &file.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("file not found")
	}
	if err != nil {
		return nil, fmt.Errorf("update file content: %w", err)
	}
	return file, nil
}

// DeleteFile removes a file from a workspace
func (db *DB) DeleteFile(workspaceID uuid.UUID, path string) error {
	result, err := db.Exec(`DELETE FROM files WHERE workspace_id = $1 AND path = $2`, workspaceID, path)
	if err != nil {
		return fmt.Errorf("delete file: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("file not found")
	}
	return nil
}

// RenameFile changes a file's path and language within a workspace
func (db *DB) RenameFile(workspaceID uuid.UUID, oldPath, newPath, newLang string) error {
	result, err := db.Exec(`
		UPDATE files SET path = $3, language = $4, updated_at = NOW()
		WHERE workspace_id = $1 AND path = $2
	`, workspaceID, oldPath, newPath, newLang)
	if err != nil {
		return fmt.Errorf("rename file: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("source file not found")
	}
	return nil
}

// DeleteWorkspace deletes a workspace and all related data (CASCADE)
func (db *DB) DeleteWorkspace(id uuid.UUID) error {
	_, err := db.Exec("DELETE FROM workspaces WHERE id = $1", id)
	if err != nil {
		return fmt.Errorf("delete workspace: %w", err)
	}
	return nil
}

// CreateExecution records a code execution
func (db *DB) CreateExecution(workspaceID, userID uuid.UUID, language, status string, exitCode, durationMs int) (*models.Execution, error) {
	exec := &models.Execution{}
	err := db.QueryRow(`
		INSERT INTO executions (workspace_id, user_id, language, status, exit_code, duration_ms)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, workspace_id, user_id, language, status, exit_code, duration_ms, created_at
	`, workspaceID, userID, language, status, exitCode, durationMs).Scan(
		&exec.ID, &exec.WorkspaceID, &exec.UserID, &exec.Language,
		&exec.Status, &exec.ExitCode, &exec.DurationMs, &exec.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create execution: %w", err)
	}
	return exec, nil
}
