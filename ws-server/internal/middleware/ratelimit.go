package middleware

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// RateLimiter implements a simple per-IP token bucket rate limiter.
// Designed for auth endpoints (login, signup) to prevent brute-force attacks.
type RateLimiter struct {
	mu       sync.RWMutex
	visitors map[string]*visitor
	limit    int           // max requests per window
	window   time.Duration // window duration
}

type visitor struct {
	count    int
	resetAt  time.Time
}

// NewRateLimiter creates a rate limiter allowing `limit` requests per `window` per IP.
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		visitors: make(map[string]*visitor),
		limit:    limit,
		window:   window,
	}
	// Clean up stale entries every window duration
	go rl.cleanup()
	return rl
}

func (rl *RateLimiter) cleanup() {
	ticker := time.NewTicker(rl.window)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, v := range rl.visitors {
			if now.After(v.resetAt) {
				delete(rl.visitors, ip)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *RateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	v, exists := rl.visitors[ip]

	if !exists || now.After(v.resetAt) {
		rl.visitors[ip] = &visitor{
			count:   1,
			resetAt: now.Add(rl.window),
		}
		return true
	}

	if v.count >= rl.limit {
		return false
	}

	v.count++
	return true
}

// Middleware returns an HTTP middleware that rate-limits by client IP.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract real client IP (split X-Forwarded-For if comma-separated list from proxy)
		ip := r.Header.Get("X-Forwarded-For")
		if ip != "" {
			if comma := strings.Index(ip, ","); comma != -1 {
				ip = strings.TrimSpace(ip[:comma])
			}
		} else if rip := r.Header.Get("X-Real-IP"); rip != "" {
			ip = rip
		} else {
			ip = r.RemoteAddr
		}

		if !rl.allow(ip) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"too many requests, please try again later"}`))
			return
		}

		next.ServeHTTP(w, r)
	})
}

// UserMiddleware returns an HTTP middleware that rate-limits by authenticated User ID (or IP as fallback).
func (rl *RateLimiter) UserMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := ""
		claims := GetClaims(r)
		if claims != nil && claims.UserID != uuid.Nil {
			key = "user:" + claims.UserID.String()
		} else {
			ip := r.Header.Get("X-Forwarded-For")
			if ip == "" {
				ip = r.Header.Get("X-Real-IP")
			}
			if ip == "" {
				ip = r.RemoteAddr
			}
			key = "ip:" + ip
		}

		if !rl.allow(key) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"too many messages, please slow down"}`))
			return
		}

		next.ServeHTTP(w, r)
	})
}
