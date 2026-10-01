package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/middleware"
	"github.com/syncspace/ws-server/internal/realtime"
)

type ChatHandler struct {
	db  *database.DB
	hub *realtime.Hub
}

func NewChatHandler(db *database.DB, hub *realtime.Hub) *ChatHandler {
	return &ChatHandler{db: db, hub: hub}
}

// List returns the latest 200 messages for a workspace in chronological order
func (h *ChatHandler) List(w http.ResponseWriter, r *http.Request) {
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

	// Check access: user must be member or workspace is public
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role == "" && !ws.IsPublic {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}

	messages, err := h.db.GetWorkspaceMessages(ws.ID, 200)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get messages"})
		return
	}

	writeJSON(w, http.StatusOK, messages)
}

type createMessageRequest struct {
	Content string `json:"content"`
}

// Create persists a new chat message and broadcasts it in real-time
func (h *ChatHandler) Create(w http.ResponseWriter, r *http.Request) {
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

	// Check membership: only members can post messages
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "must be a workspace member to chat"})
		return
	}

	var req createMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	content := strings.TrimSpace(req.Content)
	if content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message content cannot be empty"})
		return
	}
	if len(content) > 2000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message content exceeds 2000 characters"})
		return
	}

	msg, err := h.db.CreateWorkspaceMessage(ws.ID, claims.UserID, content)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to persist message"})
		return
	}

	// Broadcast via WebSocket text frame & Redis pub/sub
	eventPayload := map[string]interface{}{
		"type":    "chat_message",
		"message": msg,
	}
	eventBytes, _ := json.Marshal(eventPayload)

	// Broadcast on both short_id and slug channels so all connected clients receive it
	if ws.ShortID != "" {
		h.hub.BroadcastToWorkspace(ws.ShortID, eventBytes)
	}
	h.hub.BroadcastToWorkspace(ws.Slug, eventBytes)

	writeJSON(w, http.StatusCreated, msg)
}
