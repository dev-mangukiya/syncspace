package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
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
	RunID          string `json:"run_id,omitempty"`
	Code           string `json:"code"`
	Language       string `json:"language"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
}

// ExecResponse is the result of code execution
type ExecResponse struct {
	ID              string `json:"id"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	ExitCode        int    `json:"exit_code"`
	DurationMs      int64  `json:"duration_ms"`
	TimedOut        bool   `json:"timed_out"`
	Cancelled       bool   `json:"cancelled,omitempty"`
	OutputCapped    bool   `json:"output_capped,omitempty"`
	PeakMemoryBytes int64  `json:"peak_memory_bytes,omitempty"`
	Language        string `json:"language"`
}

// StreamEvent represents an NDJSON line emitted during streaming execution
type StreamEvent struct {
	Stream          string `json:"stream,omitempty"`            // "stdout" | "stderr"
	Chunk           string `json:"chunk,omitempty"`             // streamed text chunk
	Event           string `json:"event,omitempty"`             // "finished" | "started"
	RunID           string `json:"run_id,omitempty"`
	ExitCode        int    `json:"exit_code,omitempty"`
	DurationMs      int64  `json:"duration_ms,omitempty"`
	PeakMemoryBytes int64  `json:"peak_memory_bytes,omitempty"`
	TimedOut        bool   `json:"timed_out,omitempty"`
	Cancelled       bool   `json:"cancelled,omitempty"`
	OutputCapped    bool   `json:"output_capped,omitempty"`
	Error           string `json:"error,omitempty"`
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

// Active containers tracker for cancel operations
var (
	activeContainersMu sync.Mutex
	activeContainers   = make(map[string]string) // runID -> containerName
	cancelledRuns      sync.Map
	concurrencySem     = make(chan struct{}, 5)  // Global concurrency cap: max 5 simultaneous containers
)

func registerContainer(runID, containerName string) {
	activeContainersMu.Lock()
	defer activeContainersMu.Unlock()
	activeContainers[runID] = containerName
}

func unregisterContainer(runID string) {
	activeContainersMu.Lock()
	defer activeContainersMu.Unlock()
	delete(activeContainers, runID)
}

func getContainer(runID string) string {
	activeContainersMu.Lock()
	defer activeContainersMu.Unlock()
	return activeContainers[runID]
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting SyncSpace Exec Service...")

	port := getEnv("PORT", "8081")
	corsOrigin := getEnv("CORS_ORIGIN", "http://localhost:3000")
	env := getEnv("ENV", "development")
	timeoutSec, _ := strconv.Atoi(getEnv("EXEC_TIMEOUT", "10"))
	memoryLimit := getEnv("EXEC_MEMORY_LIMIT", "128m")
	cpuLimit := getEnv("EXEC_CPU_LIMIT", "0.5")
	pidsLimit := getEnv("EXEC_PIDS_LIMIT", "64")

	// Shared secret for service-to-service auth
	execSecret := getEnv("EXEC_SERVICE_SECRET", "")
	if env == "production" {
		if execSecret == "" || len(execSecret) < 16 {
			log.Fatal("FATAL: EXEC_SERVICE_SECRET must be configured with a strong secret (>= 16 chars) in production")
		}
		knownDevDefaults := []string{
			"syncspace_exec_secret_dev",
			"dev-exec-secret",
			"default-secret",
			"secret",
			"password",
			"changeme",
			"change-this-to-a-real-secret-in-production",
			"dev-jwt-secret-change-in-production",
		}
		for _, devDef := range knownDevDefaults {
			if strings.EqualFold(execSecret, devDef) {
				log.Fatalf("FATAL: EXEC_SERVICE_SECRET cannot use known default/example secret %q in production", execSecret)
			}
		}
	} else if execSecret == "" {
		execSecret = "syncspace_exec_secret_dev"
		log.Println("WARNING: EXEC_SERVICE_SECRET unset in development, using default dev secret")
	}

	// Verify Docker is available
	if err := exec.Command("docker", "version").Run(); err != nil {
		log.Printf("WARNING: Docker not available — execution will be disabled: %v", err)
	} else {
		log.Println("Docker connection verified")
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

	// Supported languages (unauthenticated)
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

	// Configured limits (reads actual runtime settings)
	r.Get("/api/exec/limits", func(w http.ResponseWriter, r *http.Request) {
		pids, _ := strconv.Atoi(pidsLimit)
		if pids <= 0 {
			pids = 64
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"timeout_seconds":     timeoutSec,
			"memory_limit":        memoryLimit,
			"cpu_limit":           cpuLimit,
			"pids_limit":          pids,
			"max_code_size_kb":    maxCodeSize / 1024,
			"max_output_size_kb":  maxOutputSize / 1024,
			"network":             "none",
			"read_only_rootfs":    true,
			"user":                "65534:65534",
			"cap_drop":            []string{"ALL"},
			"security_opt":        []string{"no-new-privileges"},
		})
	})

	// Authenticated routes
	r.Group(func(authRouter chi.Router) {
		authRouter.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reqSecret := r.Header.Get("X-Exec-Secret")
				if reqSecret != execSecret {
					writeJSON(w, http.StatusUnauthorized, map[string]string{
						"error": "unauthorized: valid X-Exec-Secret required",
					})
					return
				}
				next.ServeHTTP(w, r)
			})
		})

		// Cancel execution
		authRouter.Post("/api/exec/cancel", func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				RunID string `json:"run_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RunID == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "run_id is required"})
				return
			}

			containerName := getContainer(req.RunID)
			if containerName == "" {
				containerName = fmt.Sprintf("syncspace-exec-%s", req.RunID)
			}

			cancelledRuns.Store(req.RunID, true)
			log.Printf("[Cancel] Killing container %s for run %s", containerName, req.RunID)
			_ = exec.Command("docker", "kill", containerName).Run()
			_ = exec.Command("docker", "rm", "-f", containerName).Run()
			unregisterContainer(req.RunID)

			writeJSON(w, http.StatusOK, map[string]interface{}{
				"status": "cancelled",
				"run_id": req.RunID,
			})
		})

		// Streaming code execution (NDJSON)
		authRouter.Post("/api/exec/stream", func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxCodeSize+1024)

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

			if err := exec.Command("docker", "version").Run(); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{
					"error": "Docker is not available. Code execution requires Docker.",
				})
				return
			}

			runID := req.RunID
			if runID == "" {
				runID = uuid.New().String()[:8]
			}
			containerName := fmt.Sprintf("syncspace-exec-%s", runID)
			registerContainer(runID, containerName)
			defer unregisterContainer(runID)

			// Enforce global concurrency cap (max 5 simultaneous containers across all instances)
			select {
			case concurrencySem <- struct{}{}:
				defer func() { <-concurrencySem }()
			default:
				writeJSON(w, http.StatusTooManyRequests, map[string]string{
					"error": "server execution concurrency limit reached (max 5 simultaneous runs); please try again shortly",
				})
				return
			}

			// Setup headers for NDJSON streaming
			flusher, ok := w.(http.Flusher)
			if !ok {
				http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
				return
			}

			w.Header().Set("Content-Type", "application/x-ndjson")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusOK)
			flusher.Flush()

			writeStreamEvent := func(evt StreamEvent) {
				data, _ := json.Marshal(evt)
				_, _ = w.Write(append(data, '\n'))
				flusher.Flush()
			}

			// Create temporary directory for code
			homeDir, _ := os.UserHomeDir()
			execTmpBase := fmt.Sprintf("%s/.syncspace-exec-tmp", homeDir)
			_ = os.MkdirAll(execTmpBase, 0755)
			tmpDir, err := os.MkdirTemp(execTmpBase, "run-*")
			if err != nil {
				writeStreamEvent(StreamEvent{
					Event: "finished",
					RunID: runID,
					Error: "failed to create execution directory",
				})
				return
			}
			defer os.RemoveAll(tmpDir)
			_ = os.Chmod(tmpDir, 0755)

			ext := languageExtensions[req.Language]
			codePath := fmt.Sprintf("%s/main.%s", tmpDir, ext)
			if err := os.WriteFile(codePath, []byte(req.Code), 0644); err != nil {
				writeStreamEvent(StreamEvent{
					Event: "finished",
					RunID: runID,
					Error: "failed to write code file",
				})
				return
			}

			// Docker isolation arguments
			args := []string{
				"run",
				"--name", containerName,
				"--network", "none",
				"--memory", memoryLimit,
				"--cpus", cpuLimit,
				"--pids-limit", pidsLimit,
				"--read-only",
				"--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
				"--security-opt", "no-new-privileges",
				"--cap-drop", "ALL",
				"--user", "65534:65534",
				"-v", fmt.Sprintf("%s:/code:ro", tmpDir),
			}

			if req.Language == "go" {
				args = append(args, "--tmpfs", "/go:rw,exec,size=128m")
				args = append(args, "--tmpfs", "/root:rw,size=64m")
				args[len(args)-3] = "0:0"
			}

			args = append(args, image)
			args = append(args, languageCommands[req.Language]...)

			runTimeout := timeoutSec
			if req.TimeoutSeconds > 0 && req.TimeoutSeconds < timeoutSec {
				runTimeout = req.TimeoutSeconds
			}

			ctx, cancel := context.WithTimeout(r.Context(), time.Duration(runTimeout)*time.Second)
			defer cancel()

			start := time.Now()
			cmd := exec.CommandContext(ctx, "docker", args...)

			stdoutPipe, err := cmd.StdoutPipe()
			if err != nil {
				writeStreamEvent(StreamEvent{Event: "finished", RunID: runID, Error: "stdout pipe error"})
				return
			}
			stderrPipe, err := cmd.StderrPipe()
			if err != nil {
				writeStreamEvent(StreamEvent{Event: "finished", RunID: runID, Error: "stderr pipe error"})
				return
			}

			if err := cmd.Start(); err != nil {
				writeStreamEvent(StreamEvent{Event: "finished", RunID: runID, Error: fmt.Sprintf("start error: %v", err)})
				return
			}

			// Defer container cleanup
			defer func() {
				_ = exec.Command("docker", "rm", "-f", containerName).Run()
			}()

			var totalBytes int64
			var outputCapped bool
			var writeMu sync.Mutex

			var maxMemBytes int64
			stopStats := make(chan struct{})
			go func() {
				ticker := time.NewTicker(80 * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-ticker.C:
						// Try to read container memory usage
						out, err := exec.Command("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", containerName).Output()
						if err == nil && len(out) > 0 {
							// Sample format: "14.2MiB / 128MiB"
							parts := strings.Split(string(out), "/")
							if len(parts) > 0 {
								raw := strings.TrimSpace(parts[0])
								bytesVal := parseMemBytes(raw)
								if bytesVal > maxMemBytes {
									maxMemBytes = bytesVal
								}
							}
						}
					case <-stopStats:
						return
					}
				}
			}()

			streamPipe := func(pipe io.Reader, streamName string, wg *sync.WaitGroup) {
				defer wg.Done()
				reader := bufio.NewReader(pipe)
				buf := make([]byte, 1024)
				for {
					n, rErr := reader.Read(buf)
					if n > 0 {
						writeMu.Lock()
						if totalBytes < maxOutputSize {
							remaining := maxOutputSize - totalBytes
							toSend := n
							if int64(toSend) > remaining {
								toSend = int(remaining)
								outputCapped = true
							}
							totalBytes += int64(toSend)
							writeStreamEvent(StreamEvent{
								Stream: streamName,
								Chunk:  string(buf[:toSend]),
							})
							if outputCapped {
								writeStreamEvent(StreamEvent{
									Stream: "stderr",
									Chunk:  "\n[Output truncated: exceeded 256KB cap]\n",
								})
							}
						} else {
							outputCapped = true
						}
						writeMu.Unlock()
					}
					if rErr != nil {
						break
					}
				}
			}

			var wg sync.WaitGroup
			wg.Add(2)
			go streamPipe(stdoutPipe, "stdout", &wg)
			go streamPipe(stderrPipe, "stderr", &wg)
			wg.Wait()

			cmdErr := cmd.Wait()
			close(stopStats)
			duration := time.Since(start)

			exitCode := 0
			timedOut := false
			cancelled := false

			if _, wasCancelled := cancelledRuns.LoadAndDelete(runID); wasCancelled {
				cancelled = true
				exitCode = -1
				writeStreamEvent(StreamEvent{
					Stream: "stderr",
					Chunk:  "\n[Execution cancelled by user]\n",
				})
			} else if ctx.Err() == context.DeadlineExceeded {
				timedOut = true
				exitCode = -1
				_ = exec.Command("docker", "kill", containerName).Run()
				writeStreamEvent(StreamEvent{
					Stream: "stderr",
					Chunk:  fmt.Sprintf("\nTerminated: wall-time limit %ds\n", runTimeout),
				})
			} else if cmdErr != nil {
				if exitErr, ok := cmdErr.(*exec.ExitError); ok {
					exitCode = exitErr.ExitCode()
					// Exit code 137 is Docker OOM / SIGKILL
					if exitCode == 137 {
						writeStreamEvent(StreamEvent{
							Stream: "stderr",
							Chunk:  "\nKilled: memory limit exceeded\n",
						})
					}
				} else {
					exitCode = -1
					cancelled = true
				}
			}

			writeStreamEvent(StreamEvent{
				Event:           "finished",
				RunID:           runID,
				ExitCode:        exitCode,
				DurationMs:      duration.Milliseconds(),
				PeakMemoryBytes: maxMemBytes,
				TimedOut:        timedOut,
				Cancelled:       cancelled,
				OutputCapped:    outputCapped,
			})
		})

		// Single-shot run endpoint (preserved for compatibility)
		authRouter.Post("/api/exec/run", func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxCodeSize+1024)

			var req ExecRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
				return
			}

			if req.Code == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code is required"})
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

			if err := exec.Command("docker", "version").Run(); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{
					"error": "Docker is not available. Code execution requires Docker.",
				})
				return
			}

			runID := req.RunID
			if runID == "" {
				runID = uuid.New().String()[:8]
			}
			containerName := fmt.Sprintf("syncspace-exec-%s", runID)
			registerContainer(runID, containerName)
			defer unregisterContainer(runID)

			// Enforce global concurrency cap (max 5 simultaneous containers across all instances)
			select {
			case concurrencySem <- struct{}{}:
				defer func() { <-concurrencySem }()
			default:
				writeJSON(w, http.StatusTooManyRequests, map[string]string{
					"error": "server execution concurrency limit reached (max 5 simultaneous runs); please try again shortly",
				})
				return
			}

			homeDir, _ := os.UserHomeDir()
			execTmpBase := fmt.Sprintf("%s/.syncspace-exec-tmp", homeDir)
			_ = os.MkdirAll(execTmpBase, 0755)
			tmpDir, err := os.MkdirTemp(execTmpBase, "run-*")
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create temp dir"})
				return
			}
			defer os.RemoveAll(tmpDir)
			_ = os.Chmod(tmpDir, 0755)

			ext := languageExtensions[req.Language]
			codePath := fmt.Sprintf("%s/main.%s", tmpDir, ext)
			if err := os.WriteFile(codePath, []byte(req.Code), 0644); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write code"})
				return
			}

			args := []string{
				"run",
				"--name", containerName,
				"--network", "none",
				"--memory", memoryLimit,
				"--cpus", cpuLimit,
				"--pids-limit", pidsLimit,
				"--read-only",
				"--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
				"--security-opt", "no-new-privileges",
				"--cap-drop", "ALL",
				"--user", "65534:65534",
				"-v", fmt.Sprintf("%s:/code:ro", tmpDir),
			}

			if req.Language == "go" {
				args = append(args, "--tmpfs", "/go:rw,exec,size=128m")
				args = append(args, "--tmpfs", "/root:rw,size=64m")
				args[len(args)-3] = "0:0"
			}

			args = append(args, image)
			args = append(args, languageCommands[req.Language]...)

			runTimeout := timeoutSec
			if req.TimeoutSeconds > 0 && req.TimeoutSeconds < timeoutSec {
				runTimeout = req.TimeoutSeconds
			}

			ctx, cancel := context.WithTimeout(r.Context(), time.Duration(runTimeout)*time.Second)
			defer cancel()

			start := time.Now()
			cmd := exec.CommandContext(ctx, "docker", args...)

			var stdout, stderr bytes.Buffer
			cmd.Stdout = &limitedWriter{buf: &stdout, limit: maxOutputSize}
			cmd.Stderr = &limitedWriter{buf: &stderr, limit: maxOutputSize}

			defer func() {
				_ = exec.Command("docker", "rm", "-f", containerName).Run()
			}()

			err = cmd.Run()
			duration := time.Since(start)

			response := ExecResponse{
				ID:         runID,
				Stdout:     stdout.String(),
				Stderr:     stderr.String(),
				DurationMs: duration.Milliseconds(),
				Language:   req.Language,
			}

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
				response.Stderr += fmt.Sprintf("\nTerminated: wall-time limit %ds\n", timeoutSec)
				_ = exec.Command("docker", "kill", containerName).Run()
			} else if err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok {
					response.ExitCode = exitErr.ExitCode()
					if response.ExitCode == 137 {
						response.Stderr += "\nKilled: memory limit exceeded\n"
					}
				} else {
					response.ExitCode = -1
					response.Stderr = err.Error()
				}
			} else {
				response.ExitCode = 0
			}

			writeJSON(w, http.StatusOK, response)
		})
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%s", port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("Shutting down exec service...")
		srv.Close()
	}()

	log.Printf("SyncSpace Exec Service listening on :%s (env=%s, timeout=%ds, mem=%s, cpu=%s, pids=%s)",
		port, env, timeoutSec, memoryLimit, cpuLimit, pidsLimit)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

type limitedWriter struct {
	buf   *bytes.Buffer
	limit int
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	remaining := lw.limit - lw.buf.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	return lw.buf.Write(p)
}

func parseMemBytes(raw string) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	// e.g. "14.2MiB", "1.5GiB", "500KiB", "100B"
	multiplier := int64(1)
	clean := raw
	if strings.HasSuffix(raw, "GiB") || strings.HasSuffix(raw, "GB") {
		multiplier = 1024 * 1024 * 1024
		clean = strings.TrimSuffix(strings.TrimSuffix(raw, "GiB"), "GB")
	} else if strings.HasSuffix(raw, "MiB") || strings.HasSuffix(raw, "MB") {
		multiplier = 1024 * 1024
		clean = strings.TrimSuffix(strings.TrimSuffix(raw, "MiB"), "MB")
	} else if strings.HasSuffix(raw, "KiB") || strings.HasSuffix(raw, "KB") {
		multiplier = 1024
		clean = strings.TrimSuffix(strings.TrimSuffix(raw, "KiB"), "KB")
	} else if strings.HasSuffix(raw, "B") {
		clean = strings.TrimSuffix(raw, "B")
	}
	val, err := strconv.ParseFloat(strings.TrimSpace(clean), 64)
	if err != nil {
		return 0
	}
	return int64(val * float64(multiplier))
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
