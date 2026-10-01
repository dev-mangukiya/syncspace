package middleware

import (
	"net/http"
)

// SecurityHeaders adds security headers to every response.
// These are defense-in-depth headers for XSS, clickjacking, MIME sniffing, etc.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()

		// Prevent MIME type sniffing
		h.Set("X-Content-Type-Options", "nosniff")

		// Clickjacking protection — only allow same-origin framing
		h.Set("X-Frame-Options", "SAMEORIGIN")

		// XSS filter (legacy browsers)
		h.Set("X-XSS-Protection", "1; mode=block")

		// Referrer policy — don't leak full URL to third parties
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")

		// Permissions-Policy — disable unused browser features
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")

		// Content Security Policy — restrictive CSP for API responses
		// The frontend has its own CSP; this covers API JSON responses
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")

		// Strict Transport Security (1 year, include subdomains)
		// Only effective over HTTPS, harmless over HTTP in dev
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

		next.ServeHTTP(w, r)
	})
}
