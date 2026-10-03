#!/usr/bin/env node
/**
 * Test Suite: Seed Lock Edge Cases & Ungraceful Disconnect Persistence
 * ────────────────────────────────────────────────────────────────────
 * Tests:
 *   5a: Seeder crash mid-seed: Client A acquires seed lock, terminates abruptly
 *       before sending any content. Measure time until waiting Client B is elected.
 *       Verifies waiting client is NOT stuck for 30s (instant re-election).
 *   5b: Last client disconnect without clean close: Single client in room makes
 *       an edit and experiences an abrupt network drop (socket terminate, no beforeunload).
 *       Verifies server forces flush to Postgres before evicting room & releasing seed lock.
 *   5c: Cross-instance seed lock: Two clients connect simultaneously across
 *       two different ws-server instances (:8080 and :8082) sharing Redis.
 *       Verifies only ONE client receives seed_grant across instances.
 */

import WebSocket from 'ws';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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

async function signupUser(baseUrl, prefix) {
  const jar = new CookieJar();
  const rand = Math.random().toString(36).slice(2, 7);
  const email = `${prefix}_${Date.now()}_${rand}@example.com`;
  const username = `${prefix}_${rand}`;
  const password = 'TestPassword123!';
  const res = await req(baseUrl, 'POST', '/api/auth/signup', { email, username, password }, jar);
  if (res.status !== 201) throw new Error(`Signup failed (${res.status}): ${JSON.stringify(res.data)}`);
  return { jar, user: res.data.user };
}

async function getWSTicket(baseUrl, jar) {
  const csrf = jar.get('syncspace_csrf') || '';
  const res = await req(baseUrl, 'POST', '/api/ws-ticket', {}, jar, { 'X-CSRF-Token': csrf });
  if (res.status !== 200 || !res.data.ticket) throw new Error(`Failed to get WS ticket: ${JSON.stringify(res.data)}`);
  return res.data.ticket;
}

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function test5a_SeederCrashMidSeed() {
  console.log('\n─────────────────────────────────────────────────────────────────');
  console.log(' TEST 5a: SEEDER CRASH MID-SEED (MEASURE TIME STUCK)');
  console.log('─────────────────────────────────────────────────────────────────');

  const { jar: jarA, user: userA } = await signupUser(INSTANCE1_URL, 'alice5a');
  const { jar: jarB, user: userB } = await signupUser(INSTANCE1_URL, 'bob5a');

  // Create workspace and file
  const wsRes = await req(INSTANCE1_URL, 'POST', '/api/workspaces', {
    name: 'Seeder Crash WS',
    template: 'blank',
  }, jarA, { 'X-CSRF-Token': jarA.get('syncspace_csrf') });
  const slug = wsRes.data.slug;

  const fileRes = await req(INSTANCE1_URL, 'POST', `/api/workspaces/${slug}/file`, {
    path: 'crash_test.py',
    content: 'INITIAL_DB_CONTENT = 1\n',
  }, jarA, { 'X-CSRF-Token': jarA.get('syncspace_csrf') });

  // Invite Bob to workspace so he can access the WebSocket
  await req(INSTANCE1_URL, 'POST', `/api/workspaces/${slug}/members`, {
    identifier: userB.username,
    role: 'editor',
  }, jarA, { 'X-CSRF-Token': jarA.get('syncspace_csrf') });

  // Connect Client A (Instance 1)
  const ticketA = await getWSTicket(INSTANCE1_URL, jarA);
  const wsA = new WebSocket(`ws://localhost:8080/ws/${slug}/crash_test.py?ticket=${ticketA}`);

  let clientAGotGrant = false;
  await new Promise((resolve, reject) => {
    wsA.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'seed_grant') {
          clientAGotGrant = true;
          resolve();
        }
      } catch {}
    });
    wsA.on('error', reject);
    setTimeout(() => resolve(), 3000);
  });
  assert('Client A acquired seed_grant', clientAGotGrant);

  // Connect Client B (Instance 1) while Client A holds the lock
  const ticketB = await getWSTicket(INSTANCE1_URL, jarB);
  const wsB = new WebSocket(`ws://localhost:8080/ws/${slug}/crash_test.py?ticket=${ticketB}`);
  wsB.on('error', (err) => console.log('   wsB warning:', err.message));
  await new Promise((resolve) => wsB.on('open', resolve));

  let clientBGotGrantInitial = false;
  let clientBReElectionTime = null;
  const grantPromiseB = new Promise((resolve) => {
    wsB.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'seed_grant') {
          if (!clientBReElectionTime) {
            clientBReElectionTime = performance.now();
          }
          resolve();
        }
      } catch {}
    });
  });

  // Wait 200ms to verify Client B is in passive wait mode
  await new Promise(r => setTimeout(r, 200));
  assert('Client B does NOT receive seed_grant initially while A is alive', !clientBReElectionTime);

  // SIMULATE SEEDER CRASH: terminate Client A socket abruptly without sending content
  console.log('   Killing Client A abruptly (socket.terminate)...');
  const crashTime = performance.now();
  wsA.terminate(); // Hard drop, no graceful WebSocket close handshake

  // Wait for Client B to be promoted to seeder
  await Promise.race([
    grantPromiseB,
    new Promise(r => setTimeout(r, 4000))
  ]);

  const elapsed = clientBReElectionTime ? Math.round(clientBReElectionTime - crashTime) : 99999;
  console.log(`   Time until Client B received seed_grant: ${elapsed}ms`);

  assert('Client B received seed_grant after Client A crash', clientBReElectionTime !== null);
  assert(`Client B re-elected swiftly (${elapsed}ms <= 2000ms, not stuck for 30s)`, elapsed <= 2000);

  wsB.close();
}

