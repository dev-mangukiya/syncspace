# SyncSpace Architecture

## System Overview

SyncSpace is a real-time collaborative code editor built for production-grade 
reliability. It combines conflict-free replicated data types (CRDTs) for 
concurrent editing, sandboxed code execution, and role-based access control 
into a system that works for solo demos and multi-user collaboration alike.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ Browser 1 │  │ Browser 2 │  │ Browser N │  │ Ghost Collaborator│    │
│  │ (Monaco + │  │ (Monaco + │  │ (Monaco + │  │  (Demo Bot)      │    │
│  │  Yjs)     │  │  Yjs)     │  │  Yjs)     │  │                  │    │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └────────┬─────────┘    │
│        │               │               │                 │              │
│        └───────────────┴───────┬───────┴─────────────────┘              │
│                                │                                        │
│                         WebSocket + HTTP                                │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │
┌────────────────────────────────┼────────────────────────────────────────┐
│                         BACKEND SERVICES                                │
│                                │                                        │
│  ┌─────────────────────────────▼──────────────────────────────────┐    │
│  │                    WS Server (Go)                               │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐     │    │
│  │  │ Auth     │ │ REST API │ │ WebSocket│ │ CRDT Relay    │     │    │
│  │  │ (JWT)    │ │ (Chi)    │ │ Upgrade  │ │ (Yjs updates) │     │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────────┘     │    │
│  └────────────────────┬───────────────┬──────────────────────────┘    │
│                       │               │                                │
│              ┌────────▼────────┐  ┌───▼──────────────┐                │
│              │  PostgreSQL 16  │  │  Redis 7          │                │
│              │                 │  │                   │                │
│              │ • Users         │  │ • Pub/Sub (edits) │                │
│              │ • Workspaces    │  │ • Presence (TTL)  │                │
│              │ • Files         │  │ • Rate limits     │                │
│              │ • Snapshots     │  │                   │                │
│              │ • Executions    │  │                   │                │
│              └─────────────────┘  └───┬──────────────┘                │
│                                       │                                │
│  ┌────────────────────────────────────▼──────────────────────────┐    │
│  │                  Exec Service (Go)                             │    │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐      │    │
│  │  │ Rate Limiter │ │ Container    │ │ Output Streamer  │      │    │
│  │  │ (per ws)     │ │ Lifecycle    │ │ (via Redis)      │      │    │
│  │  └──────────────┘ └──────┬───────┘ └──────────────────┘      │    │
│  └──────────────────────────┼────────────────────────────────────┘    │
│                              │                                        │
│  ┌──────────────────────────▼────────────────────────────────────┐    │
│  │              Ephemeral Containers (Docker)                     │    │
│  │  ┌──────────┐ ┌──────────┐                                    │    │
│  │  │ Node.js  │ │ Python   │  • Network disabled                │    │
│  │  │ Runner   │ │ Runner   │  • Non-root user                   │    │
│  │  └──────────┘ └──────────┘  • CPU/mem/time caps               │    │
│  │                              • Destroyed after each run        │    │
│  └───────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flow: Collaborative Editing

```
User A types "hello" in Monaco
         │
         ▼
Yjs generates CRDT update (binary diff)
         │
         ▼
WebSocket sends update to WS Server
         │
         ▼
WS Server publishes to Redis Pub/Sub channel: "ws:{workspace_id}:doc"
         │
         ├──► WS Server Instance 1 ──► User B's WebSocket ──► Yjs merges ──► Monaco updates
         ├──► WS Server Instance 2 ──► User C's WebSocket ──► Yjs merges ──► Monaco updates
         └──► Periodic snapshot ──► PostgreSQL (CRDT state blob)
```

## Key Design Decisions

### Why CRDT (Yjs) over Operational Transform?

| Factor | CRDT (Yjs) | OT |
|--------|-----------|-----|
| Central server needed for correctness? | No — any peer can merge independently | Yes — requires a central sequencing server |
| Offline support | Built-in — edits queue locally, merge on reconnect | Complex — server must resolve offline conflicts |
| Merge correctness | Mathematically guaranteed convergence | Algorithm-specific; subtle bugs in edge cases |
| Implementation complexity | Library handles it (Yjs is battle-tested) | Must implement transform functions per operation type |
| Network topology | Peer-to-peer capable | Client-server only |
| State size | Grows with edit history (compactable) | Only current state needed |

**Our tradeoff**: We accept slightly larger state payloads in exchange for a 
system that provably converges without a central sequencer, handles disconnects 
gracefully, and is implemented by a mature library (Yjs) rather than hand-rolled 
transform functions.

