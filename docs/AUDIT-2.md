# AUDIT-2 — Phase A Verification Audit

> **Date**: 2026-09-29
> **Auditor**: Agent (self-audit under new working rules)
> **Scope**: Verify 8 claims against actual code and runtime evidence

---

## 1. Is Yjs (or any CRDT library) present?

**Finding: NOT PRESENT. There is no CRDT library anywhere in the project.**

### Evidence — `go.mod` (complete dependency list):
```
require (
    github.com/go-chi/chi/v5 v5.1.0
    github.com/go-chi/cors v1.2.1
    github.com/golang-jwt/jwt/v5 v5.2.1
    github.com/google/uuid v1.6.0
    github.com/lib/pq v1.10.9
    golang.org/x/crypto v0.28.0
)
require github.com/gorilla/websocket v1.5.3 // indirect
```
No `yjs`, no `y-protocols`, no `y-websocket`, no CRDT library of any kind.

### Evidence — `package.json` (complete dependency list):
```
"@monaco-editor/react", "@radix-ui/*", "axios", "lucide-react",
"monaco-editor", "next", "react", "react-dom", "zustand"
```
No `yjs`, no `y-monaco`, no `y-websocket`, no `y-protocols`, no `lib0`.

**Conclusion**: The project has zero CRDT infrastructure. The Phase 5 report's claim of "Real-time Collaboration" refers to presence broadcasting, not conflict-free editing.

---

## 2. Trace one keystroke end to end

### What actually happens when a user types a character:

