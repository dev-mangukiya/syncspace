package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/syncspace/ws-server/internal/database"
	"github.com/syncspace/ws-server/internal/models"
	"github.com/syncspace/ws-server/internal/realtime"
)

const (
	// maxUploadSize is the maximum file content size accepted (512 KB).
	maxUploadSize = 512 * 1024
)

// WorkspaceHandler manages workspace CRUD operations
type WorkspaceHandler struct {
	db  *database.DB
	hub *realtime.Hub
}

// NewWorkspaceHandler creates a new WorkspaceHandler
func NewWorkspaceHandler(db *database.DB, hub *realtime.Hub) *WorkspaceHandler {
	return &WorkspaceHandler{db: db, hub: hub}
}

// resolveWorkspaceAccess is a unified access-check helper.
// Returns the workspace and the user's role.
// Returns 404 for both non-existent and non-member workspaces (prevents enumeration).
// Set requireWrite=true to reject viewers.
func (h *WorkspaceHandler) resolveWorkspaceAccess(w http.ResponseWriter, r *http.Request, requireWrite bool) (*models.Workspace, models.WorkspaceRole) {
	claims := getClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return nil, ""
	}

	slug := chi.URLParam(r, "slug")
	ws, err := h.db.GetWorkspaceBySlug(slug)
	if err != nil || ws == nil {
		// Fallback: try short_id (opaque UUID-hex identifier)
		ws, err = h.db.GetWorkspaceByShortID(slug)
		if err != nil || ws == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return nil, ""
		}
	}

	role, _ := h.db.GetMemberRole(ws.ID, claims.UserID)
	if role == "" {
		if ws.IsPublic {
			role = models.RoleViewer
		} else {
			// Return 404, not 403, to prevent workspace enumeration
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return nil, ""
		}
	}

	if requireWrite && role == models.RoleViewer {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
		return nil, ""
	}

	return ws, role
}

var slugRegex = regexp.MustCompile(`[^a-z0-9]+`)

func generateSlug(name string) string {
	slug := strings.ToLower(strings.TrimSpace(name))
	slug = slugRegex.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 64 {
		slug = slug[:64]
	}
	return slug
}

type createWorkspaceRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Template    string `json:"template"`
	Language    string `json:"language"`
}

// Create creates a new workspace
func (h *WorkspaceHandler) Create(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return
	}

	var req createWorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 128 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "workspace name must be 1-128 characters",
		})
		return
	}

	if req.Template == "" {
		req.Template = "blank"
	}
	if req.Language == "" {
		req.Language = "javascript"
	}

	// Generate a unique slug
	baseSlug := generateSlug(req.Name)
	slug := baseSlug
	for i := 1; ; i++ {
		existing, _ := h.db.GetWorkspaceBySlug(slug)
		if existing == nil {
			break
		}
		slug = fmt.Sprintf("%s-%d", baseSlug, i)
	}

	ws, err := h.db.CreateWorkspace(req.Name, slug, req.Description, claims.UserID, req.Template, req.Language)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create workspace"})
		return
	}

	// Seed template files
	if err := h.seedTemplateFiles(ws); err != nil {
		// Non-fatal: workspace exists, just no starter files
		fmt.Printf("Warning: failed to seed template files: %v\n", err)
	}

	writeJSON(w, http.StatusCreated, ws)
}

// List returns all workspaces for the current user
func (h *WorkspaceHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
		return
	}

	workspaces, err := h.db.ListUserWorkspaces(claims.UserID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list workspaces"})
		return
	}

	if workspaces == nil {
		workspaces = []models.WorkspaceWithRole{}
	}

	writeJSON(w, http.StatusOK, workspaces)
}

// Get returns a single workspace by slug
func (h *WorkspaceHandler) Get(w http.ResponseWriter, r *http.Request) {
	ws, role := h.resolveWorkspaceAccess(w, r, false)
	if ws == nil {
		return
	}
	writeJSON(w, http.StatusOK, models.WorkspaceWithRole{Workspace: *ws, Role: role})
}

// Delete deletes a workspace (owner only)
func (h *WorkspaceHandler) Delete(w http.ResponseWriter, r *http.Request) {
	ws, role := h.resolveWorkspaceAccess(w, r, false)
	if ws == nil {
		return
	}
	if role != models.RoleOwner {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner can delete a workspace"})
		return
	}
	if err := h.db.DeleteWorkspace(ws.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete workspace"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "workspace deleted"})
}

// ListFiles returns files in a workspace
func (h *WorkspaceHandler) ListFiles(w http.ResponseWriter, r *http.Request) {
	ws, _ := h.resolveWorkspaceAccess(w, r, false)
	if ws == nil {
		return
	}
	files, err := h.db.ListFiles(ws.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list files"})
		return
	}
	if files == nil {
		files = []models.File{}
	}
	writeJSON(w, http.StatusOK, files)
}

// GetFile returns a single file's content
func (h *WorkspaceHandler) GetFile(w http.ResponseWriter, r *http.Request) {
	ws, _ := h.resolveWorkspaceAccess(w, r, false)
	if ws == nil {
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path query parameter is required"})
		return
	}

	file, err := h.db.GetFile(ws.ID, filePath)
	if err != nil || file == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "file not found"})
		return
	}

	writeJSON(w, http.StatusOK, file)
}

