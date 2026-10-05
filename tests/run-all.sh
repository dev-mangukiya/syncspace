#!/usr/bin/env bash
set -e

# ==============================================================================
# SyncSpace Complete Regression Test Suite Runner
# ==============================================================================
# Runs every automated test suite, captures raw per-suite results,
# and prints per-suite counts plus grand totals.
# PASS/FAIL is driven strictly by process exit codes.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

echo "═════════════════════════════════════════════════════════════════════════════════"
echo " SYNCPACE AUTOMATED REGRESSION RUNNER"
echo " Started at: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "═════════════════════════════════════════════════════════════════════════════════"
echo ""

SUITES=(
  "tests/test-cookie-auth.mjs"
  "tests/test-token-expiry.mjs"
  "tests/test-colorslot-stability.mjs"
  "tests/test-c3-members.mjs"
  "tests/test-c4-file-explorer.mjs"
  "tests/test-c4-verification.mjs"
  "tests/test-c5-multi-tab.mjs"
  "tests/test-c6-status-bar-palette.mjs"
  "tests/test-c6-verification-followup.mjs"
  "tests/test-c7-chat.mjs"
  "tests/test-c7-fixes.mjs"
  "tests/test-break-sandbox.mjs"
  "tests/test-timeout-clamp.mjs"
  "tests/test-seeding-race.mjs"
  "tests/test-seed-edge-cases.mjs"
  "tests/test-phase-d-e2e.mjs"
  "tests/test-three-state-demo.mjs"
  "tests/test-multi-instance.mjs"
  "tests/verify-crdt.mjs"
  "tests/verify-live-sync.mjs"
  "tests/verify-unload.mjs"
  "tests/verify-cursors.mjs"
  "tests/test-ai-plant-bug.mjs"
  "tests/test-demo-bot.mjs"
  "tests/test-simulate-offline.mjs"
)

TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0
FAILED_SUITES=()

TMP_LOG_DIR=$(mktemp -d /tmp/syncspace-run-all-XXXXXX)
trap 'rm -rf "${TMP_LOG_DIR}"' EXIT

printf "%-40s %-10s %-8s %-8s %-8s\n" "SUITE" "STATUS" "PASSED" "FAILED" "SKIPPED"
echo "─────────────────────────────────────────────────────────────────────────────────"

# 1. Run Go Unit Tests
GO_SERVICES=("ws-server" "exec-service")
for SVC in "${GO_SERVICES[@]}"; do
  SVC_NAME="go-test-${SVC}"
  SVC_LOG="${TMP_LOG_DIR}/${SVC_NAME}.log"
  PASSED=0
  FAILED=0
  SKIPPED=0

  if (cd "${ROOT_DIR}/${SVC}" && go test -v ./...) > "${SVC_LOG}" 2>&1; then
    STATUS="PASS"
    PASSED=$(grep -c -- "--- PASS:" "${SVC_LOG}" || true)
    [ "${PASSED}" -eq 0 ] && PASSED=1
  else
    STATUS="FAIL"
    FAILED=$(grep -c -- "--- FAIL:" "${SVC_LOG}" || true)
    [ "${FAILED}" -eq 0 ] && FAILED=1
    FAILED_SUITES+=("${SVC_NAME}")
  fi

  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

  STATUS_DISP="✅ PASS"
  if [ "${STATUS}" = "FAIL" ]; then
    STATUS_DISP="❌ FAIL"
  fi
  printf "%-40s %-12b %-8d %-8d %-8d\n" "${SVC_NAME}" "${STATUS_DISP}" "${PASSED}" "${FAILED}" "${SKIPPED}"
done

