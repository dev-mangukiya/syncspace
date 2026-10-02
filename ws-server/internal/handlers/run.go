package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/models"
	"github.com/syncspace/ws-server/internal/realtime"
)

const (
	MaxOutputCapBytes   = 256 * 1024 // 256KB max output cap
	UserRunRateLimit    = 10         // 10 runs per minute per user
	GlobalConcurrencyCap = 5          // max 5 concurrent runs globally
)

// RunHandler manages secure code execution through exec-service
type RunHandler struct {
	db             *database.DB
	hub            *realtime.Hub
	execURL        string
	execSecret     string
	concurrencySem chan struct{}

	// Per-user rate limiting (sliding minute window)
	userRateMu sync.Mutex
	userRuns   map[uuid.UUID][]time.Time

	// Active workspace runs tracking for cancel & lock fallback
	activeRunsMu sync.RWMutex
	activeRuns   map[string]*ActiveRunInfo // workspaceID -> active run info

	// Local lock map when Redis is unavailable
	localLocksMu sync.Mutex
	localLocks   map[string]string // workspaceID -> "username:runId"
}

// ActiveRunInfo tracks the currently running execution in a workspace
type ActiveRunInfo struct {
	RunID       string
	WorkspaceID uuid.UUID
	UserID      uuid.UUID
	Username    string
	FilePath    string
	Language    string
	StartedAt   time.Time
}

// RunRequest represents incoming run parameters
type RunRequest struct {
	FilePath string `json:"file_path"`
	Code     string `json:"code"`
	Language string `json:"language"`
	Timeout  int    `json:"timeout,omitempty"`
}

// NewRunHandler creates a new RunHandler instance
func NewRunHandler(db *database.DB, hub *realtime.Hub, execURL, execSecret string) *RunHandler {
	if execURL == "" {
		execURL = "http://localhost:8081"
	}
	return &RunHandler{
		db:             db,
		hub:            hub,
		execURL:        execURL,
		execSecret:     execSecret,
		concurrencySem: make(chan struct{}, GlobalConcurrencyCap),
		userRuns:       make(map[uuid.UUID][]time.Time),
		activeRuns:     make(map[string]*ActiveRunInfo),
		localLocks:     make(map[string]string),
	}
}