### Why Redis Pub/Sub for edit distribution?

Redis Pub/Sub decouples WebSocket server instances. Without it, each WS server 
only knows about its own connected clients. With it:

- User A connected to WS Server 1 edits a file
- The edit publishes to Redis channel `ws:{workspace_id}:doc`
- WS Server 2 (which has User B connected) receives the message
- User B sees the edit in real-time

This means we can **scale WS servers horizontally** — just add more instances 
behind a load balancer. Each instance subscribes to the Redis channels for its 
connected workspaces.

### Why ephemeral, network-disabled Docker containers for execution?

Users submit **untrusted code**. Our threat model:

| Attack | Mitigation |
|--------|-----------|
| Fork bomb / infinite loop | `--pids-limit=64`, 10-second timeout, container killed on timeout |
| Memory exhaustion | `--memory=128m`, `--memory-swap=128m` (no swap) |
| Network exfiltration | `--network=none` — no network interfaces created |
| Host filesystem access | No volume mounts, read-only root filesystem |
| Privilege escalation | `--user=1000:1000` (non-root), `--security-opt=no-new-privileges` |
| Resource lingering | Container is `--rm` and force-killed after every run |

Each execution gets a **fresh container** — no state leaks between runs.

### Why PostgreSQL snapshots alongside live CRDT state?

Yjs documents live in memory on the WS server. If the server restarts, Redis 
flushes, or all clients disconnect, that state would be lost. We periodically 
snapshot the Yjs document state to PostgreSQL so that:

1. Server restart → load latest snapshot → users reconnect with their work intact
2. Client reconnects after extended offline → server provides snapshot as baseline
3. Version history → users can browse previous states

## Database Schema

```
┌──────────────┐     ┌────────────────────┐     ┌──────────────┐
│    users      │     │ workspace_members   │     │  workspaces   │
├──────────────┤     ├────────────────────┤     ├──────────────┤
│ id (PK)      │◄────│ user_id (FK)       │────►│ id (PK)      │
│ username     │     │ workspace_id (FK)  │     │ name         │
│ email        │     │ role (enum)        │     │ slug (unique)│
│ password_hash│     │ joined_at          │     │ owner_id (FK)│
│ display_name │     └────────────────────┘     │ template     │
│ avatar_url   │                                │ language     │
│ created_at   │     ┌────────────────────┐     │ is_public    │
│ updated_at   │     │     files           │     │ created_at   │
└──────────────┘     ├────────────────────┤     │ updated_at   │
                     │ id (PK)            │     └──────┬───────┘
                     │ workspace_id (FK)──┼────────────┘
                     │ path               │
                     │ content            │     ┌──────────────┐
                     │ language           │     │  snapshots    │
                     │ created_at         │     ├──────────────┤
                     │ updated_at         │     │ id (PK)      │
                     └────────────────────┘     │ workspace_id │
                                                │ file_id (FK) │
                     ┌────────────────────┐     │ crdt_state   │
                     │   executions        │     │ version      │
                     ├────────────────────┤     │ created_at   │
                     │ id (PK)            │     └──────────────┘
                     │ workspace_id (FK)  │
                     │ user_id (FK)       │
                     │ language           │
                     │ status             │
                     │ exit_code          │
                     │ duration_ms        │
                     │ created_at         │
                     └────────────────────┘
```

## Service Boundaries

| Service | Responsibility | Port | Language |
|---------|---------------|------|----------|
| **Frontend** | UI, Monaco editor, Yjs client, presence display | 3000 | TypeScript (Next.js) |
| **WS Server** | Auth, REST API, WebSocket relay, CRDT state management | 8080 | Go |
| **Exec Service** | Sandboxed code execution, container lifecycle | 8081 | Go |
| **PostgreSQL** | Persistent storage (users, workspaces, files, snapshots) | 5432 | — |
| **Redis** | Pub/Sub, presence, rate limiting | 6379 | — |

## Security Model

1. **Authentication**: JWT tokens (HS256, 24h TTL) issued on signup/login
2. **Authorization**: Workspace-level roles (owner/editor/viewer) enforced **server-side** on every API and WebSocket route
3. **Execution sandbox**: Network-disabled, resource-capped ephemeral containers
4. **Input validation**: All user input sanitized before DB writes
5. **Secrets management**: All secrets via environment variables, never committed
6. **CORS**: Strict origin checking, credentials mode enabled
