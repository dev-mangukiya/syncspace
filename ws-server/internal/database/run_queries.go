package database

import (
	"database/sql"
	"fmt"

	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/models"
)

// SaveRun persists a completed execution run to history
func (db *DB) SaveRun(run *models.WorkspaceRun) error {
	query := `
		INSERT INTO workspace_runs (
			run_id, workspace_id, user_id, username, file_path, language,
			exit_code, duration_ms, timed_out, cancelled, truncated, output
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
		)
		RETURNING id, created_at
	`
	err := db.DB.QueryRow(
		query,
		run.RunID,
		run.WorkspaceID,
		run.UserID,
		run.Username,
		run.FilePath,
		run.Language,
		run.ExitCode,
		run.DurationMs,
		run.TimedOut,
		run.Cancelled,
		run.Truncated,
		run.Output,
	).Scan(&run.ID, &run.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to save run: %w", err)
	}
	return nil
}

// ListWorkspaceRuns returns the most recent runs for a workspace (up to limit, max 50)
func (db *DB) ListWorkspaceRuns(workspaceID uuid.UUID, limit int) ([]models.WorkspaceRun, error) {
	if limit <= 0 || limit > 50 {
		limit = 50
	}

	query := `
		SELECT
			id, run_id, workspace_id, user_id, username, file_path, language,
			exit_code, duration_ms, timed_out, cancelled, truncated, output, created_at
		FROM workspace_runs
		WHERE workspace_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`
	rows, err := db.DB.Query(query, workspaceID, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to list runs: %w", err)
	}
	defer rows.Close()

	var runs []models.WorkspaceRun
	for rows.Next() {
		var r models.WorkspaceRun
		var userID sql.NullString
		err := rows.Scan(
			&r.ID,
			&r.RunID,
			&r.WorkspaceID,
			&userID,
			&r.Username,
			&r.FilePath,
			&r.Language,
			&r.ExitCode,
			&r.DurationMs,
			&r.TimedOut,
			&r.Cancelled,
			&r.Truncated,
			&r.Output,
			&r.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan run: %w", err)
		}
		if userID.Valid {
			if uid, err := uuid.Parse(userID.String); err == nil {
				r.UserID = &uid
			}
		}
		runs = append(runs, r)
	}

	if runs == nil {
		runs = []models.WorkspaceRun{}
	}
	return runs, nil
}
