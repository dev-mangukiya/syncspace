package handlers

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/syncspace/ws-server/internal/auth"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/email"
	"github.com/syncspace/ws-server/internal/middleware"
	"github.com/syncspace/ws-server/internal/models"
)

// AuthConfig holds OAuth, CAPTCHA, and email configurations
type AuthConfig struct {
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURI  string
	TurnstileSecretKey string
	AppBaseURL         string
	SecureCookie       bool
}

// AuthHandler handles signup/login/refresh/logout/me/verify/oauth endpoints
type AuthHandler struct {
	db           *database.DB
	authService  *auth.Service
	emailService email.Service
	config       AuthConfig
}

// NewAuthHandler creates a new AuthHandler
func NewAuthHandler(db *database.DB, authService *auth.Service, emailService email.Service, cfg ...AuthConfig) *AuthHandler {
	c := AuthConfig{}
	if len(cfg) > 0 {
		c = cfg[0]
	}
	return &AuthHandler{db: db, authService: authService, emailService: emailService, config: c}
}

type signupRequest struct {
	Username       string `json:"username"`
	Email          string `json:"email"`
	Password       string `json:"password"`
	TurnstileToken string `json:"turnstile_token"`
	TermsAccepted  bool   `json:"terms_accepted"`
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

type turnstileVerifyRequest struct {
	Secret   string `json:"secret"`
	Response string `json:"response"`
	RemoteIP string `json:"remoteip,omitempty"`
}

type turnstileVerifyResponse struct {
	Success    bool     `json:"success"`
	ErrorCodes []string `json:"error-codes"`
}

func (h *AuthHandler) verifyTurnstile(token, remoteIP string) (bool, error) {
	secret := h.config.TurnstileSecretKey
	if secret == "" {
		// Cloudflare standard test secret (always passes)
		secret = "1x0000000000000000000000000000000AA"
	}

	body, _ := json.Marshal(turnstileVerifyRequest{
		Secret:   secret,
		Response: token,
		RemoteIP: remoteIP,
	})

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post("https://challenges.cloudflare.com/turnstile/v0/siteverify", "application/json", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	var verifyResp turnstileVerifyResponse
	if err := json.NewDecoder(resp.Body).Decode(&verifyResp); err != nil {
		return false, err
	}

	return verifyResp.Success, nil
}

// Signup handles user registration
func (h *AuthHandler) Signup(w http.ResponseWriter, r *http.Request) {
	var req signupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Terms of Service acceptance check
	if !req.TermsAccepted {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "terms_not_accepted",
			"message": "You must accept the Terms of Service and Privacy Policy to create an account.",
		})
		return
	}

	// Cloudflare Turnstile CAPTCHA verification check
	req.TurnstileToken = strings.TrimSpace(req.TurnstileToken)
	if req.TurnstileToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "turnstile_token_required",
			"message": "Cloudflare Turnstile verification token is required.",
		})
		return
	}

	valid, err := h.verifyTurnstile(req.TurnstileToken, r.RemoteAddr)
	if err != nil || !valid {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error":   "turnstile_verification_failed",
			"message": "Turnstile verification failed. Please complete the CAPTCHA.",
		})
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

	// Record terms acceptance
	_ = h.db.AcceptTerms(user.ID)

	// Generate email verification token (24-hour expiration)
	verifyBytes := make([]byte, 32)
	if _, err := rand.Read(verifyBytes); err == nil {
		verifyToken := hex.EncodeToString(verifyBytes)
		expires := time.Now().Add(24 * time.Hour)
		_ = h.db.SetEmailVerifyToken(user.ID, verifyToken, expires)
		log.Printf("[AUTH] Generated email verification token for %s", user.Email)

		// Dispatch verification email via email service
		baseURL := h.config.AppBaseURL
		if baseURL == "" {
			baseURL = "https://syncspace-bay.vercel.app"
		}
		verifyURL := fmt.Sprintf("%s/api/auth/verify-email?token=%s&redirect=true", baseURL, verifyToken)
		if h.emailService != nil {
			go func(to, username, url string) {
				if err := h.emailService.SendVerificationEmail(to, username, url); err != nil {
					log.Printf("[AUTH] Failed to send verification email to %s: %v", to, err)
				}
			}(user.Email, user.Username, verifyURL)
		}
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

// VerifyEmail validates an email verification token and marks the user's email as verified
func (h *AuthHandler) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" && r.Method == http.MethodPost {
		var req struct {
			Token string `json:"token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		token = strings.TrimSpace(req.Token)
	}

	if token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "verification token is required"})
		return
	}

	user, err := h.db.GetUserByVerifyToken(token)
	if err != nil || user == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "invalid_or_expired_token",
			"message": "Verification token is invalid or has expired",
		})
		return
	}

	if err := h.db.SetEmailVerified(user.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to verify email"})
		return
	}

	if r.Method == http.MethodGet && (strings.Contains(r.Header.Get("Accept"), "text/html") || r.URL.Query().Get("redirect") == "true") {
		http.Redirect(w, r, "/dashboard?verified=true", http.StatusSeeOther)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"message":        "Email successfully verified",
		"email_verified": true,
		"user_id":        user.ID,
	})
}

// ResendVerification generates a fresh verification token and dispatches the verification email
func (h *AuthHandler) ResendVerification(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	user, err := h.db.GetUserByID(claims.UserID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}

	if user.EmailVerified {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email already verified"})
		return
	}

	verifyBytes := make([]byte, 32)
	if _, err := rand.Read(verifyBytes); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate token"})
		return
	}
	verifyToken := hex.EncodeToString(verifyBytes)
	expires := time.Now().Add(24 * time.Hour)
	_ = h.db.SetEmailVerifyToken(user.ID, verifyToken, expires)

	baseURL := h.config.AppBaseURL
	if baseURL == "" {
		baseURL = "https://syncspace-bay.vercel.app"
	}
	verifyURL := fmt.Sprintf("%s/api/auth/verify-email?token=%s&redirect=true", baseURL, verifyToken)
	if h.emailService != nil {
		go func(to, username, url string) {
			_ = h.emailService.SendVerificationEmail(to, username, url)
		}(user.Email, user.Username, verifyURL)
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"message": "verification email sent",
	})
}

// ConfigStatus reports configuration health without leaking secret values
func (h *AuthHandler) ConfigStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"google_oauth_configured":  h.config.GoogleClientID != "" && h.config.GoogleClientSecret != "",
		"google_client_id_set":     h.config.GoogleClientID != "",
		"turnstile_configured":     h.config.TurnstileSecretKey != "",
		"turnstile_is_test_key":    h.config.TurnstileSecretKey == "1x0000000000000000000000000000000AA" || h.config.TurnstileSecretKey == "2x0000000000000000000000000000000AB",
		"email_service_configured": h.emailService != nil && h.emailService.IsConfigured(),
	})
}

// GoogleLogin initiates the Google OAuth authorization-code flow
func (h *AuthHandler) GoogleLogin(w http.ResponseWriter, r *http.Request) {
	clientID := h.config.GoogleClientID
	clientSecret := h.config.GoogleClientSecret
	if clientID == "" || clientSecret == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error":   "oauth_not_configured",
			"message": "Google OAuth is not configured on Render. Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Render Environment Variables.",
		})
		return
	}

	// Generate cryptographically secure random state (32 bytes = 64 hex chars) for CSRF protection
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate oauth state"})
		return
	}
	state := hex.EncodeToString(b)

	// Set syncspace_oauth_state cookie (SameSite=Lax is REQUIRED for cross-site top-level redirects)
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_oauth_state",
		Value:    state,
		Path:     "/",
		MaxAge:   600, // 10 minutes
		HttpOnly: true,
		Secure:   h.config.SecureCookie,
		SameSite: http.SameSiteLaxMode,
	})

	// Determine redirect URI
	redirectURI := h.config.GoogleRedirectURI
	if redirectURI == "" {
		proto := "https"
		if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") == "http" {
			proto = "http"
		}
		host := r.Host
		if fHost := r.Header.Get("X-Forwarded-Host"); fHost != "" {
			host = fHost
		}
		redirectURI = fmt.Sprintf("%s://%s/api/auth/google/callback", proto, host)
	}

	params := url.Values{}
	params.Set("client_id", clientID)
	params.Set("redirect_uri", redirectURI)
	params.Set("response_type", "code")
	params.Set("scope", "openid email profile")
	params.Set("state", state)
	params.Set("prompt", "select_account")

	authURL := "https://accounts.google.com/o/oauth2/v2/auth?" + params.Encode()
	http.Redirect(w, r, authURL, http.StatusTemporaryRedirect)
}

// GoogleCallback handles the Google OAuth redirect, exchanges code, and establishes session
func (h *AuthHandler) GoogleCallback(w http.ResponseWriter, r *http.Request) {
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		http.Redirect(w, r, "/auth/login?error="+url.QueryEscape("Google login was cancelled or failed"), http.StatusSeeOther)
		return
	}

	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")

	if state == "" || code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "invalid_request",
			"message": "Missing state or code parameter",
		})
		return
	}

	// Validate CSRF state against cookie
	stateCookie, err := r.Cookie("syncspace_oauth_state")
	if err != nil || stateCookie.Value == "" || stateCookie.Value != state {
		log.Printf("[OAUTH] State mismatch: cookie=%v vs param=%s", stateCookie, state)
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "invalid_oauth_state",
			"message": "Invalid or expired OAuth state parameter (CSRF verification failed).",
		})
		return
	}

	// Clear state cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_oauth_state",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.config.SecureCookie,
		SameSite: http.SameSiteLaxMode,
	})

	// Determine redirect URI used during authorization
	redirectURI := h.config.GoogleRedirectURI
	if redirectURI == "" {
		proto := "https"
		if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") == "http" {
			proto = "http"
		}
		host := r.Host
		if fHost := r.Header.Get("X-Forwarded-Host"); fHost != "" {
			host = fHost
		}
		redirectURI = fmt.Sprintf("%s://%s/api/auth/google/callback", proto, host)
	}

	// Exchange code for Google tokens
	tokenData := url.Values{}
	tokenData.Set("code", code)
	tokenData.Set("client_id", h.config.GoogleClientID)
	tokenData.Set("client_secret", h.config.GoogleClientSecret)
	tokenData.Set("redirect_uri", redirectURI)
	tokenData.Set("grant_type", "authorization_code")

	client := &http.Client{Timeout: 10 * time.Second}
	tokenResp, err := client.PostForm("https://oauth2.googleapis.com/token", tokenData)
	if err != nil {
		log.Printf("[OAUTH] Token exchange request failed: %v", err)
		http.Redirect(w, r, "/auth/login?error="+url.QueryEscape("Failed to exchange OAuth token with Google"), http.StatusSeeOther)
		return
	}
	defer tokenResp.Body.Close()

	var tokenResult struct {
		AccessToken string `json:"access_token"`
		IDToken     string `json:"id_token"`
		TokenType   string `json:"token_type"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(tokenResp.Body).Decode(&tokenResult); err != nil || tokenResult.AccessToken == "" {
		log.Printf("[OAUTH] Token exchange error: %s", tokenResult.Error)
		http.Redirect(w, r, "/auth/login?error="+url.QueryEscape("Google authorization code exchange failed"), http.StatusSeeOther)
		return
	}

	// Fetch user profile from Google UserInfo endpoint using AccessToken
	reqUser, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://www.googleapis.com/oauth2/v3/userinfo", nil)
	if err != nil {
		http.Redirect(w, r, "/auth/login?error=internal_error", http.StatusSeeOther)
		return
	}
	reqUser.Header.Set("Authorization", "Bearer "+tokenResult.AccessToken)

	userResp, err := client.Do(reqUser)
	if err != nil || userResp.StatusCode != http.StatusOK {
		log.Printf("[OAUTH] Fetch userinfo failed: %v", err)
		http.Redirect(w, r, "/auth/login?error="+url.QueryEscape("Failed to fetch Google user profile"), http.StatusSeeOther)
		return
	}
	defer userResp.Body.Close()

	var googleProfile struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := json.NewDecoder(userResp.Body).Decode(&googleProfile); err != nil || googleProfile.Sub == "" {
		http.Redirect(w, r, "/auth/login?error=invalid_profile", http.StatusSeeOther)
		return
	}

	// Discard Google tokens immediately — never persist tokens
	tokenResult.AccessToken = ""
	tokenResult.IDToken = ""

	// Confirm Google reports the email is verified
	if !googleProfile.EmailVerified {
		http.Redirect(w, r, "/auth/login?error="+url.QueryEscape("Google reports this email is unverified."), http.StatusSeeOther)
		return
	}

	googleEmail := strings.ToLower(strings.TrimSpace(googleProfile.Email))

	// Account linking logic:
	// 1. Check existing user by Google provider + provider_id
	user, err := h.db.GetUserByOAuth("google", googleProfile.Sub)
	if err != nil || user == nil {
		// 2. Existing email -> link Google identity to that account
		existingUser, _ := h.db.GetUserByEmail(googleEmail)
		if existingUser != nil {
			if err := h.db.LinkOAuth(existingUser.ID, "google", googleProfile.Sub); err != nil {
				log.Printf("[OAUTH] LinkOAuth failed: %v", err)
				http.Redirect(w, r, "/auth/login?error=link_failed", http.StatusSeeOther)
				return
			}
			user = existingUser
			user.EmailVerified = true
			user.OAuthProvider = "google"
		} else {
			// 3. New email -> Create an OAuth-only account
			username := sanitizeOAuthUsername(googleProfile.Name, googleEmail)
			for i := 0; i < 5; i++ {
				u, _ := h.db.GetUserByUsername(username)
				if u == nil {
					break
				}
				username = fmt.Sprintf("%s_%x", username[:min(len(username), 20)], time.Now().UnixNano()%10000)
			}

			displayName := strings.TrimSpace(googleProfile.Name)
			if displayName == "" {
				displayName = username
			}

			newUser, err := h.db.CreateOAuthUser(username, googleEmail, "google", googleProfile.Sub, displayName, googleProfile.Picture)
			if err != nil {
				log.Printf("[OAUTH] CreateOAuthUser failed: %v", err)
				http.Redirect(w, r, "/auth/login?error=create_user_failed", http.StatusSeeOther)
				return
			}
			user = newUser
		}
	}

	// Issue SyncSpace's normal session cookies exactly as regular login does
	_, err = h.issueTokensAndCookies(w, user)
	if err != nil {
		log.Printf("[OAUTH] Failed to issue session cookies: %v", err)
		http.Redirect(w, r, "/auth/login?error=session_error", http.StatusSeeOther)
		return
	}

	// Redirect to dashboard
	http.Redirect(w, r, "/dashboard", http.StatusSeeOther)
}

func sanitizeOAuthUsername(name, email string) string {
	base := ""
	if name != "" {
		reg := regexp.MustCompile(`[^a-zA-Z0-9_-]`)
		base = strings.ToLower(reg.ReplaceAllString(strings.TrimSpace(name), "_"))
	}
	if len(base) < 3 {
		parts := strings.Split(email, "@")
		reg := regexp.MustCompile(`[^a-zA-Z0-9_-]`)
		base = strings.ToLower(reg.ReplaceAllString(parts[0], "_"))
	}
	if len(base) < 3 {
		base = "user_" + base
	}
	if len(base) > 28 {
		base = base[:28]
	}
	return base
}
