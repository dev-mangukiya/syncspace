#!/usr/bin/env bash
set -e

# ==============================================================================
# SyncSpace One-Command Startup Script
# ==============================================================================
# Builds and starts all SyncSpace services in Docker Compose:
#   - Postgres 16 (database)
#   - Redis 7 (pub/sub & locks)
#   - exec-service (ephemeral sandboxed Docker execution)
#   - ws-server (Go REST API + WebSocket CRDT relay)
#   - frontend (Next.js web IDE)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
  else
    echo "Warning: No .env found. Continuing with environment defaults."
  fi
fi

echo "Starting all SyncSpace services via Docker Compose..."
docker compose up --build -d

echo ""
echo "Waiting for services to become healthy..."
docker compose ps

echo ""
echo "SyncSpace is running:"
echo "  Frontend:     http://localhost:3000"
echo "  API & WS:     http://localhost:8080"
echo "  Exec Service: http://localhost:8081"
