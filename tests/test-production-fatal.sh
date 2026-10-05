#!/usr/bin/env bash
# Test: DEMO_BOT_PASSWORD production enforcement
# Starts the server with ENV=production and default/unset DEMO_BOT_PASSWORD
# Expects log.Fatal and non-zero exit code.

set -e

cd "$(dirname "$0")/../ws-server"

echo "═══════════════════════════════════════════════════════"
echo " Production Fatal Test: DEMO_BOT_PASSWORD enforcement"
echo "═══════════════════════════════════════════════════════"
echo ""

# Must have a built binary
if [ ! -f ./server ]; then
  echo "Building server..."
  go build -o server ./cmd/server/
fi

echo "── Test 1: ENV=production, DEMO_BOT_PASSWORD unset (default) ──"
echo "Expected: log.Fatal with non-zero exit"
echo ""

# Set up valid JWT_SECRET and EXEC_SERVICE_SECRET so only DEMO_BOT_PASSWORD triggers the fatal
ENV=production \
JWT_SECRET="this-is-a-very-strong-production-jwt-secret-key-12345" \
EXEC_SERVICE_SECRET="strong-exec-secret-key" \
DEMO_BOT_PASSWORD="" \
POSTGRES_HOST=localhost \
POSTGRES_PORT=5432 \
timeout 10 ./server 2>&1 || EXIT_CODE=$?

echo ""
echo "Exit code: ${EXIT_CODE:-0}"

if [ "${EXIT_CODE:-0}" -ne "0" ]; then
  echo "✅ Server REFUSED TO START in production with default DEMO_BOT_PASSWORD"
else
  echo "❌ Server started successfully — enforcement FAILED"
  exit 1
fi

echo ""
echo "── Test 2: ENV=production, DEMO_BOT_PASSWORD too short (5 chars) ──"
echo ""

ENV=production \
JWT_SECRET="this-is-a-very-strong-production-jwt-secret-key-12345" \
EXEC_SERVICE_SECRET="strong-exec-secret-key" \
DEMO_BOT_PASSWORD="short" \
POSTGRES_HOST=localhost \
POSTGRES_PORT=5432 \
timeout 10 ./server 2>&1 || EXIT_CODE2=$?

echo ""
echo "Exit code: ${EXIT_CODE2:-0}"

if [ "${EXIT_CODE2:-0}" -ne "0" ]; then
  echo "✅ Server REFUSED TO START with short DEMO_BOT_PASSWORD"
else
  echo "❌ Server started successfully — enforcement FAILED"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo " RESULT: Production enforcement CONFIRMED"
echo "═══════════════════════════════════════════════════════"