// CheckUserRateLimit checks if user has exceeded 10 runs in the last 60 seconds (across all instances via Redis)
func (h *RunHandler) CheckUserRateLimit(ctx context.Context, userID uuid.UUID) bool {
	if h.hub != nil && h.hub.Redis != nil && h.hub.Redis.Client() != nil {
		rKey := fmt.Sprintf("exec_rate:%s:%d", userID.String(), time.Now().Unix()/60)
		count, err := h.hub.Redis.Client().Incr(ctx, rKey).Result()
		if err == nil {
			if count == 1 {
				h.hub.Redis.Client().Expire(ctx, rKey, 65*time.Second)
			}
			return count <= UserRunRateLimit
		}
	}

	h.userRateMu.Lock()
	defer h.userRateMu.Unlock()

	now := time.Now()
	cutoff := now.Add(-60 * time.Second)

	runs := h.userRuns[userID]
	valid := make([]time.Time, 0, len(runs))
	for _, t := range runs {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	if len(valid) >= UserRunRateLimit {
		h.userRuns[userID] = valid
		return false
	}

	valid = append(valid, now)
	h.userRuns[userID] = valid
	return true
}

// AcquireWorkspaceLock acquires single-runner lock for workspace (via Redis or fallback)
func (h *RunHandler) AcquireWorkspaceLock(ctx context.Context, wsID uuid.UUID, username, runID string) (bool, string) {
	lockKey := fmt.Sprintf("exec_lock:%s", wsID.String())
	val := fmt.Sprintf("%s:%s", username, runID)

	if h.hub != nil && h.hub.Redis != nil && h.hub.Redis.Client() != nil {
		ok, err := h.hub.Redis.Client().SetNX(ctx, lockKey, val, 20*time.Second).Result()
		if err != nil || !ok {
			current, _ := h.hub.Redis.Client().Get(ctx, lockKey).Result()
			runner := strings.Split(current, ":")[0]
			if runner == "" {
				runner = "Another user"
			}
			return false, runner
		}
		return true, ""
	}

	h.localLocksMu.Lock()
	defer h.localLocksMu.Unlock()
	if existing, found := h.localLocks[wsID.String()]; found {
		runner := strings.Split(existing, ":")[0]
		return false, runner
	}
	h.localLocks[wsID.String()] = val
	return true, ""
}

// ReleaseWorkspaceLock releases the workspace execution lock
func (h *RunHandler) ReleaseWorkspaceLock(wsID uuid.UUID) {
	lockKey := fmt.Sprintf("exec_lock:%s", wsID.String())
	if h.hub != nil && h.hub.Redis != nil && h.hub.Redis.Client() != nil {
		h.hub.Redis.Client().Del(context.Background(), lockKey)
	}

	h.localLocksMu.Lock()
	delete(h.localLocks, wsID.String())
	h.localLocksMu.Unlock()
}

// broadcastRunEvent sends WebSocket text messages to all workspace members
func (h *RunHandler) broadcastRunEvent(ws *models.Workspace, payload []byte) {
	h.hub.BroadcastToWorkspace(ws.ShortID, payload)
	if ws.Slug != "" && ws.Slug != ws.ShortID {
		h.hub.BroadcastToWorkspace(ws.Slug, payload)
	}
}

// Run executes code inside the Docker sandbox via exec-service
func (h *RunHandler) Run(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
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

	// Membership and Role check: ONLY owner or editor may run code
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role == "" && !ws.IsPublic {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	if role == models.RoleViewer || (role == "" && ws.IsPublic) {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "viewers are not permitted to run code",
		})
		return
	}

	// Rate limiting: max 10 runs per minute per user (checked across instances via Redis)
	if !h.CheckUserRateLimit(r.Context(), claims.UserID) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "rate limit exceeded: max 10 code runs per minute",
		})
		return
	}

	// Global concurrency cap: max 5 concurrent runs across server
	select {
	case h.concurrencySem <- struct{}{}:
		defer func() { <-h.concurrencySem }()
	default:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "server execution concurrency limit reached (max 5 concurrent runs); please try again shortly",
		})
		return
	}

	var req RunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// If code is not provided, fetch from DB
	if req.Code == "" && req.FilePath != "" {
		f, err := h.db.GetFile(ws.ID, req.FilePath)
		if err == nil && f != nil {
			req.Code = f.Content
			if req.Language == "" {
				req.Language = f.Language
			}
		}
	}

	if req.Code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code cannot be empty"})
		return
	}

	if req.Language == "" {
		req.Language = detectLanguage(req.FilePath)
	}

	// Clamp requested timeout to [1, 10] seconds.
	// Default is 10s. Client cannot exceed server cap of 10s.
	if req.Timeout <= 0 || req.Timeout > 10 {
		req.Timeout = 10
	}

	runID := uuid.New().String()[:8]

	// Acquire workspace execution lock
	acquired, currentRunner := h.AcquireWorkspaceLock(r.Context(), ws.ID, claims.Username, runID)
	if !acquired {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": fmt.Sprintf("%s is currently running code in this workspace", currentRunner),
		})
		return
	}
	defer h.ReleaseWorkspaceLock(ws.ID)

	activeInfo := &ActiveRunInfo{
		RunID:       runID,
		WorkspaceID: ws.ID,
		UserID:      claims.UserID,
		Username:    claims.Username,
		FilePath:    req.FilePath,
		Language:    req.Language,
		StartedAt:   time.Now(),
	}
	h.activeRunsMu.Lock()
	h.activeRuns[ws.ID.String()] = activeInfo
	h.activeRunsMu.Unlock()

	defer func() {
		h.activeRunsMu.Lock()
		delete(h.activeRuns, ws.ID.String())
		h.activeRunsMu.Unlock()
	}()

	// Broadcast run_started event to all workspace members
	startEvt, _ := json.Marshal(map[string]interface{}{
		"type":     "run_started",
		"runId":    runID,
		"user":     claims.Username,
		"file":     req.FilePath,
		"language": req.Language,
	})
	h.broadcastRunEvent(ws, startEvt)

	// Stream from exec-service
	execPayload, _ := json.Marshal(map[string]interface{}{
		"run_id":          runID,
		"code":            req.Code,
		"language":        req.Language,
		"timeout_seconds": req.Timeout,
	})

	execReq, err := http.NewRequestWithContext(r.Context(), "POST", h.execURL+"/api/exec/stream", bytes.NewReader(execPayload))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create execution request"})
		return
	}
	execReq.Header.Set("Content-Type", "application/json")
	if h.execSecret != "" {
		execReq.Header.Set("X-Exec-Secret", h.execSecret)
	}

	client := &http.Client{Timeout: 35 * time.Second}
	resp, err := client.Do(execReq)
	if err != nil {
		log.Printf("[Run] Failed to connect to exec-service at %s: %v", h.execURL, err)
		failEvt, _ := json.Marshal(map[string]interface{}{
			"type":       "run_finished",
			"runId":      runID,
			"exitCode":   -1,
			"durationMs": 0,
			"truncated":  false,
			"timedOut":   false,
			"cancelled":  false,
		})
		h.broadcastRunEvent(ws, failEvt)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "execution service unavailable",
		})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&errResp)
		writeJSON(w, resp.StatusCode, errResp)
		return
	}

	// Read NDJSON stream and relay to WebSocket clients
	scanner := bufio.NewScanner(resp.Body)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, MaxOutputCapBytes+1024)

	var outputBuffer strings.Builder
	var exitCode int
	var durationMs int64
	var peakMemoryBytes int64
	var timedOut bool
	var cancelled bool
	var truncated bool

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var evt struct {
			Stream          string `json:"stream"`
			Chunk           string `json:"chunk"`
			Event           string `json:"event"`
			RunID           string `json:"run_id"`
			ExitCode        int    `json:"exit_code"`
			DurationMs      int64  `json:"duration_ms"`
			PeakMemoryBytes int64  `json:"peak_memory_bytes"`
			TimedOut        bool   `json:"timed_out"`
			Cancelled       bool   `json:"cancelled"`
			OutputCapped    bool   `json:"output_capped"`
		}

		if err := json.Unmarshal(line, &evt); err != nil {
			continue
		}

		if evt.Event == "finished" {
			exitCode = evt.ExitCode
			durationMs = evt.DurationMs
			peakMemoryBytes = evt.PeakMemoryBytes
			timedOut = evt.TimedOut
			cancelled = evt.Cancelled
			if evt.OutputCapped {
				truncated = true
			}
			break
		}

		if evt.Chunk != "" {
			// Cap accumulated output
			if outputBuffer.Len()+len(evt.Chunk) <= MaxOutputCapBytes {
				outputBuffer.WriteString(evt.Chunk)
			} else if !truncated {
				remaining := MaxOutputCapBytes - outputBuffer.Len()
				if remaining > 0 {
					outputBuffer.WriteString(evt.Chunk[:remaining])
				}
				truncated = true
			}

			// Broadcast chunk to all members via WebSocket TEXT frame
			outMsg, _ := json.Marshal(map[string]interface{}{
				"type":   "run_output",
				"runId":  runID,
				"stream": evt.Stream,
				"chunk":  evt.Chunk,
			})
			h.broadcastRunEvent(ws, outMsg)
		}
	}

	finalOutput := outputBuffer.String()
	if truncated && !strings.Contains(finalOutput, "Output truncated") {
		finalOutput += "\n[Output truncated: exceeded 256KB cap]\n"
	}

	// Persist run history in Postgres
	runRecord := &models.WorkspaceRun{
		RunID:       runID,
		WorkspaceID: ws.ID,
		UserID:      &claims.UserID,
		Username:    claims.Username,
		FilePath:    req.FilePath,
		Language:    req.Language,
		ExitCode:    exitCode,
		DurationMs:  durationMs,
		TimedOut:    timedOut,
		Cancelled:   cancelled,
		Truncated:   truncated,
		Output:      finalOutput,
	}

	if err := h.db.SaveRun(runRecord); err != nil {
		log.Printf("[Run] Failed to persist run %s in DB: %v", runID, err)
	}

	// Broadcast run_finished event to all workspace members
	finishedEvt, _ := json.Marshal(map[string]interface{}{
		"type":            "run_finished",
		"runId":           runID,
		"exitCode":        exitCode,
		"durationMs":      durationMs,
		"truncated":       truncated,
		"timedOut":        timedOut,
		"cancelled":       cancelled,
		"peakMemoryBytes": peakMemoryBytes,
	})
	h.broadcastRunEvent(ws, finishedEvt)

	// Return summary to HTTP caller
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"run_id":            runID,
		"exit_code":         exitCode,
		"duration_ms":       durationMs,
		"peak_memory_bytes": peakMemoryBytes,
		"timed_out":         timedOut,
		"cancelled":         cancelled,
		"truncated":         truncated,
		"output":            finalOutput,
	})
}

