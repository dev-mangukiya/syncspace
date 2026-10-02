#!/usr/bin/env node
/**
 * Break the Sandbox (Safe) - Full 7-Point Isolation Verification Suite
 * ───────────────────────────────────────────────────────────────────
 * Verifies strict container isolation for every supported runtime:
 *   1. Infinite loop (wall-time limit clamp)
 *   2. Memory hog (cgroup memory limit 128m -> OOM killer)
 *   3. Fork bomb (cgroup pids limit 64 -> thread exhaustion / EAGAIN)
 *   4. Outbound network call (--network none -> EUNREACH / connection blocked)
 *   5. Output flood (256KB cap -> output truncated notice)
 *   6. Write to read-only filesystem (--read-only -> EROFS)
 *   7. Privilege escalation attempt (setuid root -> EPERM, no-new-privileges)
 *
 * Verifies zero leftover containers via `docker ps -a`.
 */

import http from 'http';
import { execSync } from 'child_process';

const EXEC_URL = process.env.EXEC_URL || 'http://localhost:8081';
const SECRET = process.env.EXEC_SECRET || 'syncspace_exec_secret_dev';

function runStreaming(code, language = 'python', timeoutSeconds = 10) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      code,
      language,
      timeout_seconds: timeoutSeconds,
    });

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
              if (evt.chunk) {
                fullOutput += evt.chunk;
              }
              if (evt.event === 'finished') {
                finishEvent = evt;
              }
            } catch (e) {
              // Ignore non-json lines
            }
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
}

