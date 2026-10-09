package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/syncspace/ws-server/internal/auth"
)

func TestSignup_RequiresTerms(t *testing.T) {
	h := NewAuthHandler(nil, nil, nil)
	body, _ := json.Marshal(map[string]interface{}{
		"username":        "testuser",
		"email":           "test@example.com",
		"password":        "password123",
		"terms_accepted":  false,
		"turnstile_token": "valid-token",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/signup", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Signup(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400 for unaccepted terms, got %d", w.Code)
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "terms_not_accepted" {
		t.Fatalf("expected error terms_not_accepted, got %s", resp["error"])
	}
}

func TestSignup_RequiresTurnstileToken(t *testing.T) {
	h := NewAuthHandler(nil, nil, nil)
	body, _ := json.Marshal(map[string]interface{}{
		"username":        "testuser",
		"email":           "test@example.com",
		"password":        "password123",
		"terms_accepted":  true,
		"turnstile_token": "", // missing
	})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/signup", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Signup(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400 for missing turnstile token, got %d", w.Code)
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "turnstile_token_required" {
		t.Fatalf("expected error turnstile_token_required, got %s", resp["error"])
	}
}

func TestSignup_RejectsInvalidTurnstileToken(t *testing.T) {
	// Configure with Cloudflare's always-fails test secret
	h := NewAuthHandler(nil, nil, nil, AuthConfig{
		TurnstileSecretKey: "2x0000000000000000000000000000000AB", // Cloudflare always-fails secret
	})

	body, _ := json.Marshal(map[string]interface{}{
		"username":        "testuser",
		"email":           "test@example.com",
		"password":        "password123",
		"terms_accepted":  true,
		"turnstile_token": "invalid-token",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/signup", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Signup(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 for failed turnstile verification, got %d", w.Code)
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "turnstile_verification_failed" {
		t.Fatalf("expected error turnstile_verification_failed, got %s", resp["error"])
	}
}

func TestVerifyTurnstile_RejectsWhenSecretUnset(t *testing.T) {
	h := NewAuthHandler(nil, nil, nil, AuthConfig{
		TurnstileSecretKey: "", // unset
	})

	valid, err := h.verifyTurnstile("any-token", "127.0.0.1")
	if valid {
		t.Fatal("expected verifyTurnstile to fail when TurnstileSecretKey is unset")
	}
	if err == nil {
		t.Fatal("expected error when TurnstileSecretKey is unset")
	}
}

func TestGoogleLogin_RedirectAndStateCookie(t *testing.T) {
	h := NewAuthHandler(nil, nil, nil, AuthConfig{
		GoogleClientID:     "test-client-id.apps.googleusercontent.com",
		GoogleClientSecret: "test-client-secret",
		GoogleRedirectURI:  "https://syncspace.dev/api/auth/google/callback",
		SecureCookie:       false,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/auth/google", nil)
	w := httptest.NewRecorder()

	h.GoogleLogin(w, req)

	if w.Code != http.StatusTemporaryRedirect {
		t.Fatalf("expected status 307 redirect, got %d", w.Code)
	}

	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://accounts.google.com/o/oauth2/v2/auth") {
		t.Fatalf("expected redirect to accounts.google.com, got %s", loc)
	}
	if !strings.Contains(loc, "client_id=test-client-id.apps.googleusercontent.com") {
		t.Fatalf("expected client_id in redirect url: %s", loc)
	}
	if !strings.Contains(loc, "state=") {
		t.Fatalf("expected state param in redirect url: %s", loc)
	}

	// Verify state cookie is set
	cookies := w.Result().Cookies()
	var stateCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "syncspace_oauth_state" {
			stateCookie = c
			break
		}
	}
	if stateCookie == nil {
		t.Fatal("expected syncspace_oauth_state cookie to be set")
	}
	if stateCookie.Value == "" || len(stateCookie.Value) < 32 {
		t.Fatalf("expected non-empty cryptographic state cookie, got %s", stateCookie.Value)
	}
	if !stateCookie.HttpOnly {
		t.Fatal("expected state cookie to be HttpOnly")
	}
	if stateCookie.SameSite != http.SameSiteLaxMode {
		t.Fatal("expected state cookie to be SameSite=Lax for OAuth redirect support")
	}
}

func TestGoogleCallback_RejectsStateMismatch(t *testing.T) {
	h := NewAuthHandler(nil, nil, nil, AuthConfig{
		GoogleClientID:     "test-client-id",
		GoogleClientSecret: "test-client-secret",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/auth/google/callback?state=tampered-state&code=test-code", nil)
	req.AddCookie(&http.Cookie{
		Name:  "syncspace_oauth_state",
		Value: "legitimate-server-state",
	})
	w := httptest.NewRecorder()

	h.GoogleCallback(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400 for state mismatch, got %d", w.Code)
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "invalid_oauth_state" {
		t.Fatalf("expected error invalid_oauth_state, got %s", resp["error"])
	}
}

func TestGoogleCallback_RejectsMissingStateCookie(t *testing.T) {
	h := NewAuthHandler(nil, nil, nil, AuthConfig{
		GoogleClientID:     "test-client-id",
		GoogleClientSecret: "test-client-secret",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/auth/google/callback?state=some-state&code=test-code", nil)
	w := httptest.NewRecorder()

	h.GoogleCallback(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400 when state cookie is missing, got %d", w.Code)
	}
}

func TestSanitizeOAuthUsername(t *testing.T) {
	tests := []struct {
		name     string
		email    string
		expected string
	}{
		{"John Doe", "john@example.com", "john_doe"},
		{"Alice", "alice@test.com", "alice"},
		{"", "bob_123@example.com", "bob_123"},
		{"A", "a@test.com", "user_a"},
		{"Very Long Name Exceeding Twenty Eight Characters Here", "long@test.com", "very_long_name_exceeding_twe"},
	}

	for _, tt := range tests {
		got := sanitizeOAuthUsername(tt.name, tt.email)
		if got != tt.expected {
			t.Errorf("sanitizeOAuthUsername(%q, %q) = %q, want %q", tt.name, tt.email, got, tt.expected)
		}
	}
}

func TestGoogleLogin_SetsLinkingUserCookieWhenAuthenticated(t *testing.T) {
	authSvc := auth.NewService("test-jwt-secret-32-bytes-long!!", false)
	h := NewAuthHandler(nil, authSvc, nil, AuthConfig{
		GoogleClientID:     "test-client-id",
		GoogleClientSecret: "test-client-secret",
	})

	testUID := uuid.New()
	token, err := authSvc.GenerateAccessToken(testUID, "testuser", "test@example.com")
	if err != nil {
		t.Fatalf("failed to generate access token: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/google", nil)
	req.AddCookie(&http.Cookie{
		Name:  "syncspace_access",
		Value: token,
	})
	w := httptest.NewRecorder()

	h.GoogleLogin(w, req)

	var linkCookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "syncspace_oauth_link_user" {
			linkCookie = c
			break
		}
	}

	if linkCookie == nil {
		t.Fatal("expected syncspace_oauth_link_user cookie to be set")
	}
	if linkCookie.Value != testUID.String() {
		t.Fatalf("expected link cookie value %s, got %s", testUID.String(), linkCookie.Value)
	}
}

func TestGoogleLogin_ClearsLinkingUserCookieWhenUnauthenticated(t *testing.T) {
	authSvc := auth.NewService("test-jwt-secret-32-bytes-long!!", false)
	h := NewAuthHandler(nil, authSvc, nil, AuthConfig{
		GoogleClientID:     "test-client-id",
		GoogleClientSecret: "test-client-secret",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/auth/google", nil)
	w := httptest.NewRecorder()

	h.GoogleLogin(w, req)

	var linkCookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "syncspace_oauth_link_user" {
			linkCookie = c
			break
		}
	}

	if linkCookie == nil {
		t.Fatal("expected syncspace_oauth_link_user cookie to be set")
	}
	if linkCookie.MaxAge != -1 || linkCookie.Value != "" {
		t.Fatalf("expected link cookie to be cleared (MaxAge -1, Value empty), got MaxAge=%d, Value=%s", linkCookie.MaxAge, linkCookie.Value)
	}
}

func TestAuthService_CheckPasswordRejectsEmptyHash(t *testing.T) {
	authSvc := auth.NewService("test-jwt-secret-32-bytes-long!!", false)
	// When password_hash is invalidated to empty string "" (pre-hijacking mitigation),
	// CheckPassword must strictly return false for any password.
	if authSvc.CheckPassword("AnyPassword123!", "") {
		t.Fatal("expected CheckPassword to reject empty password hash")
	}
	if authSvc.CheckPassword("AttackerSecret123!", "") {
		t.Fatal("expected CheckPassword to reject empty password hash")
	}
}
