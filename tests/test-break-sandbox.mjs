// tests/test-break-sandbox.mjs
// Verifies all 5 "Break the sandbox (safe)" scenarios:
// 1. Infinite loop (wall-time limit)
// 2. Memory hog (cgroup memory limit)
// 3. Fork bomb (cgroup pids limit)
// 4. Outbound network call (network none)
// 5. Output flood (256KB output cap)

import http from 'http';
import { execSync } from 'child_process';

const EXEC_URL = 'http://localhost:8081';
const SECRET = 'syncspace_exec_secret_dev';

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

async function runAll() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('BREAK THE SANDBOX (SAFE) VERIFICATION SUITE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results = [];

  // 1. Infinite Loop
  console.log('--- Test 1: Infinite Loop (Wall-time cap) ---');
  const code1 = `
import time
print("Starting infinite loop...")
while True:
    time.sleep(0.1)
`;
  const t1Start = Date.now();
  // Using 3s timeout for quick verification of the wall-time cap mechanism
  const r1 = await runStreaming(code1, 'python', 3);
  const t1Elapsed = Date.now() - t1Start;
  console.log('Output:\n' + r1.output.trim());
  console.log(`Elapsed: ${t1Elapsed}ms | ExitCode: ${r1.finish?.exit_code} | TimedOut: ${r1.finish?.timed_out}`);
  const pass1 = r1.output.includes('Terminated: wall-time limit') || r1.finish?.timed_out === true;
  console.log(`Result: ${pass1 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: 'Infinite loop', pass: pass1 });

  // 2. Memory Hog
  console.log('--- Test 2: Memory Hog (128MB limit) ---');
  const code2 = `
print("Allocating memory rapidly...")
chunks = []
try:
    while True:
        chunks.append(" " * (10 * 1024 * 1024))
except MemoryError as e:
    print(f"MemoryError caught: {e}")
`;
  const r2 = await runStreaming(code2, 'python', 10);
  console.log('Output:\n' + r2.output.trim());
  console.log(`ExitCode: ${r2.finish?.exit_code}`);
  const pass2 = r2.output.includes('memory limit exceeded') || r2.finish?.exit_code === 137 || r2.output.includes('MemoryError');
  console.log(`Result: ${pass2 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: 'Memory hog', pass: pass2 });

  // 3. Fork Bomb
  console.log('--- Test 3: Fork Bomb (PIDs limit 64) ---');
  const code3 = `
import os
print("Forking processes...")
try:
    for i in range(200):
        os.fork()
except BlockingIOError as e:
    print(f"Contained by pids limit: {e}")
except OSError as e:
    print(f"Contained by pids limit: {e}")
`;
  const r3 = await runStreaming(code3, 'python', 10);
  console.log('Output:\n' + r3.output.trim());
  console.log(`ExitCode: ${r3.finish?.exit_code}`);
  const pass3 = r3.output.includes('Contained by pids limit') || r3.finish?.exit_code !== 0;
  console.log(`Result: ${pass3 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: 'Fork bomb', pass: pass3 });

  // 4. Outbound Network Call
  console.log('--- Test 4: Outbound Network Call (Network: none) ---');
  const code4 = `
import urllib.request
print("Attempting outbound connection to http://example.com...")
try:
    urllib.request.urlopen("http://example.com", timeout=2)
except Exception as e:
    print(f"Blocked: no network access ({e})")
`;
  const r4 = await runStreaming(code4, 'python', 10);
  console.log('Output:\n' + r4.output.trim());
  console.log(`ExitCode: ${r4.finish?.exit_code}`);
  const pass4 = r4.output.includes('Blocked: no network access');
  console.log(`Result: ${pass4 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: 'Network call', pass: pass4 });

  // 5. Output Flood
  console.log('--- Test 5: Output Flood (256KB cap) ---');
  const code5 = `
print("Flooding output...")
for i in range(5000):
    print(f"Line {i:04d}: " + ("x" * 80))
print("Flood loop finished")
`;
  const r5 = await runStreaming(code5, 'python', 10);
  const outBytes = Buffer.byteLength(r5.output);
  console.log(`Received output bytes: ${outBytes}`);
  console.log(`Output capped flag: ${r5.finish?.output_capped}`);
  const hasTruncatedNotice = r5.output.includes('Output truncated') || r5.finish?.output_capped;
  console.log(`Contains truncation notice: ${hasTruncatedNotice}`);
  const pass5 = hasTruncatedNotice && outBytes <= 270000;
  console.log(`Result: ${pass5 ? 'PASS (Contained)' : 'FAIL'}\n`);
  results.push({ name: 'Output flood', pass: pass5 });

  // Check leftover containers
  console.log('--- Leftover Containers Check (docker ps -a) ---');
  const psOutput = execSync('docker ps -a --filter "name=syncspace-exec" --format "{{.ID}} {{.Names}} {{.Status}}"').toString().trim();
  console.log(psOutput ? `Remaining:\n${psOutput}` : 'Nothing left behind (0 leftover containers)');
  const passContainers = psOutput === '';

  // Check exec-service health
  console.log('\n--- Host and exec-service health check ---');
  const healthCheck = execSync('curl -s http://localhost:8081/health').toString();
  console.log('Health response: ' + healthCheck);
  const passHealth = healthCheck.includes('"healthy"');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  results.forEach(r => console.log(`  ${r.name}: ${r.pass ? 'CONTAINED ✓' : 'FAILED ✗'}`));
  console.log(`  Zero leftover containers: ${passContainers ? 'CONFIRMED ✓' : 'FAILED ✗'}`);
  console.log(`  Exec-service healthy: ${passHealth ? 'CONFIRMED ✓' : 'FAILED ✗'}`);
}

runAll().catch(console.error);
