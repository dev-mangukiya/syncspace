package database

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/models"
)

// StoreRefreshToken hashes and stores a refresh token
func (db *DB) StoreRefreshToken(userID uuid.UUID, rawToken string, expiresAt time.Time) error {
	hash := hashToken(rawToken)
	_, err := db.Exec(`
		INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id)
		VALUES ($1, $2, $3, uuid_generate_v4())
	`, userID, hash, expiresAt)
	if err != nil {
		return fmt.Errorf("store refresh token: %w", err)
	}
	return nil
}

// ValidateRefreshToken checks if a raw token exists and is not expired.
// Returns the token record on success. Does NOT consume it — call RotateRefreshToken for that.
func (db *DB) ValidateRefreshToken(rawToken string) (*models.RefreshToken, error) {
	hash := hashToken(rawToken)
	rt := &models.RefreshToken{}
	err := db.QueryRow(`
		SELECT id, user_id, token_hash, expires_at, created_at, family_id
		FROM refresh_tokens
		WHERE token_hash = $1 AND expires_at > NOW()
	`, hash).Scan(&rt.ID, &rt.UserID, &rt.TokenHash, &rt.ExpiresAt, &rt.CreatedAt, &rt.FamilyID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("validate refresh token: %w", err)
	}
	return rt, nil
}

// RotateRefreshToken atomically deletes the old token and inserts a new one in the same family.
// This implements token rotation: each refresh token can only be used once.
func (db *DB) RotateRefreshToken(oldTokenRaw, newTokenRaw string, userID uuid.UUID, expiresAt time.Time, familyID uuid.UUID) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	oldHash := hashToken(oldTokenRaw)
	newHash := hashToken(newTokenRaw)

	// Delete the old token
	res, err := tx.Exec(`DELETE FROM refresh_tokens WHERE token_hash = $1`, oldHash)
	if err != nil {
		return fmt.Errorf("delete old token: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Token was already consumed — possible replay attack. Revoke entire family.
		tx.Exec(`DELETE FROM refresh_tokens WHERE family_id = $1`, familyID)
		tx.Commit()
		return fmt.Errorf("token reuse detected, family revoked")
	}

	// Insert the new token in the same family
	_, err = tx.Exec(`
		INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id)
		VALUES ($1, $2, $3, $4)
	`, userID, newHash, expiresAt, familyID)
	if err != nil {
		return fmt.Errorf("insert new token: %w", err)
	}

	return tx.Commit()
}

// RevokeUserRefreshTokens deletes all refresh tokens for a user (logout from all devices)
func (db *DB) RevokeUserRefreshTokens(userID uuid.UUID) error {
	_, err := db.Exec(`DELETE FROM refresh_tokens WHERE user_id = $1`, userID)
	return err
}

// CleanExpiredRefreshTokens removes expired tokens (housekeeping)
func (db *DB) CleanExpiredRefreshTokens() (int64, error) {
	res, err := db.Exec(`DELETE FROM refresh_tokens WHERE expires_at < NOW()`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// GetWorkspaceByShortID retrieves a workspace by its opaque short_id
func (db *DB) GetWorkspaceByShortID(shortID string) (*models.Workspace, error) {
	ws := &models.Workspace{}
	err := db.QueryRow(`
		SELECT id, name, slug, short_id, description, owner_id, template, language, is_public, is_demo, created_at, updated_at
		FROM workspaces WHERE short_id = $1
	`, shortID).Scan(&ws.ID, &ws.Name, &ws.Slug, &ws.ShortID, &ws.Description, &ws.OwnerID,
		&ws.Template, &ws.Language, &ws.IsPublic, &ws.IsDemo, &ws.CreatedAt, &ws.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get workspace by short_id: %w", err)
	}
	return ws, nil
}

func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}