# 2. Run Node.js Test Suites
for SUITE in "${SUITES[@]}"; do
  SUITE_NAME=$(basename "${SUITE}")
  SUITE_LOG="${TMP_LOG_DIR}/${SUITE_NAME}.log"

  PASSED=0
  FAILED=0
  SKIPPED=0

  # Brief pause before AI/E2E suites to respect per-minute provider rate limits
  if [[ "${SUITE_NAME}" == *"ai"* || "${SUITE_NAME}" == *"demo"* || "${SUITE_NAME}" == *"phase-d"* ]]; then
    sleep 10
  fi

  # Execute suite and check process exit code
  if node "${SUITE}" > "${SUITE_LOG}" 2>&1; then
    EXIT_CODE=0
  else
    EXIT_CODE=$?
  fi

  # Parse counts (informational only)
  if grep -qi "RESULTS:.*passed" "${SUITE_LOG}"; then
    RES_LINE=$(grep -i "RESULTS:" "${SUITE_LOG}" | tail -n 1)
    PASSED=$(echo "${RES_LINE}" | grep -ioE '[0-9]+ passed' | head -n 1 | awk '{print $1}')
    FAILED=$(echo "${RES_LINE}" | grep -ioE '[0-9]+ failed' | head -n 1 | awk '{print $1}')
    SKIPPED=$(echo "${RES_LINE}" | grep -ioE '[0-9]+ skipped' | head -n 1 | awk '{print $1}')
    [ -z "${PASSED}" ] && PASSED=0
    [ -z "${FAILED}" ] && FAILED=0
    [ -z "${SKIPPED}" ] && SKIPPED=0
  elif grep -qi "BREAK THE SANDBOX" "${SUITE_LOG}"; then
    PASSED=$(grep -c "Result: PASS (Contained)" "${SUITE_LOG}" || true)
    FAILED=0
    SKIPPED=0
  elif grep -qi "CRDT CONVERGENCE VERIFICATION" "${SUITE_LOG}"; then
    PASSED=$(grep -c "✅ PASS" "${SUITE_LOG}" || true)
    FAILED=$(grep -c "❌ FAIL" "${SUITE_LOG}" || true)
    SKIPPED=$(grep -c "⏭️" "${SUITE_LOG}" || true)
  fi

  # Determine PASS / FAIL / SKIP strictly from process exit code
  if [ "${EXIT_CODE}" -ne 0 ]; then
    STATUS="FAIL"
    [ "${FAILED}" -eq 0 ] && FAILED=1
    FAILED_SUITES+=("${SUITE_NAME}")
  elif grep -qi "SKIPPED.*(standing rule" "${SUITE_LOG}" && [ "${PASSED}" -eq 0 ]; then
    STATUS="SKIP"
    SKIPPED=1
  else
    STATUS="PASS"
  fi

  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + SKIPPED))

  STATUS_DISP="${STATUS}"
  if [ "${STATUS}" = "PASS" ]; then
    STATUS_DISP="✅ PASS"
  elif [ "${STATUS}" = "SKIP" ]; then
    STATUS_DISP="⏭️  SKIP"
  else
    STATUS_DISP="❌ FAIL"
  fi

  printf "%-40s %-12b %-8d %-8d %-8d\n" "${SUITE_NAME}" "${STATUS_DISP}" "${PASSED}" "${FAILED}" "${SKIPPED}"
done

echo "─────────────────────────────────────────────────────────────────────────────────"
printf "%-40s %-12s %-8d %-8d %-8d\n" "TOTAL" "" "${TOTAL_PASSED}" "${TOTAL_FAILED}" "${TOTAL_SKIPPED}"
echo "═════════════════════════════════════════════════════════════════════════════════"

if [ ${#FAILED_SUITES[@]} -gt 0 ]; then
  echo ""
  echo "❌ REGRESSION DETECTED IN ${#FAILED_SUITES[@]} SUITE(S):"
  for F in "${FAILED_SUITES[@]}"; do
    echo "   - ${F}"
  done
  exit 1
else
  echo ""
  echo "✅ ALL SUITES PASSED (${TOTAL_PASSED} assertions passed, ${TOTAL_SKIPPED} skipped, 0 failed)"
  exit 0
fi