// UpdateFile updates a file's content (requires editor or owner role)
func (h *WorkspaceHandler) UpdateFile(w http.ResponseWriter, r *http.Request) {
	ws, _ := h.resolveWorkspaceAccess(w, r, true) // requireWrite=true rejects viewers
	if ws == nil {
		return
	}

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	file, err := h.db.UpdateFileContent(ws.ID, req.Path, req.Content)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update file"})
		return
	}

	writeJSON(w, http.StatusOK, file)
}

// BeaconPersist is a fire-and-forget endpoint for navigator.sendBeacon.
// Called by the beforeunload handler to flush the Y.Doc content before the
// tab closes. Returns 204 immediately — the browser doesn't wait for the
// response since it's already unloading.
func (h *WorkspaceHandler) BeaconPersist(w http.ResponseWriter, r *http.Request) {
	ws, _ := h.resolveWorkspaceAccess(w, r, true)
	if ws == nil {
		return
	}

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if req.Path == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	// Best-effort persist — errors are swallowed since the tab is closing
	h.db.UpdateFileContent(ws.ID, req.Path, req.Content)
	w.WriteHeader(http.StatusNoContent)
}

// CreateFile creates a new file in a workspace (requires editor or owner role)
func (h *WorkspaceHandler) CreateFile(w http.ResponseWriter, r *http.Request) {
	ws, _ := h.resolveWorkspaceAccess(w, r, true)
	if ws == nil {
		return
	}

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	req.Path = strings.TrimSpace(req.Path)
	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	// Path validation — prevent directory traversal and bad filenames
	if !isValidFilePath(req.Path) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid file path"})
		return
	}

	// Upload constraints
	if len(req.Content) > maxUploadSize {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("file content exceeds %d KB limit", maxUploadSize/1024)})
		return
	}
	if req.Content != "" && !utf8.ValidString(req.Content) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "binary files are not supported — only UTF-8 text"})
		return
	}

	// Check if file already exists
	existing, _ := h.db.GetFile(ws.ID, req.Path)
	if existing != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "file already exists"})
		return
	}

	// Detect language from extension
	lang := detectLanguage(req.Path)

	file, err := h.db.CreateFile(ws.ID, req.Path, req.Content, lang)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create file"})
		return
	}

	// Broadcast file tree change to all connected clients
	h.broadcastFileTreeEvent(ws.ShortID, "file_created", req.Path, "")

	writeJSON(w, http.StatusCreated, file)
}

// DeleteFile removes a file from a workspace (requires editor or owner role)
func (h *WorkspaceHandler) DeleteFile(w http.ResponseWriter, r *http.Request) {
	ws, _ := h.resolveWorkspaceAccess(w, r, true)
	if ws == nil {
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path query parameter is required"})
		return
	}

	if err := h.db.DeleteFile(ws.ID, filePath); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "file not found"})
		return
	}

	// Broadcast file tree change to all connected clients
	h.broadcastFileTreeEvent(ws.ShortID, "file_deleted", filePath, "")

	writeJSON(w, http.StatusOK, map[string]string{"message": "file deleted"})
}

