#!/usr/bin/env bash
set -e

# ==============================================================================
# SyncSpace Complete Regression Test Suite Runner
# ==============================================================================
# Runs every automated test suite, captures raw per-suite results,
# and prints per-suite counts plus grand totals.
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
  "tests/test-phase-d-e2e.mjs"
  "tests/test-three-state-demo.mjs"
  "tests/test-ai-plant-bug.mjs"
  "tests/verify-crdt.mjs"
  "tests/verify-live-sync.mjs"
  "tests/verify-unload.mjs"
  "tests/verify-cursors.mjs"
)

TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0
FAILED_SUITES=()

TMP_LOG_DIR=$(mktemp -d /tmp/syncspace-run-all-XXXXXX)
trap 'rm -rf "${TMP_LOG_DIR}"' EXIT

printf "%-40s %-10s %-8s %-8s %-8s\n" "SUITE" "STATUS" "PASSED" "FAILED" "SKIPPED"
echo "─────────────────────────────────────────────────────────────────────────────────"

for SUITE in "${SUITES[@]}"; do
  SUITE_NAME=$(basename "${SUITE}")
  SUITE_LOG="${TMP_LOG_DIR}/${SUITE_NAME}.log"

  # Run suite and capture output
  STATUS="PASS"
  if node "${SUITE}" > "${SUITE_LOG}" 2>&1; then
    STATUS="PASS"
  else
    STATUS="FAIL"
    FAILED_SUITES+=("${SUITE_NAME}")
  fi

  # Extract counts from results line
  # Pattern matches: RESULTS: X passed, Y failed, Z skipped
  # or: X passed, Y failed
  # or: CONTAINED ✓ count
  PASSED=0
  FAILED=0
  SKIPPED=0

  if grep -qi "RESULTS:.*passed" "${SUITE_LOG}"; then
    RES_LINE=$(grep -i "RESULTS:" "${SUITE_LOG}" | tail -n 1)
    PASSED=$(echo "${RES_LINE}" | sed -n 's/.* \([0-9]*\) passed.*/\1/p')
    FAILED=$(echo "${RES_LINE}" | sed -n 's/.* \([0-9]*\) failed.*/\1/p')
    SKIPPED=$(echo "${RES_LINE}" | sed -n 's/.* \([0-9]*\) skipped.*/\1/p')
    [ -z "${PASSED}" ] && PASSED=0
    [ -z "${FAILED}" ] && FAILED=0
    [ -z "${SKIPPED}" ] && SKIPPED=0
  elif grep -qi "BREAK THE SANDBOX" "${SUITE_LOG}"; then
    # Break sandbox suite uses CONTAINED count
    PASSED=$(grep -c "Result: PASS (Contained)" "${SUITE_LOG}" || true)
    FAILED=0
    SKIPPED=0
  elif grep -qi "CRDT CONVERGENCE VERIFICATION" "${SUITE_LOG}"; then
    PASSED=$(grep -c "✅ PASS" "${SUITE_LOG}" || true)
    FAILED=$(grep -c "❌ FAIL" "${SUITE_LOG}" || true)
    SKIPPED=$(grep -c "⏭️" "${SUITE_LOG}" || true)
  fi

  # If failed but FAILED count was 0 (unexpected crash)
  if [ "${STATUS}" = "FAIL" ] && [ "${FAILED}" -eq 0 ]; then
    FAILED=1
  fi

  # If suite was entirely skipped
  if grep -qi "SKIPPED.*(standing rule" "${SUITE_LOG}" && [ "${PASSED}" -eq 0 ]; then
    STATUS="SKIP"
    SKIPPED=1
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
