package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidToken = errors.New("invalid or expired token")
	ErrHashFailed   = errors.New("failed to hash password")
)

// Claims extends JWT standard claims with user info
type Claims struct {
	UserID   uuid.UUID `json:"user_id"`
	Username string    `json:"username"`
	Email    string    `json:"email"`
	jwt.RegisteredClaims
}

// Service handles JWT issuance, cookie management, and password hashing
type Service struct {
	jwtSecret  []byte
	accessTTL  time.Duration
	refreshTTL time.Duration
	secureCookie bool // true in production (HTTPS)
}

// NewService creates a new auth service.
// secureCookie should be true in production (sets Secure flag on cookies).
func NewService(jwtSecret string, secureCookie bool) *Service {
	return &Service{
		jwtSecret:    []byte(jwtSecret),
		accessTTL:    15 * time.Minute,
		refreshTTL:   7 * 24 * time.Hour,
		secureCookie: secureCookie,
	}
}

// HashPassword generates a bcrypt hash
func (s *Service) HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", ErrHashFailed
	}
	return string(hash), nil
}

// CheckPassword verifies a password against a bcrypt hash
func (s *Service) CheckPassword(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// GenerateAccessToken creates a short-lived signed JWT (15 min)
func (s *Service) GenerateAccessToken(userID uuid.UUID, username, email string) (string, error) {
	now := time.Now()
	claims := &Claims{
		UserID:   userID,
		Username: username,
		Email:    email,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(s.accessTTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "syncspace",
			Subject:   "access",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

// GenerateRefreshToken creates a cryptographically random token string (for DB storage)
func (s *Service) GenerateRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ValidateToken parses and validates a JWT, returning the claims
func (s *Service) ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return s.jwtSecret, nil
	})

	if err != nil || !token.Valid {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*Claims)
	if !ok {
		return nil, ErrInvalidToken
	}

	return claims, nil
}

// SetAuthCookies writes httpOnly access + refresh cookies on the response.
// Path=/ so they're sent with every request to the same origin.
func (s *Service) SetAuthCookies(w http.ResponseWriter, accessToken, refreshToken string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_access",
		Value:    accessToken,
		Path:     "/",
		MaxAge:   int(s.accessTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_refresh",
		Value:    refreshToken,
		Path:     "/api/auth", // Only sent to auth endpoints (refresh, logout)
		MaxAge:   int(s.refreshTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearAuthCookies removes auth cookies by setting MaxAge=-1.
func (s *Service) ClearAuthCookies(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_access",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     "syncspace_refresh",
		Value:    "",
		Path:     "/api/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

// GenerateCSRFToken creates a random CSRF token
func (s *Service) GenerateCSRFToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// RefreshTTL returns the refresh token TTL for DB storage
func (s *Service) RefreshTTL() time.Duration {
	return s.refreshTTL
}
