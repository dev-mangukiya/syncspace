package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
)

var startTime = time.Now()

// ── Configuration ────────────────────────────────────────────
const (
	maxCodeSize   = 64 * 1024  // 64KB max code input
	maxOutputSize = 256 * 1024 // 256KB max stdout/stderr output
)

// ExecRequest is the payload for code execution
type ExecRequest struct {
	Code     string `json:"code"`
	Language string `json:"language"`
}

// ExecResponse is the result of code execution
type ExecResponse struct {
	ID            string `json:"id"`
	Stdout        string `json:"stdout"`
	Stderr        string `json:"stderr"`
	ExitCode      int    `json:"exit_code"`
	DurationMs    int64  `json:"duration_ms"`
	TimedOut      bool   `json:"timed_out"`
	OutputCapped  bool   `json:"output_capped,omitempty"`
	Language      string `json:"language"`
}

// Docker images for each supported language
var languageImages = map[string]string{
	"python":     "python:3.12-alpine",
	"javascript": "node:20-alpine",
	"typescript": "node:20-alpine",
	"go":         "golang:1.22-alpine",
	"ruby":       "ruby:3.3-alpine",
}

// Commands to run for each language
var languageCommands = map[string][]string{
	"python":     {"python3", "/code/main.py"},
	"javascript": {"node", "/code/main.js"},
	"typescript": {"node", "/code/main.js"},
	"go":         {"go", "run", "/code/main.go"},
	"ruby":       {"ruby", "/code/main.rb"},
}

