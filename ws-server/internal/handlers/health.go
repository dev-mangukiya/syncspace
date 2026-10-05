package handlers

import (
	"net/http"
	"runtime"
	"time"
)

var startTime = time.Now()

// HealthHandler returns service health status
type HealthHandler struct{}

// NewHealthHandler creates a new HealthHandler
func NewHealthHandler() *HealthHandler {
	return &HealthHandler{}
}

// Health returns basic health info
func (h *HealthHandler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":    "healthy",
		"service":   "syncspace-ws-server",
		"version":   "1.0.0",
		"uptime":    time.Since(startTime).String(),
		"goVersion": runtime.Version(),
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}
