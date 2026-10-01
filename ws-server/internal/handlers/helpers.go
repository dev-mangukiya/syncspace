package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/syncspace/ws-server/internal/auth"
	"github.com/syncspace/ws-server/internal/middleware"
)

// writeJSON writes a JSON response with the given status code
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// getClaims extracts user claims from request context
func getClaims(r *http.Request) *auth.Claims {
	return middleware.GetClaims(r)
}
