# SyncSpace Security Policy & Architecture

## Security Architecture Overview

SyncSpace provides real-time collaborative development and ephemeral containerized code execution. The architecture isolates user code execution, secures authentication tokens, and enforces rate limits.

---

### 1. Docker Socket Access (`/var/run/docker.sock`) — DEV-ONLY NOTICE

> [!CAUTION]
> **LOCAL DEVELOPMENT USE ONLY**: The `docker-compose.yml` service `exec-service` mounts `/var/run/docker.sock` to enable local developer sandboxing via Docker-outside-of-Docker on macOS/Linux workstations.
>
> In production environments:
> - The host Docker socket (`/var/run/docker.sock`) MUST NEVER be mounted into any web application or execution service container.
> - Production execution workloads are dispatched to isolated, dedicated worker nodes using MicroVMs (Firecracker / gVisor runsc) or managed ephemeral container runners (AWS Fargate, Google Cloud Run Jobs).
> - Production workers run with unprivileged rootless namespaces where containers cannot access host daemon sockets or hardware devices.

---

### 2. Secret Management & Production Invariants

1. **Zero Dev Default Secrets in Production**:
   - `JWT_SECRET`: Refuses known development defaults (`dev-jwt-secret-change-in-production`, `secret`, `changeme`, etc.) and requires minimum 32 characters in production.
   - `EXEC_SERVICE_SECRET`: Refuses known dev defaults (`syncspace_exec_secret_dev`, `dev-exec-secret`, `default-secret`, `secret`, etc.) and requires minimum 16 characters in production.
2. **Environment-Only Configuration**:
   - All API keys, database credentials, and secrets originate exclusively from environment variables or `.env`.
   - No credentials or API keys may be inlined in source files, git commits, shell scripts, or documentation.

---

### 3. Execution Sandboxing Controls (Phase D Hardening)

All sandbox containers run with the following kernel security restrictions:
- **Root Filesystem**: `--read-only` (read-only root filesystem prevents binary tampering or persistence).
- **Network**: `--network none` (complete network isolation; all outbound connections blocked).
- **Memory**: Strict cgroup v2 memory cap at 128MB.
- **CPU**: Capped at 0.5 CPU (`--cpus=0.5`).
- **PIDs**: Capped at 64 processes (`--pids-limit=64` to prevent fork bombs).
- **Capabilities**: All Linux capabilities dropped (`--cap-drop=ALL`).
- **Privilege Escalation**: `--security-opt=no-new-privileges` prevents suid binary privilege elevation.
- **Wall-Time Limit**: Strict 10-second server-side timeout clamping. Client requests cannot exceed the server cap.
- **Output Buffering**: 256KB cap on combined stdout/stderr to prevent memory exhaustion and terminal buffer flooding.
- **Concurrency**: Global concurrency cap of 5 concurrent runs across all instances; single run per workspace mutual exclusion lock enforced via Redis.
- **User Rate Limit**: 10 runs per user per minute enforced via distributed Redis bucket counter with in-memory fallback.

---

### 4. Authentication & CSRF Protection

- **Cookies**: Session tokens (`syncspace_access`, `syncspace_refresh`) are stored in `HttpOnly; SameSite=Lax` cookies.
- **CSRF**: Double-submit cookie pattern (`syncspace_csrf` cookie + `X-CSRF-Token` header) mandatory for all state-mutating HTTP requests (POST, PUT, DELETE), including keepalive beacon flushes.
- **WebSocket Auth**: Connections authenticate via single-use, 10-second ephemeral tickets (`/api/ws-ticket`). Raw JWT tokens are forbidden in query strings and logs.
