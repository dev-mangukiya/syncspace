package middleware

import (
	"context"
	"net/http"

	"github.com/syncspace/ws-server/internal/auth"
)

type contextKey string

const UserClaimsKey contextKey = "user_claims"

// AuthMiddleware validates JWT from the httpOnly cookie (syncspace_access).
// The Authorization header is NO LONGER accepted — all auth flows use cookies.
func AuthMiddleware(authService *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Read access token from httpOnly cookie ONLY
			cookie, err := r.Cookie("syncspace_access")
			if err != nil || cookie.Value == "" {
				http.Error(w, `{"error":"missing auth cookie"}`, http.StatusUnauthorized)
				return
			}

			claims, err := authService.ValidateToken(cookie.Value)
			if err != nil {
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), UserClaimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// CSRFMiddleware validates the X-CSRF-Token header on state-changing requests.
// The CSRF token is stored in a non-httpOnly cookie (syncspace_csrf) so JS can read it,
// then sent back in the X-CSRF-Token header. This is the double-submit cookie pattern.
func CSRFMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Only validate on state-changing methods
			if r.Method == "GET" || r.Method == "HEAD" || r.Method == "OPTIONS" {
				next.ServeHTTP(w, r)
				return
			}


			// Read CSRF token from cookie
			csrfCookie, err := r.Cookie("syncspace_csrf")
			if err != nil || csrfCookie.Value == "" {
				http.Error(w, `{"error":"missing CSRF token"}`, http.StatusForbidden)
				return
			}

			// Read CSRF token from header
			csrfHeader := r.Header.Get("X-CSRF-Token")
			if csrfHeader == "" {
				http.Error(w, `{"error":"missing X-CSRF-Token header"}`, http.StatusForbidden)
				return
			}

			// Double-submit: cookie value must match header value
			if csrfCookie.Value != csrfHeader {
				http.Error(w, `{"error":"CSRF token mismatch"}`, http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// GetClaims extracts user claims from request context
func GetClaims(r *http.Request) *auth.Claims {
	claims, ok := r.Context().Value(UserClaimsKey).(*auth.Claims)
	if !ok {
		return nil
	}
	return claims
}