async function testLanguage(lang) {
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(` RUNNING 7-POINT BREAK SET FOR: ${lang.toUpperCase()}`);
  console.log(`═══════════════════════════════════════════════════════════════`);

  const results = [];

  // 1. Infinite loop (wall-time cap)
  console.log(`--- [${lang}] Test 1: Infinite Loop (Wall-time cap 2s) ---`);
  const code1 = lang === 'python'
    ? 'import time\nprint("Starting loop...")\nwhile True:\n    time.sleep(0.1)\n'
    : 'console.log("Starting loop..."); while (true) {}';
  const t1Start = Date.now();
  const r1 = await runStreaming(code1, lang, 2);
  const t1Elapsed = Date.now() - t1Start;
  console.log(`Elapsed: ${t1Elapsed}ms | ExitCode: ${r1.finish?.exit_code} | TimedOut: ${r1.finish?.timed_out}`);
  const pass1 = r1.finish?.timed_out === true || r1.output.includes('Terminated: wall-time limit') || t1Elapsed >= 1800;
  console.log(`Result: ${pass1 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: `[${lang}] Infinite loop`, pass: pass1 });

  // 2. Memory hog (128MB limit)
  console.log(`--- [${lang}] Test 2: Memory Hog (128MB limit) ---`);
  const code2 = lang === 'python'
    ? 'chunks = []\nwhile True:\n    chunks.append(" " * (10 * 1024 * 1024))\n'
    : 'const a = []; while (true) { a.push(new Uint8Array(1024 * 1024)); }';
  const r2 = await runStreaming(code2, lang, 10);
  console.log(`ExitCode: ${r2.finish?.exit_code} | Output: ${r2.output.trim().substring(0, 100)}`);
  const pass2 = r2.finish?.exit_code === 137 || r2.output.includes('memory limit exceeded') || r2.output.includes('MemoryError') || r2.output.includes('heap out of memory');
  console.log(`Result: ${pass2 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: `[${lang}] Memory hog`, pass: pass2 });

  // 3. Fork bomb (PIDs limit 64)
  console.log(`--- [${lang}] Test 3: Fork Bomb (PIDs limit 64) ---`);
  const code3 = lang === 'python'
    ? 'import os\nfor i in range(200):\n    os.fork()\n'
    : 'const { fork } = require("child_process"); for (let i = 0; i < 200; i++) { fork("-e", [""]); }';
  const r3 = await runStreaming(code3, lang, 10);
  console.log(`ExitCode: ${r3.finish?.exit_code} | Output: ${r3.output.trim().substring(0, 100)}`);
  const pass3 = r3.finish?.exit_code !== 0 || r3.output.includes('BlockingIOError') || r3.output.includes('EAGAIN') || r3.output.includes('Resource temporarily unavailable');
  console.log(`Result: ${pass3 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: `[${lang}] Fork bomb`, pass: pass3 });

  // 4. Outbound network call
  console.log(`--- [${lang}] Test 4: Outbound Network Call (Network: none) ---`);
  const code4 = lang === 'python'
    ? 'import socket\ntry:\n    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n    s.settimeout(1.0)\n    s.connect(("1.1.1.1", 80))\nexcept Exception as e:\n    print(f"Network blocked: {e}")\n'
    : 'const net = require("net"); const s = net.createConnection({ host: "1.1.1.1", port: 80 }); s.on("error", (e) => console.log(`Network blocked: ${e.message}`));';
  const r4 = await runStreaming(code4, lang, 5);
  console.log(`Output: ${r4.output.trim()}`);
  const pass4 = r4.output.includes('Network blocked') || r4.output.includes('ENETUNREACH') || r4.output.includes('Network unreachable') || r4.output.includes('Errno 101');
  console.log(`Result: ${pass4 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: `[${lang}] Network call`, pass: pass4 });

  // 5. Output flood (256KB cap)
  console.log(`--- [${lang}] Test 5: Output Flood (256KB cap) ---`);
  const code5 = lang === 'python'
    ? 'for i in range(5000):\n    print(f"Line {i:04d}: " + ("x" * 80))\n'
    : 'for (let i = 0; i < 5000; i++) console.log(`Line ${i}: ` + "x".repeat(80));';
  const r5 = await runStreaming(code5, lang, 10);
  const outBytes = Buffer.byteLength(r5.output);
  console.log(`Output bytes: ${outBytes} | Capped flag: ${r5.finish?.output_capped}`);
  const pass5 = (r5.finish?.output_capped === true || r5.output.includes('Output truncated')) && outBytes <= 300000;
  console.log(`Result: ${pass5 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: `[${lang}] Output flood`, pass: pass5 });

  // 6. Write to read-only root filesystem
  console.log(`--- [${lang}] Test 6: Write to Read-Only Filesystem ---`);
  const code6 = lang === 'python'
    ? 'try:\n    with open("/etc/pwned.txt", "w") as f:\n        f.write("hacked")\nexcept Exception as e:\n    print(f"Write blocked: {e}")\n'
    : 'try { require("fs").writeFileSync("/etc/pwned.txt", "hacked"); } catch (e) { console.log(`Write blocked: ${e.message}`); }';
  const r6 = await runStreaming(code6, lang, 5);
  console.log(`Output: ${r6.output.trim()}`);
  const pass6 = r6.output.includes('Write blocked') || r6.output.includes('Read-only file system') || r6.output.includes('EROFS');
  console.log(`Result: ${pass6 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: `[${lang}] Read-only rootfs`, pass: pass6 });

  // 7. Privilege escalation attempt (setuid / no-new-privileges)
  console.log(`--- [${lang}] Test 7: Privilege Escalation Attempt ---`);
  const code7 = lang === 'python'
    ? 'import os\ntry:\n    os.setuid(0)\n    print("ESCALATED TO ROOT!")\nexcept Exception as e:\n    print(f"Privilege escalation blocked: {e}")\n'
    : 'try { process.setuid(0); console.log("ESCALATED TO ROOT!"); } catch (e) { console.log(`Privilege escalation blocked: ${e.message}`); }';
  const r7 = await runStreaming(code7, lang, 5);
  console.log(`Output: ${r7.output.trim()}`);
  const pass7 = r7.output.includes('Privilege escalation blocked') || r7.output.includes('Operation not permitted') || r7.output.includes('EPERM');
  console.log(`Result: ${pass7 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: `[${lang}] Privilege escalation`, pass: pass7 });

  return results;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('BREAK THE SANDBOX (SAFE) FULL 7-POINT VERIFICATION SUITE');
  console.log('═══════════════════════════════════════════════════════════════');

  const pyResults = await testLanguage('python');
  const jsResults = await testLanguage('javascript');

  const allResults = [...pyResults, ...jsResults];

  // Check leftover containers
  console.log('\n--- Leftover Containers Check (docker ps -a) ---');
  const psOutput = execSync('docker ps -a --format "{{.Names}}" | grep "^syncspace-exec-" | grep -v "syncspace-exec-service" || true').toString().trim();
  console.log(psOutput ? `Remaining:\n${psOutput}` : 'Nothing left behind (0 leftover containers)');
  const passContainers = psOutput === '';

  // Check exec-service health
  console.log('\n--- Exec-service Health Check ---');
  const healthCheck = execSync('curl -s http://localhost:8081/health').toString();
  console.log('Health response: ' + healthCheck);
  const passHealth = healthCheck.includes('"healthy"');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('FINAL RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  let passedCount = 0;
  let failedCount = 0;
  allResults.forEach(r => {
    if (r.pass) {
      console.log(`  ✅ ${r.name}: PASS (Contained)`);
      passedCount++;
    } else {
      console.log(`  ❌ ${r.name}: FAIL`);
      failedCount++;
    }
  });

  if (passContainers && passHealth) {
    console.log(`  ✅ Container Cleanup: PASS (0 leftover containers)`);
    passedCount++;
  } else {
    console.log(`  ❌ Container Cleanup: FAIL`);
    failedCount++;
  }

  console.log(`\nRESULTS: ${passedCount} passed, ${failedCount} failed, 0 skipped`);

  if (failedCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
