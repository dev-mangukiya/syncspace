package database

import (
	"fmt"

	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/models"
)

// CreateFileVersion inserts a new version snapshot.
// Restoring an old version creates a NEW "restore" version rather than deleting history.
func (db *DB) CreateFileVersion(workspaceID, fileID, authorID uuid.UUID, path, content, authorName, label, kind string) (*models.FileVersion, error) {
	v := &models.FileVersion{}
	err := db.QueryRow(`
		INSERT INTO file_versions (workspace_id, file_id, path, content, author_id, author_name, label, kind)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, file_id, workspace_id, path, content, author_id, author_name, label, kind, created_at
	`, workspaceID, fileID, path, content, authorID, authorName, label, kind).Scan(
		&v.ID, &v.FileID, &v.WorkspaceID, &v.Path, &v.Content,
		&v.AuthorID, &v.AuthorName, &v.Label, &v.Kind, &v.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create file version: %w", err)
	}
	return v, nil
}

// ListFileVersions returns all versions for a file, newest first.
// Content is excluded from the listing for performance (fetched individually).
func (db *DB) ListFileVersions(workspaceID uuid.UUID, path string, limit int) ([]models.FileVersion, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := db.Query(`
		SELECT id, file_id, workspace_id, path, '', author_id, author_name, label, kind, created_at
		FROM file_versions
		WHERE workspace_id = $1 AND path = $2
		ORDER BY created_at DESC
		LIMIT $3
	`, workspaceID, path, limit)
	if err != nil {
		return nil, fmt.Errorf("list file versions: %w", err)
	}
	defer rows.Close()

	var versions []models.FileVersion
	for rows.Next() {
		var v models.FileVersion
		if err := rows.Scan(&v.ID, &v.FileID, &v.WorkspaceID, &v.Path, &v.Content,
			&v.AuthorID, &v.AuthorName, &v.Label, &v.Kind, &v.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan file version: %w", err)
		}
		versions = append(versions, v)
	}
	return versions, nil
}

// GetFileVersion retrieves a single version with full content.
func (db *DB) GetFileVersion(versionID uuid.UUID) (*models.FileVersion, error) {
	v := &models.FileVersion{}
	err := db.QueryRow(`
		SELECT id, file_id, workspace_id, path, content, author_id, author_name, label, kind, created_at
		FROM file_versions
		WHERE id = $1
	`, versionID).Scan(
		&v.ID, &v.FileID, &v.WorkspaceID, &v.Path, &v.Content,
		&v.AuthorID, &v.AuthorName, &v.Label, &v.Kind, &v.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("get file version: %w", err)
	}
	return v, nil
}