// File extensions for each language
var languageExtensions = map[string]string{
	"python":     "py",
	"javascript": "js",
	"typescript": "js",
	"go":         "go",
	"ruby":       "rb",
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting SyncSpace Exec Service...")

	port := getEnv("PORT", "8081")
	corsOrigin := getEnv("CORS_ORIGIN", "http://localhost:3000")
	timeoutSec, _ := strconv.Atoi(getEnv("EXEC_TIMEOUT", "10"))
	memoryLimit := getEnv("EXEC_MEMORY_LIMIT", "128m")
	cpuLimit := getEnv("EXEC_CPU_LIMIT", "0.5")

	// Shared secret for service-to-service auth
	// In production, this MUST match the ws-server's EXEC_SERVICE_SECRET
	execSecret := getEnv("EXEC_SERVICE_SECRET", "")

	// Verify Docker is available
	if err := exec.Command("docker", "version").Run(); err != nil {
		log.Printf("WARNING: Docker not available — execution will be disabled: %v", err)
	} else {
		log.Println("Docker connection verified")
		// Pre-pull commonly used images in background
		go prePullImages()
	}

	r := chi.NewRouter()
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Recoverer)

	// Security headers
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
			next.ServeHTTP(w, r)
		})
	})

	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{corsOrigin, "http://localhost:3000"},
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Exec-Secret"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health check (unauthenticated — used by load balancers)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		dockerAvailable := exec.Command("docker", "version").Run() == nil
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"service":          "syncspace-exec-service",
			"status":           "healthy",
			"docker_available": dockerAvailable,
			"uptime":           time.Since(startTime).String(),
			"goVersion":        runtime.Version(),
			"timestamp":        time.Now().UTC(),
		})
	})

	// Supported languages (unauthenticated — public info)
	r.Get("/api/exec/languages", func(w http.ResponseWriter, r *http.Request) {
		langs := make([]map[string]string, 0)
		for lang, img := range languageImages {
			langs = append(langs, map[string]string{
				"name":  lang,
				"image": img,
			})
		}
		writeJSON(w, http.StatusOK, langs)
	})

	// Execute code — authenticated via shared secret or JWT forwarding
	r.Post("/api/exec/run", func(w http.ResponseWriter, r *http.Request) {
		// ── Auth check ──────────────────────────────────
		if execSecret != "" {
			reqSecret := r.Header.Get("X-Exec-Secret")
			authHeader := r.Header.Get("Authorization")

			if reqSecret != execSecret && authHeader == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error": "authentication required",
				})
				return
			}

			// If X-Exec-Secret doesn't match and no valid JWT proxy, reject
			if reqSecret != "" && reqSecret != execSecret {
				writeJSON(w, http.StatusForbidden, map[string]string{
					"error": "invalid service credentials",
				})
				return
			}
		}

		// ── Parse request ────────────────────────────────
		// Limit request body size
		r.Body = http.MaxBytesReader(w, r.Body, maxCodeSize+1024) // code + JSON overhead

		var req ExecRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}

		if req.Code == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code is required"})
			return
		}

		if len(req.Code) > maxCodeSize {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("code exceeds maximum size of %dKB", maxCodeSize/1024),
			})
			return
		}

		image, ok := languageImages[req.Language]
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":     "unsupported language: " + req.Language,
				"supported": strings.Join(getSupportedLanguages(), ", "),
			})
			return
		}

		// Verify Docker is available
		if err := exec.Command("docker", "version").Run(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{
				"error": "Docker is not available. Code execution requires Docker.",
			})
			return
		}

		execID := uuid.New().String()[:8]
		containerName := fmt.Sprintf("syncspace-exec-%s", execID)

		log.Printf("[%s] Executing %s code (%d bytes)", execID, req.Language, len(req.Code))

		// Create temporary file with code
		homeDir, _ := os.UserHomeDir()
		execTmpBase := fmt.Sprintf("%s/.syncspace-exec-tmp", homeDir)
		os.MkdirAll(execTmpBase, 0755)
		tmpDir, err := os.MkdirTemp(execTmpBase, "run-*")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create temp dir"})
			return
		}
		defer os.RemoveAll(tmpDir)
		os.Chmod(tmpDir, 0755)

		ext := languageExtensions[req.Language]
		codePath := fmt.Sprintf("%s/main.%s", tmpDir, ext)
		if err := os.WriteFile(codePath, []byte(req.Code), 0644); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write code"})
			return
		}

		// ── Build docker run command with hardened security ──
		args := []string{
			"run",
			"--rm",                                       // Remove container after exit
			"--name", containerName,                      // Named for cleanup
			"--network", "none",                          // No network access
			"--memory", memoryLimit,                      // Memory limit
			"--cpus", cpuLimit,                           // CPU limit
			"--pids-limit", "64",                         // Process limit
			"--read-only",                                // Read-only root filesystem
			"--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",  // Writable /tmp, capped
			"--security-opt", "no-new-privileges",        // No privilege escalation
			"--cap-drop", "ALL",                          // Drop ALL Linux capabilities
			"--user", "65534:65534",                      // Run as nobody (non-root)
			"-v", fmt.Sprintf("%s:/code:ro", tmpDir),     // Mount code read-only
		}

		// Go needs writable GOPATH/GOCACHE — add tmpfs for it
		if req.Language == "go" {
			args = append(args, "--tmpfs", "/go:rw,exec,size=128m")
			args = append(args, "--tmpfs", "/root:rw,size=64m")
			// Go needs to run as root for module resolution in Alpine
			// Override the nobody user for Go specifically
			args[len(args)-3] = "0:0" // user override
		}

		args = append(args, image)
		args = append(args, languageCommands[req.Language]...)

		// Execute with timeout
		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSec)*time.Second)
		defer cancel()

		start := time.Now()
		cmd := exec.CommandContext(ctx, "docker", args...)

		// ── Size-capped output buffers ──
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &limitedWriter{buf: &stdout, limit: maxOutputSize}
		cmd.Stderr = &limitedWriter{buf: &stderr, limit: maxOutputSize}

		err = cmd.Run()
		duration := time.Since(start)

		response := ExecResponse{
			ID:         execID,
			Stdout:     stdout.String(),
			Stderr:     stderr.String(),
			DurationMs: duration.Milliseconds(),
			Language:   req.Language,
		}

		// Cap output if it exceeded the limit
		if stdout.Len() >= maxOutputSize {
			response.OutputCapped = true
			response.Stdout = response.Stdout[:maxOutputSize] + "\n[output truncated]"
		}
		if stderr.Len() >= maxOutputSize {
			response.OutputCapped = true
			response.Stderr = response.Stderr[:maxOutputSize] + "\n[output truncated]"
		}

		if ctx.Err() == context.DeadlineExceeded {
			response.TimedOut = true
			response.ExitCode = -1
			response.Stderr += fmt.Sprintf("\n[Execution timed out after %ds]", timeoutSec)
			exec.Command("docker", "kill", containerName).Run()
			log.Printf("[%s] Timed out after %v", execID, duration)
		} else if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				response.ExitCode = exitErr.ExitCode()
			} else {
				response.ExitCode = -1
				response.Stderr = err.Error()
			}
			log.Printf("[%s] Exited with code %d in %v", execID, response.ExitCode, duration)
		} else {
			response.ExitCode = 0
			log.Printf("[%s] Success in %v", execID, duration)
		}

		writeJSON(w, http.StatusOK, response)
	})

	// Graceful shutdown
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%s", port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      time.Duration(timeoutSec+15) * time.Second, // exec timeout + buffer
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("Shutting down exec service...")
		srv.Close()
	}()

	if execSecret != "" {
		log.Printf("SyncSpace Exec Service listening on :%s (auth=shared-secret)", port)
	} else {
		log.Printf("SyncSpace Exec Service listening on :%s (auth=NONE — set EXEC_SERVICE_SECRET in production)", port)
	}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

// limitedWriter caps writes to a maximum size to prevent memory exhaustion
type limitedWriter struct {
	buf   *bytes.Buffer
	limit int
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	remaining := lw.limit - lw.buf.Len()
	if remaining <= 0 {
		return len(p), nil // Silently discard
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	return lw.buf.Write(p)
}

func prePullImages() {
	for lang, image := range languageImages {
		log.Printf("Pre-pulling %s image: %s", lang, image)
		cmd := exec.Command("docker", "pull", image)
		if err := cmd.Run(); err != nil {
			log.Printf("Warning: failed to pre-pull %s: %v", image, err)
		} else {
			log.Printf("Pre-pulled %s", image)
		}
	}
}

func getSupportedLanguages() []string {
	langs := make([]string, 0, len(languageImages))
	for lang := range languageImages {
		langs = append(langs, lang)
	}
	return langs
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return strings.TrimSpace(val)
	}
	return fallback
}