// RenameFile renames/moves a file within a workspace.
// Both source and destination paths are validated for traversal attacks.
func (h *WorkspaceHandler) RenameFile(w http.ResponseWriter, r *http.Request) {
	ws, _ := h.resolveWorkspaceAccess(w, r, true)
	if ws == nil {
		return
	}

	var req struct {
		OldPath string `json:"old_path"`
		NewPath string `json:"new_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	req.OldPath = strings.TrimSpace(req.OldPath)
	req.NewPath = strings.TrimSpace(req.NewPath)

	if req.OldPath == "" || req.NewPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "old_path and new_path are required"})
		return
	}
	if req.OldPath == req.NewPath {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "old_path and new_path are the same"})
		return
	}

	// Validate BOTH paths for traversal attacks
	if !isValidFilePath(req.OldPath) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source path"})
		return
	}
	if !isValidFilePath(req.NewPath) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid destination path"})
		return
	}

	// Check source exists
	src, _ := h.db.GetFile(ws.ID, req.OldPath)
	if src == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source file not found"})
		return
	}

	// Check dest doesn't already exist
	dst, _ := h.db.GetFile(ws.ID, req.NewPath)
	if dst != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "destination file already exists"})
		return
	}

	// Perform rename
	newLang := detectLanguage(req.NewPath)
	if err := h.db.RenameFile(ws.ID, req.OldPath, req.NewPath, newLang); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to rename file"})
		return
	}

	// Broadcast rename to all connected clients
	h.broadcastFileTreeEvent(ws.ShortID, "file_renamed", req.OldPath, req.NewPath)

	writeJSON(w, http.StatusOK, map[string]string{"message": "file renamed", "old_path": req.OldPath, "new_path": req.NewPath})
}

// broadcastFileTreeEvent sends a file-tree change notification to all WS clients in a workspace.
func (h *WorkspaceHandler) broadcastFileTreeEvent(workspaceShortID, eventType, path, newPath string) {
	if h.hub == nil {
		return
	}
	event := map[string]string{
		"type":    eventType,
		"path":    path,
	}
	if newPath != "" {
		event["new_path"] = newPath
	}
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[WS] Failed to marshal file tree event: %v", err)
		return
	}
	h.hub.BroadcastToWorkspace(workspaceShortID, data)
}

// isValidFilePath checks for directory traversal and bad path patterns
func isValidFilePath(path string) bool {
	if len(path) > 255 {
		return false
	}
	if strings.Contains(path, "..") {
		return false
	}
	if strings.Contains(path, "//") {
		return false
	}
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, ".") {
		return false
	}
	// Only allow alphanumeric, dot, dash, underscore, slash
	validPath := regexp.MustCompile(`^[a-zA-Z0-9._\-/]+$`)
	return validPath.MatchString(path)
}

// detectLanguage returns the programming language from a file extension
func detectLanguage(path string) string {
	parts := strings.Split(path, ".")
	if len(parts) < 2 {
		return "plaintext"
	}
	ext := strings.ToLower(parts[len(parts)-1])
	langMap := map[string]string{
		"js": "javascript", "jsx": "javascript", "ts": "typescript", "tsx": "typescript",
		"py": "python", "rb": "ruby", "go": "go", "rs": "rust", "java": "java",
		"json": "json", "md": "markdown", "html": "html", "css": "css",
		"yml": "yaml", "yaml": "yaml", "xml": "xml", "sql": "sql",
		"sh": "shell", "bash": "shell", "txt": "plaintext",
	}
	if lang, ok := langMap[ext]; ok {
		return lang
	}
	return "plaintext"
}

// seedTemplateFiles creates starter files based on the workspace template
func (h *WorkspaceHandler) seedTemplateFiles(ws *models.Workspace) error {
	templates := map[string][]struct {
		path     string
		content  string
		language string
	}{
		"javascript": {
			{
				path: "index.js",
				content: `// Pagination and Data Slicing Module
console.log("Hello from SyncSpace!");

function paginate(items, page = 1, pageSize = 10) {
  if (page < 1 || pageSize < 1) {
    throw new RangeError("Page and pageSize must be positive integers");
  }
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}

function runChecks() {
  console.log("Running pagination verification suite...");
  const records = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    title: ` + "`Record #${i + 1}`" + `,
  }));

  const testCases = [
    { page: 1, size: 5, expectedLen: 5 },
    { page: 2, size: 5, expectedLen: 5 },
    { page: 3, size: 10, expectedLen: 10 },
  ];

  let passed = 0;
  for (const tc of testCases) {
    const pageItems = paginate(records, tc.page, tc.size);
    if (pageItems.length === tc.expectedLen) {
      console.log(` + "` PASS: Page ${tc.page} (size=${tc.size}) returned ${pageItems.length} items`" + `);
      passed++;
    } else {
      console.error(` + "` FAIL: Page ${tc.page} (size=${tc.size}) expected ${tc.expectedLen} items, got ${pageItems.length}`" + `);
    }
  }

  console.log(` + "`\\nResults: ${passed}/${testCases.length} tests passed`" + `);
  if (passed < testCases.length) {
    process.exit(1);
  }
}

runChecks();
`,
				language: "javascript",
			},
		},
		"python": {
			{
				path: "app.py",
				content: `"""Temperature conversion utility module."""

def convert_temperature(value: float, unit: str) -> float:
    unit = unit.upper()
    if unit == 'C':
        return (value * 5 / 9) + 32
    elif unit == 'F':
        return (value - 32) * 5 / 9
    raise ValueError(f"Unsupported unit: {unit}")

def run_tests():
    print("Running temperature conversion checks...")
    test_cases = [
        (0.0, 'C', 32.0),
        (100.0, 'C', 212.0),
        (212.0, 'F', 100.0),
        (32.0, 'F', 0.0),
        (-40.0, 'C', -40.0),
    ]

    passed = 0
    for val, unit, expected in test_cases:
        actual = round(convert_temperature(val, unit), 1)
        if actual == expected:
            print(f"  PASS: {val}°{unit} -> {actual}")
            passed += 1
        else:
            print(f"  FAIL: {val}°{unit} expected {expected}, got {actual}")

    print(f"\nSummary: {passed}/{len(test_cases)} tests passed")
    if passed < len(test_cases):
        raise SystemExit(1)

if __name__ == '__main__':
    run_tests()
`,
				language: "python",
			},
		},
		"blank": {
			{
				path:     "main.js",
				content:  "// Start coding here\nconsole.log('Hello from SyncSpace!');\n",
				language: "javascript",
			},
		},
	}

	fileList, ok := templates[ws.Template]
	if !ok {
		fileList = templates["blank"]
	}

	for _, f := range fileList {
		_, err := h.db.CreateFile(ws.ID, f.path, f.content, f.language)
		if err != nil {
			return fmt.Errorf("failed to create file %s: %w", f.path, err)
		}
	}

	return nil
}
