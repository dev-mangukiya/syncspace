package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/models"
)

// Ensure models import is used
var _ models.FileVersion

// VersionHandler manages file version history endpoints
type VersionHandler struct {
	db *database.DB
}

// NewVersionHandler creates a new VersionHandler
func NewVersionHandler(db *database.DB) *VersionHandler {
	return &VersionHandler{db: db}
}

// ListVersions returns the version history for a file.
// GET /api/workspaces/{slug}/versions?path=...
func (h *VersionHandler) ListVersions(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	slug := chi.URLParam(r, "slug")
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}

	ws, err := h.db.GetWorkspaceByShortID(slug)
	if err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}

	// Verify membership
	if _, err := h.db.GetMemberRole(ws.ID, claims.UserID); err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}

	versions, err := h.db.ListFileVersions(ws.ID, path, 50)
	if err != nil {
		http.Error(w, "failed to list versions", http.StatusInternalServerError)
		return
	}
	if versions == nil {
		versions = []models.FileVersion{}
	}

	writeJSON(w, http.StatusOK, versions)
}

// CreateVersion saves a named version snapshot.
// POST /api/workspaces/{slug}/versions
// Body: { "path": "...", "label": "...", "content": "..." }
func (h *VersionHandler) CreateVersion(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	slug := chi.URLParam(r, "slug")

	ws, err := h.db.GetWorkspaceByShortID(slug)
	if err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}

	role, err := h.db.GetMemberRole(ws.ID, claims.UserID)
	if err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}
	if role == "viewer" {
		http.Error(w, "editors only", http.StatusForbidden)
		return
	}

	var body struct {
		Path    string `json:"path"`
		Label   string `json:"label"`
		Content string `json:"content"`
		Kind    string `json:"kind"` // "manual" | "auto" | "restore"
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.Path == "" || body.Content == "" {
		http.Error(w, "path and content are required", http.StatusBadRequest)
		return
	}
	if body.Kind == "" {
		body.Kind = "manual"
	}

	// Look up file ID
	file, err := h.db.GetFile(ws.ID, body.Path)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}

	// Look up author name
	user, err := h.db.GetUserByID(claims.UserID)
	authorName := ""
	if err == nil {
		authorName = user.Username
	}

	v, err := h.db.CreateFileVersion(ws.ID, file.ID, claims.UserID, body.Path, body.Content, authorName, body.Label, body.Kind)
	if err != nil {
		http.Error(w, "failed to create version", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, v)
}

// GetVersion retrieves a single version with full content.
// GET /api/workspaces/{slug}/versions/{versionId}
func (h *VersionHandler) GetVersion(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	slug := chi.URLParam(r, "slug")
	versionIDStr := chi.URLParam(r, "versionId")
	versionID, err := uuid.Parse(versionIDStr)
	if err != nil {
		http.Error(w, "invalid version ID", http.StatusBadRequest)
		return
	}

	ws, err := h.db.GetWorkspaceByShortID(slug)
	if err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}

	if _, err := h.db.GetMemberRole(ws.ID, claims.UserID); err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}

	v, err := h.db.GetFileVersion(versionID)
	if err != nil || v.WorkspaceID != ws.ID {
		http.Error(w, "version not found", http.StatusNotFound)
		return
	}

	writeJSON(w, http.StatusOK, v)
}

// RestoreVersion applies an old version as a new snapshot (preserves history).
// POST /api/workspaces/{slug}/versions/{versionId}/restore
// Creates a new "restore" version with the old content, then updates the file.
func (h *VersionHandler) RestoreVersion(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	slug := chi.URLParam(r, "slug")
	versionIDStr := chi.URLParam(r, "versionId")
	versionID, err := uuid.Parse(versionIDStr)
	if err != nil {
		http.Error(w, "invalid version ID", http.StatusBadRequest)
		return
	}

	ws, err := h.db.GetWorkspaceByShortID(slug)
	if err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}

	role, err := h.db.GetMemberRole(ws.ID, claims.UserID)
	if err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}
	if role == "viewer" {
		http.Error(w, "editors only", http.StatusForbidden)
		return
	}

	// Get the old version
	oldVersion, err := h.db.GetFileVersion(versionID)
	if err != nil || oldVersion.WorkspaceID != ws.ID {
		http.Error(w, "version not found", http.StatusNotFound)
		return
	}

	user, err := h.db.GetUserByID(claims.UserID)
	authorName := ""
	if err == nil {
		authorName = user.Username
	}

	// Create a NEW "restore" version (doesn't delete anything)
	label := "Restored from " + oldVersion.CreatedAt.Format("Jan 2 15:04")
	if oldVersion.Label != "" {
		label = "Restored: " + oldVersion.Label
	}
	newVersion, err := h.db.CreateFileVersion(ws.ID, oldVersion.FileID, claims.UserID, oldVersion.Path, oldVersion.Content, authorName, label, "restore")
	if err != nil {
		http.Error(w, "failed to create restore version", http.StatusInternalServerError)
		return
	}

	// Also update the live file content
	if _, err := h.db.UpdateFileContent(ws.ID, oldVersion.Path, oldVersion.Content); err != nil {
		http.Error(w, "failed to update file", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, newVersion)
}