// Cancel terminates the currently active run in a workspace
func (h *RunHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
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

	// Role check: Only owner or editor can cancel
	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role != models.RoleOwner && role != models.RoleEditor {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "only workspace owners or editors can cancel execution",
		})
		return
	}

	h.activeRunsMu.RLock()
	active := h.activeRuns[ws.ID.String()]
	h.activeRunsMu.RUnlock()

	if active == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no active execution to cancel"})
		return
	}

	// Call exec-service cancel
	cancelBody, _ := json.Marshal(map[string]string{"run_id": active.RunID})
	cancelReq, _ := http.NewRequestWithContext(r.Context(), "POST", h.execURL+"/api/exec/cancel", bytes.NewReader(cancelBody))
	cancelReq.Header.Set("Content-Type", "application/json")
	if h.execSecret != "" {
		cancelReq.Header.Set("X-Exec-Secret", h.execSecret)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	_, _ = client.Do(cancelReq)

	// Release lock immediately
	h.ReleaseWorkspaceLock(ws.ID)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "cancelled",
		"run_id": active.RunID,
	})
}

// ListRuns returns the recent runs for a workspace
func (h *RunHandler) ListRuns(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
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

	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role == "" && !ws.IsPublic {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}

	runs, err := h.db.ListWorkspaceRuns(ws.ID, 50)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list runs"})
		return
	}

	writeJSON(w, http.StatusOK, runs)
}

// GetLimits returns the active execution sandbox limits
func (h *RunHandler) GetLimits(w http.ResponseWriter, r *http.Request) {
	// Query exec-service /api/exec/limits
	req, _ := http.NewRequestWithContext(r.Context(), "GET", h.execURL+"/api/exec/limits", nil)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err == nil && resp.StatusCode == http.StatusOK {
		defer resp.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, resp.Body)
		return
	}

	// Fallback defaults if exec-service is temporarily unreachable
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"timeout_seconds":    10,
		"memory_limit":       "128m",
		"cpu_limit":          "0.5",
		"pids_limit":         64,
		"max_code_size_kb":   64,
		"max_output_size_kb": 256,
		"network":            "none",
		"read_only_rootfs":   true,
		"user":               "65534:65534",
	})
}
