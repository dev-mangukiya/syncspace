#!/usr/bin/env node
/**
 * Test Server Timeout Clamping
 * ────────────────────────────
 * Verifies that a client request with timeout=99s is clamped to 10s by the server.
 *
 * Measures:
 *   - Send infinite loop code with timeout_seconds: 99
 *   - Assert completion time is ~10s (between 9.5s and 12s), NOT 99s.
 *   - Assert finish event contains timed_out: true
 */

import http from 'http';

const EXEC_URL = process.env.EXEC_URL || 'http://localhost:8081';
const SECRET = process.env.EXEC_SECRET || 'syncspace_exec_secret_dev';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' TEST TIMEOUT CLAMPING (REQUEST 99s -> CLAMPED TO 10s)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const postData = JSON.stringify({
    code: 'import time\nprint("Loop started")\nwhile True:\n    time.sleep(0.1)\n',
    language: 'python',
    timeout_seconds: 99, // Explicit request for 99s
  });

  console.log('Sending execution request with timeout_seconds: 99...');
  const start = Date.now();

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      `${EXEC_URL}/api/exec/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Exec-Secret': SECRET,
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let fullOutput = '';
        let finishEvent = null;

        res.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.chunk) fullOutput += evt.chunk;
              if (evt.event === 'finished') finishEvent = evt;
            } catch (e) {}
          }
        });

        res.on('end', () => {
          resolve({ output: fullOutput, finish: finishEvent, statusCode: res.statusCode });
        });
      }
    );

    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  const elapsedMs = Date.now() - start;
  const elapsedSec = (elapsedMs / 1000).toFixed(2);
  console.log(`\nExecution completed:`);
  console.log(`  Elapsed time: ${elapsedSec}s (${elapsedMs}ms)`);
  console.log(`  Exit code: ${result.finish?.exit_code}`);
  console.log(`  Timed out flag: ${result.finish?.timed_out}`);
  console.log(`  Output summary: ${result.output.trim()}`);

  // Assert elapsed time is clamped to ~10s (between 9.5s and 12s), NOT 99s
  const isClamped = elapsedMs >= 9500 && elapsedMs <= 12500;
  const isNot99s = elapsedMs < 20000;
  const isTimedOut = result.finish?.timed_out === true || result.output.includes('wall-time limit');

  if (isClamped && isNot99s && isTimedOut) {
    console.log(`\n✅ PASS — 99s request was successfully clamped to 10s (elapsed ${elapsedSec}s)`);
    console.log(' RESULTS: 1 passed, 0 failed, 0 skipped\n');
    process.exit(0);
  } else {
    console.log(`\n❌ FAIL — Request was not properly clamped (elapsed ${elapsedSec}s)`);
    console.log(' RESULTS: 0 passed, 1 failed, 0 skipped\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