async function test5b_UngracefulDisconnectFlush() {
  console.log('\n─────────────────────────────────────────────────────────────────');
  console.log(' TEST 5b: LAST-CLIENT UNGRACEFUL DISCONNECT FORCED FLUSH');
  console.log('─────────────────────────────────────────────────────────────────');

  const { jar, user } = await signupUser(INSTANCE1_URL, 'alice5b');

  // Create workspace and file with initial content
  const wsRes = await req(INSTANCE1_URL, 'POST', '/api/workspaces', {
    name: 'Flush Test WS',
    template: 'blank',
  }, jar, { 'X-CSRF-Token': jar.get('syncspace_csrf') });
  const slug = wsRes.data.slug;

  await req(INSTANCE1_URL, 'POST', `/api/workspaces/${slug}/file`, {
    path: 'flush_test.py',
    content: 'ORIGINAL_UNEDITED_CONTENT\n',
  }, jar, { 'X-CSRF-Token': jar.get('syncspace_csrf') });

  // Connect single client to room
  const ticket = await getWSTicket(INSTANCE1_URL, jar);
  const ws = new WebSocket(`ws://localhost:8080/ws/${slug}/flush_test.py?ticket=${ticket}`);

  await new Promise((resolve) => ws.on('open', resolve));

  // Client makes an edit and sends content_snapshot frame over WebSocket
  const editedContent = 'CRITICAL_USER_EDIT_SAVED_BEFORE_CRASH = 42\nprint("SUCCESS")\n';
  console.log('   Sending content_snapshot over WebSocket...');
  ws.send(JSON.stringify({
    type: 'content_snapshot',
    content: editedContent
  }));

  // Wait 100ms for ws-server to process the text frame into memory
  await new Promise(r => setTimeout(r, 100));

  // SIMULATE UNGRACEFUL NETWORK DROP: socket terminate (no beforeunload HTTP beacon)
  console.log('   Simulating sudden network drop / crash (ws.terminate)...');
  ws.terminate();

  // Wait 500ms for server-side unregister handler to execute DB flush
  await new Promise(r => setTimeout(r, 500));

  // Query database via REST API to verify content was persisted
  const getFileRes = await req(INSTANCE1_URL, 'GET', `/api/workspaces/${slug}/files`, null, jar);
  const files = Array.isArray(getFileRes.data) ? getFileRes.data : [];
  const targetFile = files.find(f => f.path === 'flush_test.py');

  console.log(`   Persisted file content in DB:\n   ${JSON.stringify(targetFile?.content)}`);
  assert('File content in Postgres reflects the edit after ungraceful drop', targetFile?.content === editedContent);
}

