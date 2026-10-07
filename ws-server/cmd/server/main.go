package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/syncspace/ws-server/internal/auth"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/handlers"
	"github.com/syncspace/ws-server/internal/middleware"
	"github.com/syncspace/ws-server/internal/realtime"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting SyncSpace WS Server...")

	// Load configuration from environment
	port := getEnv("PORT", "8080")
	jwtSecret := getEnv("JWT_SECRET", "dev-jwt-secret-change-in-production")
	corsOrigin := getEnv("CORS_ORIGIN", "http://localhost:3000")
	env := getEnv("ENV", "development")
	execURL := getEnv("EXEC_SERVICE_URL", "http://host.docker.internal:8081")
	execSecret := getEnv("EXEC_SERVICE_SECRET", "")
	cfAccessClientID := getEnv("CF_ACCESS_CLIENT_ID", "")
	cfAccessClientSecret := getEnv("CF_ACCESS_CLIENT_SECRET", "")
	turnstileSecretKey := getEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA")
	googleClientID := getEnv("GOOGLE_CLIENT_ID", "syncspace-app.apps.googleusercontent.com")
	googleClientSecret := getEnv("GOOGLE_CLIENT_SECRET", "")
	googleRedirectURI := getEnv("GOOGLE_REDIRECT_URI", "https://syncspace-bay.vercel.app/api/auth/google/callback")

	// ── Env validation ───────────────────────────────────────────
	// Refuse to start in production with default/weak JWT secret
	if env == "production" {
		if jwtSecret == "dev-jwt-secret-change-in-production" || len(jwtSecret) < 32 {
			log.Fatal("FATAL: JWT_SECRET must be set to a strong secret (>= 32 chars) in production")
		}
		if execSecret == "" || execSecret == "syncspace_exec_secret_dev" || len(execSecret) < 16 {
			log.Fatal("FATAL: EXEC_SERVICE_SECRET must be configured with a strong secret (>= 16 chars) in production")
		}
	} else {
		if jwtSecret == "dev-jwt-secret-change-in-production" {
			log.Println("WARNING: Using default JWT secret — change this before deploying")
		}
		if execSecret == "" {
			execSecret = "syncspace_exec_secret_dev"
			log.Println("WARNING: EXEC_SERVICE_SECRET unset in development, using default dev secret")
		}
	}

	// PostgreSQL configuration
	databaseURL := getEnv("DATABASE_URL", "")
	migrationsDir := getEnv("MIGRATIONS_DIR", "./migrations")

	var db *database.DB
	var err error

	if databaseURL != "" {
		log.Println("Connecting to PostgreSQL using DATABASE_URL...")
		db, err = database.NewFromURL(databaseURL)
	} else {
		dbHost := getEnv("POSTGRES_HOST", "localhost")
		dbPort := getEnv("POSTGRES_PORT", "5432")
		dbUser := getEnv("POSTGRES_USER", "syncspace")
		dbPass := getEnv("POSTGRES_PASSWORD", "syncspace_dev")
		dbName := getEnv("POSTGRES_DB", "syncspace")
		db, err = database.New(dbHost, dbPort, dbUser, dbPass, dbName)
	}
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Run migrations
	log.Println("Running database migrations...")
	if err := db.RunMigrations(migrationsDir); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	// Ensure demo bot user exists (password from env, consistent with other secrets)
	demoBotPassword := getEnv("DEMO_BOT_PASSWORD", "DemoBotSecret2026!")
	if env == "production" {
		if demoBotPassword == "DemoBotSecret2026!" || len(demoBotPassword) < 16 {
			log.Fatal("FATAL: DEMO_BOT_PASSWORD must be set to a strong secret (>= 16 chars) in production")
		}
	} else if demoBotPassword == "DemoBotSecret2026!" {
		log.Println("WARNING: DEMO_BOT_PASSWORD unset, using default dev password")
	}
	if _, err := db.EnsureDemoBotUser(demoBotPassword); err != nil {
		log.Printf("[DEMO-BOT] Warning: failed to ensure demo bot user: %v", err)
	}

	// Initialize services
	secureCookie := env == "production"
	authService := auth.NewService(jwtSecret, secureCookie)

	// Initialize rate limiters — stricter in production
	authRate := 100 // dev/test: 100 auth attempts per minute per IP (supports rapid test suites)
	if env == "production" {
		authRate = 10 // production: 10 auth attempts per minute per IP (brute-force protection)
	}
	authLimiter := middleware.NewRateLimiter(authRate, 60*time.Second)
	execLimiter := middleware.NewRateLimiter(30, 60*time.Second)  // 30 code executions per minute per IP

	chatRate := 30 // 30 chat messages per minute per user
	if rStr := os.Getenv("CHAT_RATE_LIMIT"); rStr != "" {
		if rInt, err := strconv.Atoi(rStr); err == nil && rInt > 0 {
			chatRate = rInt
		}
	}
	chatLimiter := middleware.NewRateLimiter(chatRate, 60*time.Second)

	// Initialize WebSocket hub for real-time collaboration
	hub := realtime.NewHub()

	// Initialize Redis relay for cross-instance WebSocket sync
	redisURL := getEnv("REDIS_URL", "")
	hub.Redis = realtime.NewRedisRelay(hub, redisURL)

	// Attach DB persister to Hub for forced flush on room eviction
	hub.Persister = &workspacePersister{db: db}

	// Initialize handlers
	healthHandler := handlers.NewHealthHandler()
	authHandler := handlers.NewAuthHandler(db, authService, handlers.AuthConfig{
		GoogleClientID:     googleClientID,
		GoogleClientSecret: googleClientSecret,
		GoogleRedirectURI:  googleRedirectURI,
		TurnstileSecretKey: turnstileSecretKey,
		SecureCookie:       secureCookie,
	})
	workspaceHandler := handlers.NewWorkspaceHandler(db, hub)
	membersHandler := handlers.NewMembersHandler(db)
	chatHandler := handlers.NewChatHandler(db, hub)
	aiHandler := handlers.NewAIHandler()
	runHandler := handlers.NewRunHandler(db, hub, execURL, execSecret)
	if cfAccessClientID != "" && cfAccessClientSecret != "" {
		runHandler.SetCloudflareAccess(cfAccessClientID, cfAccessClientSecret)
		log.Println("INFO: Cloudflare Access Service Token configured for exec-service requests")
	}
	versionHandler := handlers.NewVersionHandler(db)

	// Build router
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.SecurityHeaders) // Security headers on every response

	// Parse CORS origins
	var allowedOrigins []string
	for _, o := range strings.Split(corsOrigin, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			allowedOrigins = append(allowedOrigins, o)
		}
	}
	if len(allowedOrigins) == 0 {
		allowedOrigins = append(allowedOrigins, "http://localhost:3000")
	}

	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Public routes
	r.Get("/health", healthHandler.Health)
	r.Head("/health", healthHandler.Health)
	r.Get("/api/ai/info", aiHandler.Info)
	r.Get("/api/exec/limits", runHandler.GetLimits)

	// Auth routes (public, rate-limited, no CSRF — these SET cookies)
	r.Route("/api/auth", func(r chi.Router) {
		r.Use(authLimiter.Middleware)
		r.Post("/signup", authHandler.Signup)
		r.Post("/login", authHandler.Login)
		r.Post("/refresh", authHandler.Refresh)
		r.Get("/verify-email", authHandler.VerifyEmail)
		r.Post("/verify-email", authHandler.VerifyEmail)
		r.Get("/google", authHandler.GoogleLogin)
		r.Get("/google/callback", authHandler.GoogleCallback)
	})

	// Initialize ticket store for WS authentication
	ticketStore := realtime.NewTicketStore(hub.Redis)

	// Protected routes — require auth cookie + CSRF on mutations
	r.Group(func(r chi.Router) {
		r.Use(middleware.AuthMiddleware(authService))
		r.Use(middleware.CSRFMiddleware())

		r.Get("/api/auth/me", authHandler.Me)
		r.Post("/api/auth/logout", authHandler.Logout)

		r.Route("/api/workspaces", func(r chi.Router) {
			r.Get("/", workspaceHandler.List)
			r.Post("/", workspaceHandler.Create)
			r.Get("/{slug}", workspaceHandler.Get)
			r.Delete("/{slug}", workspaceHandler.Delete)
			r.Get("/{slug}/files", workspaceHandler.ListFiles)
			r.Get("/{slug}/file", workspaceHandler.GetFile)
			r.Post("/{slug}/file", workspaceHandler.CreateFile)
			r.Put("/{slug}/file", workspaceHandler.UpdateFile)
			r.Delete("/{slug}/file", workspaceHandler.DeleteFile)
			r.Post("/{slug}/file/rename", workspaceHandler.RenameFile)
			r.Post("/{slug}/demo", workspaceHandler.SetDemo)

			// Beacon persist — lightweight endpoint for navigator.sendBeacon
			// on tab close. Accepts same body as UpdateFile but returns 204
			// immediately. Used by beforeunload handler to flush Y.Doc content.
			r.Post("/{slug}/beacon-persist", workspaceHandler.BeaconPersist)

			// Member management
			r.Get("/{slug}/members", membersHandler.List)
			r.Post("/{slug}/members", membersHandler.Invite)
			r.Put("/{slug}/members/{userId}", membersHandler.UpdateRole)
			r.Delete("/{slug}/members/{userId}", membersHandler.Remove)

			// Workspace chat (persisted in Postgres, last 200 messages, real-time via Redis pub/sub)
			r.Get("/{slug}/messages", chatHandler.List)
			r.With(chatLimiter.UserMiddleware).Post("/{slug}/messages", chatHandler.Create)

			// Secure Docker execution (Phase D) — owner/editor only, rate-limited, Redis-locked, streamed over WS
			r.Post("/{slug}/run", runHandler.Run)
			r.Post("/{slug}/run/cancel", runHandler.Cancel)
			r.Get("/{slug}/runs", runHandler.ListRuns)

			// File version history (snapshots, diff, restore)
			r.Get("/{slug}/versions", versionHandler.ListVersions)
			r.Post("/{slug}/versions", versionHandler.CreateVersion)
			r.Get("/{slug}/versions/{versionId}", versionHandler.GetVersion)
			r.Post("/{slug}/versions/{versionId}/restore", versionHandler.RestoreVersion)
		})

		// AI assistant (rate-limited per IP)
		r.Group(func(r chi.Router) {
			r.Use(execLimiter.Middleware)
			r.Post("/api/ai/chat", aiHandler.Chat)
		})

		// WebSocket connection ticket — issues a short-lived, single-use token
		// that replaces the old raw-JWT-in-query-string approach
		r.Post("/api/ws-ticket", func(w http.ResponseWriter, r *http.Request) {
			claims := middleware.GetClaims(r)
			if claims == nil {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			ticket := ticketStore.Issue(claims.UserID, claims.Username)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"ticket":"%s"}`, ticket)
		})

		// Workspace presence (who's online, which file)
		r.Get("/api/workspaces/{slug}/presence", func(w http.ResponseWriter, r *http.Request) {
			slug := chi.URLParam(r, "slug")
			presence := hub.GetWorkspacePresence(slug)
			w.Header().Set("Content-Type", "application/json")
			if len(presence) == 0 {
				w.Write([]byte("[]"))
				return
			}
			// Manual JSON to avoid import
			w.Write([]byte("["))
			for i, p := range presence {
				if i > 0 {
					w.Write([]byte(","))
				}
				fmt.Fprintf(w, `{"user_id":"%s","username":"%s","file":"%s","color_slot":%d}`,
					p.UserID, p.Username, p.File, p.ColorSlot)
			}
			w.Write([]byte("]"))
		})
	})

	// WebSocket endpoint — NOT behind JWT auth middleware.
	// Authenticates via single-use ticket instead.
	r.Get("/ws/{slug}/{filePath}", func(w http.ResponseWriter, r *http.Request) {
		ticketID := r.URL.Query().Get("ticket")
		if ticketID == "" {
			http.Error(w, "missing ticket", http.StatusUnauthorized)
			return
		}

		// Consume ticket (single-use, 10s expiry)
		ticket := ticketStore.Consume(ticketID)
		if ticket == nil {
			http.Error(w, "invalid or expired ticket", http.StatusUnauthorized)
			return
		}

		slug := chi.URLParam(r, "slug")
		filePath := chi.URLParam(r, "filePath")

		// Verify workspace exists and user has access
		ws, err := db.GetWorkspaceBySlug(slug)
		if err != nil || ws == nil {
			ws, err = db.GetWorkspaceByShortID(slug)
			if err != nil || ws == nil {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
		}
		// Server-side enforcement: demo bot can NEVER join a non-demo workspace
		if ticket.Username == "demo-bot" && !ws.IsDemo {
			http.Error(w, "forbidden: demo bot cannot join non-demo workspaces", http.StatusForbidden)
			return
		}

		role, _ := db.GetMemberRole(ws.ID, ticket.UserID)
		if role == "" && !ws.IsPublic && !(ws.IsDemo && ticket.Username == "demo-bot") {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		// When a human visitor opens a demo room, notify Redis for demo bot trigger
		if ws.IsDemo && ticket.Username != "demo-bot" && hub.Redis != nil && hub.Redis.Client() != nil {
			msg, _ := json.Marshal(map[string]interface{}{
				"type":           "demo_visitor_joined",
				"workspace_slug": ws.Slug,
				"short_id":       ws.ShortID,
				"file_path":      filePath,
				"visitor":        ticket.Username,
			})
			hub.Redis.Client().Publish(context.Background(), "syncspace:demo:triggers", msg)
		}

		// Use short_id as the canonical room identifier (so slug and short_id both resolve to the same room)
		realtime.ServeWS(hub, w, r, ticket.UserID, ticket.Username, ws.ShortID, filePath)
	})

	// Graceful shutdown
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%s", port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("Shutting down gracefully...")
		srv.Close()
	}()

	log.Printf("SyncSpace WS Server listening on :%s (env=%s)", port, env)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return strings.TrimSpace(val)
	}
	return fallback
}

type workspacePersister struct {
	db *database.DB
}

func (p *workspacePersister) PersistFileContent(workspaceSlug, filePath, content string) error {
	ws, err := p.db.GetWorkspaceBySlug(workspaceSlug)
	if err != nil || ws == nil {
		ws, err = p.db.GetWorkspaceByShortID(workspaceSlug)
		if err != nil || ws == nil {
			return fmt.Errorf("workspace not found: %s", workspaceSlug)
		}
	}
	_, err = p.db.UpdateFileContent(ws.ID, filePath, content)
	return err
}