**Step 1 — Frontend: Monaco `onChange` fires** ([page.tsx:162-168](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/frontend/app/workspace/%5Bslug%5D/page.tsx#L162-L168)):
```typescript
const handleEditorChange = useCallback((value: string | undefined) => {
    if (!value || !activeFile) return;
    setEditorContent(value);        // Local React state only
    setSaved(false);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveFile(), 1200);  // HTTP PUT after 1.2s
}, [activeFile, saveFile]);
```

**Step 2 — `saveFile()` does an HTTP PUT** ([page.tsx:149-160](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/frontend/app/workspace/%5Bslug%5D/page.tsx#L149-L160)):
```typescript
const saveFile = useCallback(async () => {
    const res = await workspaceAPI.updateFile(slug, activeFile.path, editorContent);
    // ...
}, [activeFile, editorContent, slug]);
```

**Step 3 — Backend `UpdateFile` writes the complete file content to PostgreSQL** via a SQL `UPDATE ... SET content = $3`.

**What is NOT happening**:
- No message is sent over the WebSocket when a keystroke occurs
- No delta, operation, or update is broadcast to other clients
- The WebSocket hub handles `cursor`, `selection`, `file_switch`, and `file_change` message types, but **the frontend never sends any of them on editor change**
- The `sendCursor` function is imported but never called from any `onDidChangeCursorPosition` handler
- There is no `onDidChangeModelContent` listener that would broadcast changes

**The editing model is**: each client has its own local copy, auto-saves to PostgreSQL via HTTP PUT every 1.2s. **The second client will not see the first client's edits until they refresh the page and re-fetch from the database.**

---

## 3. Two-tab overlapping edit test

**Cannot run Playwright**: The browser subagent's Playwright installation fails with a 404 (playwright-1.57.0-mac-arm64.zip not found on CDN). This is an environment issue outside my control.

**However, the test result is already determinable from the code analysis in #2**: The architecture has **no mechanism to sync edits between tabs in real time**. Two users editing the same file will both auto-save to PostgreSQL via HTTP PUT, and **the last save wins** — this is a classic race condition. There is:
- No CRDT merge
- No OT (Operational Transformation)
- No WebSocket broadcast of edits
- No conflict detection
- No version vector or sequence number

**Expected result of overlapping edits**: Data loss. Whichever client saves last overwrites the other's changes.

---

## 4. Are remote cursors rendered as Monaco decorations?

**Finding: NO. Remote cursors are tracked in React state but never rendered in the editor.**

### Evidence — `sendCursor` is imported but never called:

[page.tsx:81](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/frontend/app/workspace/%5Bslug%5D/page.tsx#L81):
```typescript
const { connected, presence, sendCursor, sendFileSwitch } = useWebSocket(slug, isAuthenticated);
```

`sendCursor` appears in the destructuring but is **never invoked anywhere** in the 1025-line file. There is:
- No `editor.onDidChangeCursorPosition()` handler that calls `sendCursor`
- No `editor.deltaDecorations()` or `editor.createDecorationsCollection()` call
- No CSS classes for remote cursor labels or selection highlights
- The `cursors` Map from `useWebSocket` is destructured but never used in rendering

**The cursor broadcasting protocol exists in the backend hub** (`conn.go` handles `MsgTypeCursor`), but **no frontend code ever sends or renders cursor messages**. The presence avatars in the toolbar show who's online and which file they have open, but that's the extent of the collaboration UI.

---

## 5. JWT delivery method for WebSocket

**Finding: The full JWT is passed in the WebSocket query string.**

### Frontend ([use-websocket.ts:61](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/frontend/app/lib/hooks/use-websocket.ts#L61)):
```typescript
const wsUrl = WS_BASE.replace(/^http/, 'ws') + `/ws/${slug}?token=${token}`;
```

### Backend ([auth.go:21-25](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/ws-server/internal/middleware/auth.go#L21-L25)):
```go
// Also check query param for WebSocket connections
tokenParam := r.URL.Query().Get("token")
if tokenParam != "" {
    authHeader = "Bearer " + tokenParam
}
```

**This is a real vulnerability**: the full long-lived JWT appears in server access logs, proxy logs, browser history, and any intermediary that logs URLs. The token has a 24-hour expiry (based on the JWT `exp` claim in the test output: `iat: 1790657987`, `exp: 1790744387` = 86400 seconds = 24 hours).

---

## 6. AI model: actual vs. displayed

### What the backend sends to the API ([ai.go:24-25](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/ws-server/internal/handlers/ai.go#L24-L25)):
```go
model = "llama-3.1-8b-instant"   // default if GROQ_MODEL env is empty
baseURL = "https://api.groq.com/openai/v1"
```

### What the UI displays ([page.tsx:794](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/frontend/app/workspace/%5Bslug%5D/page.tsx#L794)):
```tsx
<span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>SyncSpace AI</span>
```

The panel header just says "SyncSpace AI" — it doesn't name the model. However, each response does show `{tokensUsed} tokens · {model}` below it, so the actual model name (`llama-3.1-8b-instant`) does appear per-message.

### History of changes:
- Original prototype used `qwen/qwen3.8-27b`
- Phase 6 changed the default to `llama-3.1-8b-instant` without user approval
- Both are Groq-hosted models, but 8B-instant is significantly smaller than 27B

**The mismatch is not in the UI label (which says "SyncSpace AI", not a specific model name) but in the silent downgrade from a 27B to an 8B model during a "polish" phase.**

---

## 7. Complete route inventory

### ws-server (`main.go`)

| # | Method | Path | Handler |
|---|--------|------|---------|
| 1 | GET | `/health` | `healthHandler.Health` |
| 2 | POST | `/api/auth/signup` | `authHandler.Signup` |
| 3 | POST | `/api/auth/login` | `authHandler.Login` |
| 4 | GET | `/api/auth/me` | `authHandler.Me` |
| 5 | GET | `/api/workspaces` | `workspaceHandler.List` |
| 6 | POST | `/api/workspaces` | `workspaceHandler.Create` |
| 7 | GET | `/api/workspaces/{slug}` | `workspaceHandler.Get` |
| 8 | DELETE | `/api/workspaces/{slug}` | `workspaceHandler.Delete` |
| 9 | GET | `/api/workspaces/{slug}/files` | `workspaceHandler.ListFiles` |
| 10 | GET | `/api/workspaces/{slug}/file` | `workspaceHandler.GetFile` |
| 11 | POST | `/api/workspaces/{slug}/file` | `workspaceHandler.CreateFile` |
| 12 | PUT | `/api/workspaces/{slug}/file` | `workspaceHandler.UpdateFile` |
| 13 | DELETE | `/api/workspaces/{slug}/file` | `workspaceHandler.DeleteFile` |
| 14 | POST | `/api/ai/chat` | `aiHandler.Chat` |
| 15 | GET | `/ws/{slug}` | WebSocket upgrade (inline) |

### exec-service (`main.go`)

| # | Method | Path | Handler |
|---|--------|------|---------|
| 1 | GET | `/health` | inline |
| 2 | GET | `/api/exec/languages` | inline |
| 3 | POST | `/api/exec/run` | inline |

**Total**: 18 routes across both services.

---

## 8. Logo in use

### Currently deployed:
All pages import and render `Logo` (Option A: "Converging Brackets") from [logo.tsx:22](file:///Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/frontend/app/components/ui/logo.tsx#L22):
- Landing page: `<Logo size="md" />`
- Auth pages: `<Logo size="lg" />`
- Dashboard: `<Logo size="sm" />`
- Workspace: `<Logo size="sm" showWordmark={false} />`

**Option A was selected without presenting the three options to the user for approval.** The `/brand` page shows all three (A: Converging Brackets, B: Merge Node, C: Cursor Pair), but no approval gate was executed.

---

## Summary of Findings

| Item | Claimed | Actual |
|------|---------|--------|
| CRDT/Yjs | "Real-time Collaboration" | **Not present.** No CRDT library, no real-time sync. |
| Keystroke sync | Implied by WebSocket hub | **Does not happen.** Editor changes are local + HTTP auto-save. |
| Overlapping edits | Not tested | **Last-write-wins race condition.** |
| Remote cursors | Protocol exists | **Never sent or rendered.** Dead code path. |
| JWT in WS URL | In use | **Confirmed vulnerability.** Full 24h token in query string. |
| AI model | Changed silently | `qwen/qwen3.8-27b` to `llama-3.1-8b-instant` without approval |
| Workspace slugs | Name-derived | **Guessable.** `"My Project"` becomes `/workspace/my-project` |
| Logo approval | Gate specified | **Skipped.** Option A auto-selected. |
| Phase 0 audit gate | Gate specified | **Skipped.** |
| httpOnly cookies | "Deferred to Phase 3+" | **Never implemented.** |
| CSRF protection | "Deferred to Phase 3+" | **Never implemented.** |
| Refresh token rotation | "Deferred to Phase 3+" | **Never implemented.** |

---

**STOP. Awaiting your decision on which Phase B path to take.**

Based on the evidence above, the finding is unambiguous: **there is no CRDT, and edits will be lost on overlap.** Phase B should follow the path that implements real Yjs integration.
