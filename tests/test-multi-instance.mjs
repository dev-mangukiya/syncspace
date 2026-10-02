#!/usr/bin/env node
/**
 * Multi-Instance Distributed Limits Test
 * ──────────────────────────────────────
 * Starts a second ws-server instance on :8082 sharing Redis and Postgres.
 * Verifies:
 *   1. Cross-instance workspace run lock: Alice runs on :8080, Bob rejected on :8082 with 409 Conflict
 *   2. Cross-instance per-user rate limit: 10 runs/min distributed across :8080 and :8082
 *      (5 runs on :8080 + 5 runs on :8082 = 10; 11th run on :8082 returns 429 Too Many Requests)
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const INSTANCE1_URL = 'http://localhost:8080';
const INSTANCE2_URL = 'http://localhost:8082';

class CookieJar {
  constructor() { this.cookies = {}; }
  parseSetCookies(headers) {
    const raw = headers.getSetCookie?.() || [];
    for (const h of raw) {
      const [kv] = h.split(';');
      const [k, ...rest] = kv.split('=');
      const val = rest.join('=').trim();
      if (h.includes('Max-Age=0') || h.includes('Max-Age=-1')) {
        delete this.cookies[k.trim()];
      } else {
        this.cookies[k.trim()] = val;
      }
    }
  }
  get(name) { return this.cookies[name] || null; }
  toString() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function req(baseUrl, method, endpoint, body, jar, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (jar) headers['Cookie'] = jar.toString();
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (jar) jar.parseSetCookies(resp.headers);
  let data = null;
  const text = await resp.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

let passed = 0;
let failed = 0;

function assert(label, cond) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' MULTI-INSTANCE DISTRIBUTED LIMITS TEST (2 WS-SERVER INSTANCES)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Load JWT_SECRET from .env if present
  let jwtSecret = 'change-this-to-a-real-secret-in-production';
  try {
    const fs = await import('fs');
    if (fs.existsSync(path.join(ROOT_DIR, '.env'))) {
      const envContent = fs.readFileSync(path.join(ROOT_DIR, '.env'), 'utf8');
      const match = envContent.match(/^JWT_SECRET=(.*)$/m);
      if (match && match[1]) jwtSecret = match[1].trim();
    }
  } catch {}

  const binPath = '/tmp/ws-server-8082';
  const fs = await import('fs');
  if (!fs.existsSync(binPath)) {
    console.log('   Compiling ws-server binary for instance 2...');
    const { execSync } = await import('child_process');
    execSync(`go build -o ${binPath} ./cmd/server`, { cwd: path.join(ROOT_DIR, 'ws-server') });
  }

  const child = spawn(binPath, [], {
    cwd: path.join(ROOT_DIR, 'ws-server'),
    env: {
      ...process.env,
      PORT: '8082',
      JWT_SECRET: jwtSecret,
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: '5432',
      REDIS_URL: 'redis://localhost:6379',
      EXEC_SERVICE_URL: 'http://localhost:8081',
      EXEC_SERVICE_SECRET: 'syncspace_exec_secret_dev',
    },
    stdio: 'ignore',
  });

  // Cleanup child process on exit
  const cleanup = () => {
    try { child.kill('SIGTERM'); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

  // Wait for instance 2 to become healthy
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      const h = await fetch(`${INSTANCE2_URL}/health`);
      if (h.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  assert('Instance 2 is healthy on :8082', ready);

  const ts = Date.now();
  const jarAlice = new CookieJar();
  const jarBob = new CookieJar();

  // 2. Setup users and workspace on instance 1
  console.log('\n2. Setting up users and workspace...');
  const signupAlice = await req(INSTANCE1_URL, 'POST', '/api/auth/signup', {
    username: `multi_alice_${ts}`,
    email: `alice_${ts}@test.com`,
    password: 'Password123!',
  }, jarAlice);
  const csrfAlice = jarAlice.get('syncspace_csrf');

  const signupBob = await req(INSTANCE1_URL, 'POST', '/api/auth/signup', {
    username: `multi_bob_${ts}`,
    email: `bob_${ts}@test.com`,
    password: 'Password123!',
  }, jarBob);
  const csrfBob = jarBob.get('syncspace_csrf');

  const ws = await req(INSTANCE1_URL, 'POST', '/api/workspaces', {
    name: `Multi-Instance-WS-${ts}`,
    language: 'python',
    template: 'blank',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  const shortId = ws.data?.short_id;

  // Invite Bob as editor
  await req(INSTANCE1_URL, 'POST', `/api/workspaces/${shortId}/members`, {
    identifier: `bob_${ts}@test.com`,
    role: 'editor',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });

  // Create test file
  await req(INSTANCE1_URL, 'POST', `/api/workspaces/${shortId}/file`, {
    path: 'test.py',
    content: 'print("hello multi-instance")',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });

  // 3. Cross-Instance Mutual Exclusion Lock Test
  console.log('\n3. Testing Cross-Instance Workspace Lock (Redis mutex)...');
  // Alice runs a 3-second sleep script on Instance 1 (:8080)
  const aliceRunPromise = req(INSTANCE1_URL, 'POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'test.py',
    code: 'import time\ntime.sleep(3)\nprint("Alice done")',
    language: 'python',
    timeout_seconds: 5,
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });

  // Wait 400ms for Alice lock to register in Redis
  await new Promise(r => setTimeout(r, 400));

  // Bob attempts to run code in same workspace on Instance 2 (:8082)
  console.log('   Bob attempting concurrent run on Instance 2 (:8082)...');
  const bobRunAttempt = await req(INSTANCE2_URL, 'POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'test.py',
    code: 'print("Bob interrupt")',
    language: 'python',
  }, jarBob, { 'X-CSRF-Token': csrfBob });

  assert('Bob run on Instance 2 rejected with 409 Conflict', bobRunAttempt.status === 409);
  assert('409 Conflict indicates active runner across instances', bobRunAttempt.data?.error?.includes('running'));

  await aliceRunPromise;
  console.log('   Alice run on Instance 1 completed.');

  // Wait 500ms for lock release
  await new Promise(r => setTimeout(r, 500));

  // 4. Cross-Instance Per-User Rate Limit Test (10 runs / min)
  console.log('\n4. Testing Cross-Instance User Rate Limiting (10 runs/min in Redis)...');
  const rateUserJar = new CookieJar();
  await req(INSTANCE1_URL, 'POST', '/api/auth/signup', {
    username: `ratelimit_user_${ts}`,
    email: `ratelimit_${ts}@test.com`,
    password: 'Password123!',
  }, rateUserJar);
  const rateCsrf = rateUserJar.get('syncspace_csrf');

  const rateWs = await req(INSTANCE1_URL, 'POST', '/api/workspaces', {
    name: `RateLimit-WS-${ts}`,
    language: 'python',
    template: 'blank',
  }, rateUserJar, { 'X-CSRF-Token': rateCsrf });
  const rateShortId = rateWs.data.short_id;

  await req(INSTANCE1_URL, 'POST', `/api/workspaces/${rateShortId}/file`, {
    path: 'code.py',
    content: 'print(1)',
  }, rateUserJar, { 'X-CSRF-Token': rateCsrf });

  // Send 5 runs to Instance 1 (:8080)
  console.log('   Sending 5 fast runs to Instance 1 (:8080)...');
  for (let i = 1; i <= 5; i++) {
    const r = await req(INSTANCE1_URL, 'POST', `/api/workspaces/${rateShortId}/run`, {
      file_path: 'code.py',
      code: `print(${i})`,
      language: 'python',
    }, rateUserJar, { 'X-CSRF-Token': rateCsrf });
    if (r.status !== 200) {
      throw new Error(`Run ${i} on instance 1 failed: ${r.status} ${JSON.stringify(r.data)}`);
    }
  }
  assert('5 runs on Instance 1 succeeded (count: 5/10)', true);

  // Send 5 runs to Instance 2 (:8082)
  console.log('   Sending 5 fast runs to Instance 2 (:8082)...');
  for (let i = 6; i <= 10; i++) {
    const r = await req(INSTANCE2_URL, 'POST', `/api/workspaces/${rateShortId}/run`, {
      file_path: 'code.py',
      code: `print(${i})`,
      language: 'python',
    }, rateUserJar, { 'X-CSRF-Token': rateCsrf });
    if (r.status !== 200) {
      throw new Error(`Run ${i} on instance 2 failed: ${r.status} ${JSON.stringify(r.data)}`);
    }
  }
  assert('5 runs on Instance 2 succeeded (count: 10/10)', true);

  // Send 11th run to Instance 2 (:8082) -> MUST return 429
  console.log('   Sending 11th run to Instance 2 (:8082) — expecting 429...');
  const run11 = await req(INSTANCE2_URL, 'POST', `/api/workspaces/${rateShortId}/run`, {
    file_path: 'code.py',
    code: 'print(11)',
    language: 'python',
  }, rateUserJar, { 'X-CSRF-Token': rateCsrf });

  assert('11th run on Instance 2 returns 429 Too Many Requests', run11.status === 429);
  assert('Rate limit error mentions rate limit', run11.data?.error?.toLowerCase().includes('rate limit'));

  // 5. Cleanup
  cleanup();

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(` RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