async function test5c_CrossInstanceSeedLock(childProcess) {
  console.log('\n─────────────────────────────────────────────────────────────────');
  console.log(' TEST 5c: CROSS-INSTANCE SEED LOCK CONCURRENCY (:8080 & :8082)');
  console.log('─────────────────────────────────────────────────────────────────');

  const { jar: jar1, user: user1 } = await signupUser(INSTANCE1_URL, 'inst1_user');
  const { jar: jar2, user: user2 } = await signupUser(INSTANCE1_URL, 'inst2_user');

  // Create workspace and file
  const wsRes = await req(INSTANCE1_URL, 'POST', '/api/workspaces', {
    name: 'Cross Inst WS',
    template: 'blank',
  }, jar1, { 'X-CSRF-Token': jar1.get('syncspace_csrf') });
  const slug = wsRes.data.slug;

  await req(INSTANCE1_URL, 'POST', `/api/workspaces/${slug}/file`, {
    path: 'cross.py',
    content: 'X = 100\n',
  }, jar1, { 'X-CSRF-Token': jar1.get('syncspace_csrf') });

  // Invite User 2 to workspace
  await req(INSTANCE1_URL, 'POST', `/api/workspaces/${slug}/members`, {
    identifier: user2.username,
    role: 'editor',
  }, jar1, { 'X-CSRF-Token': jar1.get('syncspace_csrf') });

  // Get tickets from both instances
  const ticket1 = await getWSTicket(INSTANCE1_URL, jar1);
  const ticket2 = await getWSTicket(INSTANCE2_URL, jar2);

  let grant1 = false;
  let grant2 = false;

  console.log('   Connecting Client 1 to :8080 and Client 2 to :8082 simultaneously...');
  const ws1 = new WebSocket(`ws://localhost:8080/ws/${slug}/cross.py?ticket=${ticket1}`);
  const ws2 = new WebSocket(`ws://localhost:8082/ws/${slug}/cross.py?ticket=${ticket2}`);

  const p1 = new Promise((resolve) => {
    ws1.on('message', (msg) => {
      try {
        const p = JSON.parse(msg.toString());
        if (p.type === 'seed_grant') grant1 = true;
      } catch {}
    });
    ws1.on('open', () => setTimeout(resolve, 800));
  });

  const p2 = new Promise((resolve) => {
    ws2.on('message', (msg) => {
      try {
        const p = JSON.parse(msg.toString());
        if (p.type === 'seed_grant') grant2 = true;
      } catch {}
    });
    ws2.on('open', () => setTimeout(resolve, 800));
  });

  await Promise.all([p1, p2]);

  console.log(`   Grant received by Instance 1 client: ${grant1}`);
  console.log(`   Grant received by Instance 2 client: ${grant2}`);

  const totalGrants = (grant1 ? 1 : 0) + (grant2 ? 1 : 0);
  assert('Exactly one client received seed_grant across the two instances', totalGrants === 1);

  ws1.close();
  ws2.close();
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' SEED LOCK EDGE CASES & UNGRACEFUL DISCONNECT VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════════');

  // Start instance 2 on :8082 for 5c
  console.log('   Launching ws-server instance 2 on port 8082...');
  let jwtSecret = 'change-this-to-a-real-secret-in-production';
  try {
    const envContent = fs.readFileSync(path.join(ROOT_DIR, '.env'), 'utf8');
    const match = envContent.match(/^JWT_SECRET=(.*)$/m);
    if (match && match[1]) jwtSecret = match[1].trim();
  } catch {}

  const binPath = '/tmp/ws-server-8082';
  const { execSync } = await import('child_process');
  execSync(`go build -o ${binPath} ./cmd/server`, { cwd: path.join(ROOT_DIR, 'ws-server') });

  const child = spawn(binPath, [], {
    cwd: path.join(ROOT_DIR, 'ws-server'),
    env: {
      ...process.env,
      PORT: '8082',
      JWT_SECRET: jwtSecret,
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'syncspace',
      POSTGRES_PASSWORD: 'syncspace_dev',
      POSTGRES_DB: 'syncspace',
      REDIS_URL: 'redis://localhost:6379',
      EXEC_SERVICE_URL: 'http://localhost:8081',
      EXEC_SERVICE_SECRET: 'syncspace_exec_secret_dev',
      MIGRATIONS_DIR: path.join(ROOT_DIR, 'ws-server', 'migrations'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => console.error('[Instance 2 stderr]:', d.toString()));

  // Wait for :8082 health
  for (let i = 0; i < 30; i++) {
    try {
      const h = await fetch('http://localhost:8082/health');
      if (h.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  try {
    await test5a_SeederCrashMidSeed();
    await test5b_UngracefulDisconnectFlush();
    await test5c_CrossInstanceSeedLock(child);
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed, 0 skipped`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
