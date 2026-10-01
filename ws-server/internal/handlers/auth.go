package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/syncspace/ws-server/internal/auth"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/middleware"
	"github.com/syncspace/ws-server/internal/models"
)

// AuthHandler handles signup/login/refresh/logout/me endpoints
type AuthHandler struct {
	db          *database.DB
	authService *auth.Service
}

// NewAuthHandler creates a new AuthHandler
func NewAuthHandler(db *database.DB, authService *auth.Service) *AuthHandler {
	return &AuthHandler{db: db, authService: authService}
}

type signupRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	Identifier string `json:"identifier"` // email or username
}

// authResponse no longer contains the JWT token — it's in an httpOnly cookie.
// The response body only contains user info and a CSRF token (readable by JS).
type authResponse struct {
	User      interface{} `json:"user"`
	CSRFToken string      `json:"csrf_token"`
}

var (
	emailRegex    = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)
	usernameRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)
)

// issueTokensAndCookies creates access + refresh tokens, sets cookies, returns CSRF token
func (h *AuthHandler) issueTokensAndCookies(w http.ResponseWriter, user *models.User) (string, error) {
	// Generate short-lived access token (JWT, 15 min)
	accessToken, err := h.authService.GenerateAccessToken(user.ID, user.Username, user.Email)
	if err != nil {
		return "", err
	}

	// Generate refresh token (random, stored in DB)
	refreshToken, err := h.authService.GenerateRefreshToken()
	if err != nil {
		return "", err
	}

	// Store refresh token hash in DB
	expiresAt := time.Now().Add(h.authService.RefreshTTL())
	if err := h.db.StoreRefreshToken(user.ID, refreshToken, expiresAt); err != nil {
		return "", err
	}

	// Set httpOnly cookies for access + refresh tokens
	h.authService.SetAuthCookies(w, accessToken, refreshToken)

	// Generate CSRF token and set it in a non-httpOnly cookie (JS-readable)
	csrfToken, err := h.authService.GenerateCSRFToken()
	if err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_csrf",
		Value:    csrfToken,
		Path:     "/",
		MaxAge:   int(h.authService.RefreshTTL().Seconds()),
		HttpOnly: false, // JS must read this to send in X-CSRF-Token header
		Secure:   false, // set to true in production
		SameSite: http.SameSiteLaxMode,
	})

	return csrfToken, nil
}

// Signup handles user registration
func (h *AuthHandler) Signup(w http.ResponseWriter, r *http.Request) {
	var req signupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Input validation
	req.Username = strings.TrimSpace(req.Username)
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	if !usernameRegex.MatchString(req.Username) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "username must be 3-32 characters, alphanumeric, hyphens, or underscores",
		})
		return
	}

	if !emailRegex.MatchString(req.Email) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid email address"})
		return
	}

	if len(req.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "password must be at least 8 characters",
		})
		return
	}

	// Check for existing user
	existingEmail, _ := h.db.GetUserByEmail(req.Email)
	if existingEmail != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
		return
	}

	existingUsername, _ := h.db.GetUserByUsername(req.Username)
	if existingUsername != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "username already taken"})
		return
	}

	// Hash password
	hash, err := h.authService.HashPassword(req.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}

	// Create user
	user, err := h.db.CreateUser(req.Username, req.Email, hash)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create user"})
		return
	}

	// Issue tokens and set cookies
	csrfToken, err := h.issueTokensAndCookies(w, user)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate tokens"})
		return
	}

	writeJSON(w, http.StatusCreated, authResponse{User: user, CSRFToken: csrfToken})
}

// Login handles user authentication
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Support both 'identifier' and legacy 'email' field
	identifier := strings.TrimSpace(req.Identifier)
	if identifier == "" {
		identifier = strings.TrimSpace(req.Email)
	}

	if identifier == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email/username and password are required"})
		return
	}

	// Try email first, then username
	var user *models.User
	var err error

	if strings.Contains(identifier, "@") {
		user, err = h.db.GetUserByEmail(strings.ToLower(identifier))
	} else {
		user, err = h.db.GetUserByUsername(identifier)
	}

	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	if !h.authService.CheckPassword(req.Password, user.PasswordHash) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	// Issue tokens and set cookies
	csrfToken, err := h.issueTokensAndCookies(w, user)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate tokens"})
		return
	}

	writeJSON(w, http.StatusOK, authResponse{User: user, CSRFToken: csrfToken})
}

// Refresh issues a new access token using the refresh token cookie.
// Implements token rotation: old refresh token is consumed, new one issued.
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	// Read refresh token from cookie
	cookie, err := r.Cookie("syncspace_refresh")
	if err != nil || cookie.Value == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing refresh token"})
		return
	}

	// Validate refresh token
	rt, err := h.db.ValidateRefreshToken(cookie.Value)
	if err != nil || rt == nil {
		// Clear cookies on invalid token
		h.authService.ClearAuthCookies(w)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired refresh token"})
		return
	}

	// Get the user
	user, err := h.db.GetUserByID(rt.UserID)
	if err != nil || user == nil {
		h.authService.ClearAuthCookies(w)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}

	// Generate new token pair
	newAccessToken, err := h.authService.GenerateAccessToken(user.ID, user.Username, user.Email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate access token"})
		return
	}

	newRefreshToken, err := h.authService.GenerateRefreshToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate refresh token"})
		return
	}

	// Rotate: consume old, store new (same family)
	expiresAt := time.Now().Add(h.authService.RefreshTTL())
	if err := h.db.RotateRefreshToken(cookie.Value, newRefreshToken, user.ID, expiresAt, rt.FamilyID); err != nil {
		log.Printf("Token rotation failed: %v", err)
		h.authService.ClearAuthCookies(w)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "token rotation failed — please log in again"})
		return
	}

	// Set new cookies
	h.authService.SetAuthCookies(w, newAccessToken, newRefreshToken)

	// Regenerate CSRF token
	csrfToken, _ := h.authService.GenerateCSRFToken()
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_csrf",
		Value:    csrfToken,
		Path:     "/",
		MaxAge:   int(h.authService.RefreshTTL().Seconds()),
		HttpOnly: false,
		Secure:   false,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, http.StatusOK, authResponse{User: user, CSRFToken: csrfToken})
}

// Logout clears auth cookies and revokes all refresh tokens for the user
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	// Try to revoke refresh tokens if we can identify the user
	claims := middleware.GetClaims(r)
	if claims != nil {
		h.db.RevokeUserRefreshTokens(claims.UserID)
	}

	h.authService.ClearAuthCookies(w)
	// Also clear the CSRF cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_csrf",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: false,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

// Me returns the current user's info
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return
	}

	user, err := h.db.GetUserByID(claims.UserID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}

	writeJSON(w, http.StatusOK, user)
}
