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

	"github.com/google/uuid"
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
	User           interface{} `json:"user"`
	CSRFToken      string      `json:"csrf_token"`
	EmailDelivered bool        `json:"email_delivered"`
	EmailNotice    string      `json:"email_notice,omitempty"`
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
		return false, fmt.Errorf("turnstile secret key is not configured on server")
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
	var emailDelivered bool
	var emailNotice string

	verifyBytes := make([]byte, 32)
	if _, err := rand.Read(verifyBytes); err == nil {
		verifyToken := hex.EncodeToString(verifyBytes)
		expires := time.Now().Add(24 * time.Hour)
		_ = h.db.SetEmailVerifyToken(user.ID, verifyToken, expires)
		log.Printf("[AUTH] Generated email verification token for %s", user.Email)

		baseURL := h.config.AppBaseURL
		if baseURL == "" {
			baseURL = "https://syncspace-bay.vercel.app"
		}
		verifyURL := fmt.Sprintf("%s/api/auth/verify-email?token=%s&redirect=true", baseURL, verifyToken)

		if h.emailService != nil && h.emailService.IsConfigured() {
			if sendErr := h.emailService.SendVerificationEmail(user.Email, user.Username, verifyURL); sendErr != nil {
				log.Printf("[AUTH] Verification email delivery failed to %s: %v", user.Email, sendErr)
				emailDelivered = false
				emailNotice = "Email verification isn't available for this account yet. Sign in with Google to unlock Run instantly."
			} else {
				log.Printf("[AUTH] Verification email delivered to %s", user.Email)
				emailDelivered = true
				emailNotice = "Verification email sent. Please check your inbox."
			}
		} else {
			emailDelivered = false
			emailNotice = "Email verification isn't available for this account yet. Sign in with Google to unlock Run instantly."
		}
	}

	// Issue tokens and set cookies
	csrfToken, err := h.issueTokensAndCookies(w, user)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate tokens"})
		return
	}

	resp := authResponse{
		User:           user,
		CSRFToken:      csrfToken,
		EmailDelivered: emailDelivered,
		EmailNotice:    emailNotice,
	}

	writeJSON(w, http.StatusCreated, resp)
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

	if user.PasswordHash == "" || !h.authService.CheckPassword(req.Password, user.PasswordHash) {
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

	if h.emailService != nil && h.emailService.IsConfigured() {
		if sendErr := h.emailService.SendVerificationEmail(user.Email, user.Username, verifyURL); sendErr != nil {
			log.Printf("[AUTH] Resend verification email failed for %s: %v", user.Email, sendErr)
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"email_delivered": false,
				"message":         "Email verification isn't available for this account yet. Sign in with Google to unlock Run instantly.",
			})
			return
		}
	} else {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"email_delivered": false,
			"message":         "Email verification isn't available for this account yet. Sign in with Google to unlock Run instantly.",
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"email_delivered": true,
		"message":         "Verification email sent. Please check your inbox.",
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

	// Store return_to url if safe relative path
	if returnTo := r.URL.Query().Get("return_to"); returnTo != "" && strings.HasPrefix(returnTo, "/") && !strings.HasPrefix(returnTo, "//") {
		http.SetCookie(w, &http.Cookie{
			Name:     "syncspace_oauth_return",
			Value:    returnTo,
			Path:     "/",
			MaxAge:   600,
			HttpOnly: true,
			Secure:   h.config.SecureCookie,
			SameSite: http.SameSiteLaxMode,
		})
	}

	// If the user is currently authenticated, record their UserID in an httpOnly cookie
	// so the callback links directly to this session's existing account.
	if cookie, err := r.Cookie("syncspace_access"); err == nil && cookie.Value != "" {
		if claims, err := h.authService.ValidateToken(cookie.Value); err == nil && claims != nil {
			http.SetCookie(w, &http.Cookie{
				Name:     "syncspace_oauth_link_user",
				Value:    claims.UserID.String(),
				Path:     "/",
				MaxAge:   600,
				HttpOnly: true,
				Secure:   h.config.SecureCookie,
				SameSite: http.SameSiteLaxMode,
			})
		}
	} else {
		http.SetCookie(w, &http.Cookie{
			Name:     "syncspace_oauth_link_user",
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   h.config.SecureCookie,
			SameSite: http.SameSiteLaxMode,
		})
	}

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

	// Determine redirect destination (e.g. back to workspace if initiated from Run unlock prompt)
	dest := "/dashboard"
	if retCookie, err := r.Cookie("syncspace_oauth_return"); err == nil && retCookie.Value != "" && strings.HasPrefix(retCookie.Value, "/") && !strings.HasPrefix(retCookie.Value, "//") {
		dest = retCookie.Value
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_oauth_return",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.config.SecureCookie,
		SameSite: http.SameSiteLaxMode,
	})

	// Check if this OAuth flow was initiated from an active authenticated session
	var linkingUserID *uuid.UUID
	if linkCookie, err := r.Cookie("syncspace_oauth_link_user"); err == nil && linkCookie.Value != "" {
		if uid, err := uuid.Parse(linkCookie.Value); err == nil {
			linkingUserID = &uid
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_oauth_link_user",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.config.SecureCookie,
		SameSite: http.SameSiteLaxMode,
	})

	var user *models.User

	if linkingUserID != nil {
		// ── Path 1: Authenticated Session Linking ──
		// When initiated from an existing logged-in session, attach directly to that session's user_id.
		// Bypass email matching completely so the current user account is always linked.
		sessionUser, err := h.db.GetUserByID(*linkingUserID)
		if err != nil || sessionUser == nil {
			log.Printf("[OAUTH] Authenticated linking target user not found: %v", linkingUserID)
			http.Redirect(w, r, "/auth/login?error="+url.QueryEscape("Account linking failed: session user not found"), http.StatusSeeOther)
			return
		}

		// Ensure this Google identity (sub) is not already linked to another user
		existingOAuthUser, _ := h.db.GetUserByOAuth("google", googleProfile.Sub)
		if existingOAuthUser != nil && existingOAuthUser.ID != *linkingUserID {
			log.Printf("[OAUTH] Conflict: Google identity %s is already bound to user %s (linking attempted by %s)",
				googleProfile.Sub, existingOAuthUser.ID, *linkingUserID)
			http.Redirect(w, r, dest+"?error="+url.QueryEscape("This Google account is already linked to another SyncSpace account"), http.StatusSeeOther)
			return
		}

		if err := h.db.LinkOAuth(sessionUser.ID, "google", googleProfile.Sub); err != nil {
			log.Printf("[OAUTH] LinkOAuth failed for session user %s: %v", sessionUser.ID, err)
			http.Redirect(w, r, dest+"?error="+url.QueryEscape("Failed to link Google account"), http.StatusSeeOther)
			return
		}

		user = sessionUser
		user.EmailVerified = true
		user.OAuthProvider = "google"
	} else {
		// ── Path 2: Cold Google Login (No active session) ──
		// 1. Existing user by Google provider + provider_id
		existingOAuthUser, err := h.db.GetUserByOAuth("google", googleProfile.Sub)
		if err == nil && existingOAuthUser != nil {
			user = existingOAuthUser
		} else {
			// 2. Existing email match
			existingUser, _ := h.db.GetUserByEmail(googleEmail)
			if existingUser != nil {
				if !existingUser.EmailVerified {
					// ── Pre-hijacking Mitigation (Option a) ──
					// An unverified password account exists with this email address.
					// An attacker could have registered this email hoping to maintain backdoor access.
					// Invalidate the existing password hash entirely and revoke all active refresh tokens!
					log.Printf("[OAUTH] Cold login matched unverified account %s (%s). Invalidating standing password hash to prevent pre-hijacking backdoor.",
						existingUser.ID, existingUser.Email)
					if err := h.db.LinkOAuthInvalidatingPassword(existingUser.ID, "google", googleProfile.Sub); err != nil {
						log.Printf("[OAUTH] LinkOAuthInvalidatingPassword failed: %v", err)
						http.Redirect(w, r, "/auth/login?error=link_failed", http.StatusSeeOther)
						return
					}
					user = existingUser
					user.EmailVerified = true
					user.OAuthProvider = "google"
					user.PasswordHash = ""
				} else {
					// Account was already verified by the true owner; link without password invalidation
					if err := h.db.LinkOAuth(existingUser.ID, "google", googleProfile.Sub); err != nil {
						log.Printf("[OAUTH] LinkOAuth failed: %v", err)
						http.Redirect(w, r, "/auth/login?error=link_failed", http.StatusSeeOther)
						return
					}
					user = existingUser
					user.OAuthProvider = "google"
				}
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
	}

	// Issue SyncSpace's normal session cookies exactly as regular login does
	_, err = h.issueTokensAndCookies(w, user)
	if err != nil {
		log.Printf("[OAUTH] Failed to issue session cookies: %v", err)
		http.Redirect(w, r, "/auth/login?error=session_error", http.StatusSeeOther)
		return
	}

	http.Redirect(w, r, dest, http.StatusSeeOther)
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
