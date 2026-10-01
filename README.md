# SyncSpace

A real-time collaborative code editor with sandboxed execution and AI assistance.

Built with Go, Next.js, PostgreSQL, WebSocket, and Docker.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                             │
│               Next.js 14 · Monaco Editor                    │
│         TypeScript · WebSocket · Design System              │
├────────────┬─────────────────────────────┬──────────────────┤
│            │           HTTP/WS           │                  │
│   ┌────────▼────────┐          ┌─────────▼──────────┐       │
│   │   ws-server     │          │   exec-service     │       │
│   │   Go · Chi      │ ──────► │   Go · Docker      │       │
│   │   JWT · RBAC    │  secret  │   Sandboxed exec   │       │
│   │   WebSocket Hub │          │   Cap-drop ALL     │       │
│   └────────┬────────┘          └────────────────────┘       │
│            │                                                │
│   ┌────────▼────────┐                                       │
│   │  PostgreSQL 16  │                                       │
│   │  Users · Files  │                                       │
│   │  Workspaces     │                                       │
│   └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## Features

| Feature | Implementation |
|---------|----------------|
| Code editor | Monaco (VS Code engine), custom dark/light themes |
| Real-time collab | WebSocket hub, presence tracking, cursor broadcasting |
| File management | Create, edit, delete files with auto-save |
| Code execution | Docker containers with --cap-drop ALL, --user nobody |
| AI assistant | OpenAI-compatible API, 6-turn history, code block extraction |
| Auth | JWT, bcrypt, RBAC (owner/editor/viewer) |
| Security | Rate limiting, HSTS, CSP, input caps, path validation |
| Design system | CSS custom properties, IBM Plex Sans, JetBrains Mono |

## Quick Start

### Prerequisites

- Go 1.22+
- Node.js 18+
- PostgreSQL 16 (or Docker)
- Docker runtime (Docker Desktop, Colima, or Podman)

### 1. Start PostgreSQL

```bash
docker compose up -d postgres
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — set JWT_SECRET, GROQ_API_KEY, EXEC_SERVICE_SECRET
```

### 3. Start the backend

```bash
cd ws-server
go build -o ./bin/ws-server ./cmd/server
./bin/ws-server
```

### 4. Start the execution service

```bash
cd exec-service
go build -o ./bin/exec-server ./cmd/server
DOCKER_HOST=unix:///var/run/docker.sock ./bin/exec-server
```

### 5. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Docker Compose (Full Stack)

```bash
cp .env.example .env
# Set required values in .env

docker compose up -d
```

Services:
- Frontend: http://localhost:3000
- API: http://localhost:8080
- Exec: http://localhost:8081 (run natively with Docker socket access)

## Project Structure

```
syncspace/
├── ws-server/                 # Go REST + WebSocket server
│   ├── cmd/server/            # Entry point, router, middleware
│   ├── internal/
│   │   ├── auth/              # JWT generation, validation, claims
│   │   ├── database/          # PostgreSQL queries, migrations
│   │   ├── handlers/          # HTTP handlers (auth, workspace, AI)
│   │   ├── middleware/        # Auth, rate limiting, security headers
│   │   ├── models/            # Data models, roles
│   │   └── realtime/          # WebSocket hub, connection management
│   └── migrations/            # SQL migration files
│
├── exec-service/              # Go code execution service
│   ├── cmd/server/            # Entry point
│   └── internal/              # Docker sandbox execution
│
├── frontend/                  # Next.js 14 application
│   └── app/
│       ├── auth/              # Login, signup pages
│       ├── components/ui/     # Logo, ThemeToggle
│       ├── dashboard/         # Workspace management
│       ├── design-system/     # Design system showcase
│       ├── lib/               # API client, store, hooks, themes
│       └── workspace/[slug]/  # Editor, AI chat, output panel
│
├── docker-compose.yml
└── .env.example
```

## Security

| Layer | Measure |
|-------|---------|
| Auth | JWT with bcrypt, min 32-char secret in production |
| RBAC | Owner, Editor, Viewer roles per workspace |
| Rate limiting | 10/min auth, 30/min exec (token bucket) |
| Execution | --cap-drop ALL, --user nobody, --network none, --read-only |
| Input caps | 64KB request body, 4KB messages, 32KB code context |
| Output caps | 256KB execution output, 256KB AI response |
| Timeouts | 10s exec, 30s AI, 60s WebSocket ping/pong |
| Headers | HSTS, CSP, X-Content-Type-Options, X-Frame-Options |
| Path validation | No traversal, no hidden files, alphanumeric + ./- only |
| Enumeration | 404 for non-member workspaces (not 403) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Production | dev secret | JWT signing key (min 32 chars) |
| `POSTGRES_USER` | No | syncspace | Database user |
| `POSTGRES_PASSWORD` | Production | syncspace_dev | Database password |
| `POSTGRES_DB` | No | syncspace | Database name |
| `CORS_ORIGIN` | No | http://localhost:3000 | Allowed CORS origin |
| `ENV` | No | development | Environment (development/production) |
| `GROQ_API_KEY` | For AI | — | Groq API key |
| `GROQ_MODEL` | No | llama-3.1-8b-instant | LLM model name |
| `AI_BASE_URL` | No | Groq URL | Any OpenAI-compatible endpoint |
| `EXEC_SERVICE_SECRET` | Production | — | Shared secret for exec auth |

## WebSocket Protocol

Connect: `ws://localhost:8080/ws/{slug}?token={jwt}`

Message format:
```json
{
  "type": "cursor|selection|file_switch|presence",
  "user_id": "uuid",
  "username": "string",
  "workspace": "slug",
  "payload": {}
}
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/signup | No | Create account |
| POST | /api/auth/login | No | Login (email or username) |
| GET | /api/auth/me | Yes | Current user |
| GET | /api/workspaces | Yes | List workspaces |
| POST | /api/workspaces | Yes | Create workspace |
| GET | /api/workspaces/:slug | Yes | Get workspace |
| DELETE | /api/workspaces/:slug | Yes | Delete workspace |
| GET | /api/workspaces/:slug/files | Yes | List files |
| GET | /api/workspaces/:slug/file | Yes | Get file |
| POST | /api/workspaces/:slug/file | Yes | Create file |
| PUT | /api/workspaces/:slug/file | Yes | Update file |
| DELETE | /api/workspaces/:slug/file | Yes | Delete file |
| POST | /api/ai/chat | Yes | AI chat |
| GET | /ws/:slug | Yes | WebSocket |
| GET | /health | No | Health check |

## Tests

```bash
cd ws-server && go test ./... -v
```

## License

MIT
