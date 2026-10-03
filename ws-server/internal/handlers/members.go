package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/middleware"
	"github.com/syncspace/ws-server/internal/models"
)

// MembersHandler manages workspace member operations
type MembersHandler struct {
	db *database.DB
}

// NewMembersHandler creates a new MembersHandler
func NewMembersHandler(db *database.DB) *MembersHandler {
	return &MembersHandler{db: db}
}

type inviteRequest struct {
	Identifier string `json:"identifier"` // email or username
	Role       string `json:"role"`       // editor or viewer
}

type updateRoleRequest struct {
	Role string `json:"role"`
}

// List returns all members of a workspace with color slots
func (h *MembersHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return
	}

	slug := chi.URLParam(r, "slug")
	ws, err := h.db.GetWorkspaceBySlug(slug)
	if err != nil || ws == nil {
		// Try short_id
		ws, err = h.db.GetWorkspaceByShortID(slug)
		if err != nil || ws == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
			return
		}
	}

	// Check membership
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role == "" && !ws.IsPublic {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}

	members, err := h.db.ListWorkspaceMembers(ws.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list members"})
		return
	}

	if members == nil {
		members = []database.MemberWithUser{}
	}
	writeJSON(w, http.StatusOK, members)
}

// Invite adds a user to a workspace by email or username
func (h *MembersHandler) Invite(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return
	}

	slug := chi.URLParam(r, "slug")
	ws, err := h.db.GetWorkspaceBySlug(slug)
	if err != nil || ws == nil {
		ws, err = h.db.GetWorkspaceByShortID(slug)
		if err != nil || ws == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
			return
		}
	}

	// Only owner or editor can invite
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role != models.RoleOwner && role != models.RoleEditor {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
		return
	}

	var req inviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if req.Identifier == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identifier (email or username) required"})
		return
	}

	// Validate role
	inviteRole := models.WorkspaceRole(req.Role)
	if inviteRole == "" {
		inviteRole = models.RoleEditor
	}
	if inviteRole != models.RoleEditor && inviteRole != models.RoleViewer {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role must be 'editor' or 'viewer'"})
		return
	}

	// Can't promote to owner
	if inviteRole == models.RoleOwner {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot assign owner role via invite"})
		return
	}

	// Find the user by email or username
	var user *models.User
	if len(req.Identifier) > 0 && req.Identifier[0] != '@' && contains(req.Identifier, "@") {
		user, _ = h.db.GetUserByEmail(req.Identifier)
	} else {
		// Strip leading @ if present
		username := req.Identifier
		if len(username) > 0 && username[0] == '@' {
			username = username[1:]
		}
		user, _ = h.db.GetUserByUsername(username)
	}

	if user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}

	// Can't invite yourself
	if user.ID == claims.UserID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot invite yourself"})
		return
	}

	// Bot enforcement: demo bot cannot join or be invited into non-demo workspaces
	if (user.Email == "demo-bot@syncspace.internal" || user.Username == "demo-bot") && !ws.IsDemo {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "forbidden: demo bot cannot join or be invited into non-demo workspaces",
		})
		return
	}

	// Add as member
	if err := h.db.AddWorkspaceMember(ws.ID, user.ID, inviteRole); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to add member"})
		return
	}

	// Return updated member list
	members, _ := h.db.ListWorkspaceMembers(ws.ID)
	writeJSON(w, http.StatusOK, members)
}

// UpdateRole changes a member's role
func (h *MembersHandler) UpdateRole(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return
	}

	slug := chi.URLParam(r, "slug")
	ws, err := h.db.GetWorkspaceBySlug(slug)
	if err != nil || ws == nil {
		ws, err = h.db.GetWorkspaceByShortID(slug)
		if err != nil || ws == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
			return
		}
	}

	// Only owner can change roles
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role != models.RoleOwner {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner can change roles"})
		return
	}

	targetUserID, err := uuid.Parse(chi.URLParam(r, "userId"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid user ID"})
		return
	}

	var req updateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	newRole := models.WorkspaceRole(req.Role)
	if newRole != models.RoleEditor && newRole != models.RoleViewer {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role must be 'editor' or 'viewer'"})
		return
	}

	if err := h.db.UpdateMemberRole(ws.ID, targetUserID, newRole); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "member not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "role updated"})
}

// Remove removes a member from a workspace
func (h *MembersHandler) Remove(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return
	}

	slug := chi.URLParam(r, "slug")
	ws, err := h.db.GetWorkspaceBySlug(slug)
	if err != nil || ws == nil {
		ws, err = h.db.GetWorkspaceByShortID(slug)
		if err != nil || ws == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
			return
		}
	}

	// Only owner can remove members
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role != models.RoleOwner {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner can remove members"})
		return
	}

	targetUserID, err := uuid.Parse(chi.URLParam(r, "userId"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid user ID"})
		return
	}

	// Can't remove yourself (owner)
	if targetUserID == claims.UserID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot remove yourself as owner"})
		return
	}

	if err := h.db.RemoveWorkspaceMember(ws.ID, targetUserID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "member not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "member removed"})
}

func contains(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
