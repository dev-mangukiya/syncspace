#!/usr/bin/env node
/**
 * ColorSlot Stability Test
 * 
 * Proves slots are persisted at invite time and NOT recomputed on read.
 * The exact bug being caught: ROW_NUMBER() shifts all slots when a middle member is removed.
 * 
 * Setup:  Alice(0), Bob(1), Carol(2)
 * Remove: Bob
 * Assert: Carol still has slot 2 (not 1)
 */

const BASE = 'http://localhost:3000';

class CookieJar {
  constructor() { this.cookies = {}; }
  parseSetCookies(headers) {
    const setCookies = headers.getSetCookie?.() || [];
    for (const sc of setCookies) {
      const [nameVal] = sc.split(';');
      const [name, ...valParts] = nameVal.split('=');
      const value = valParts.join('=');
      if (sc.includes('Max-Age=0') || sc.includes('Max-Age=-1')) {
        delete this.cookies[name.trim()];
      } else {
        this.cookies[name.trim()] = value;
      }
    }
  }
  toString() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  get(name) { return this.cookies[name] || null; }
}

async function req(method, path, body, jar, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (jar) headers['Cookie'] = jar.toString();
  const resp = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  if (jar) jar.parseSetCookies(resp.headers);
  let data = null;
  const text = await resp.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

async function run() {
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  
  console.log('═══════════════════════════════════════');
  console.log('ColorSlot Stability Test (3 members)');
  console.log('═══════════════════════════════════════\n');

  // Create 3 users
  console.log('1. CREATE 3 USERS');
  const jarA = new CookieJar();
  await req('POST', '/api/auth/signup', {
    username: `alice_${ts}`, email: `alice_${ts}@test.com`, password: 'test12345'
  }, jarA);
  const csrfA = jarA.get('syncspace_csrf');

  const jarB = new CookieJar();
  const userB = await req('POST', '/api/auth/signup', {
    username: `bob_${ts}`, email: `bob_${ts}@test.com`, password: 'test12345'
  }, jarB);

  const jarC = new CookieJar();
  const userC = await req('POST', '/api/auth/signup', {
    username: `carol_${ts}`, email: `carol_${ts}@test.com`, password: 'test12345'
  }, jarC);

  assert('Alice created', !!csrfA);
  assert('Bob created', userB.status === 201);
  assert('Carol created', userC.status === 201);
  console.log();

  // Create workspace
  console.log('2. CREATE WORKSPACE + INVITE BOB + INVITE CAROL');
  const ws = await req('POST', '/api/workspaces', { name: `slots-${ts}` }, jarA, {
    'X-CSRF-Token': csrfA,
  });
  const sid = ws.data.short_id;
  assert('Workspace created', ws.status === 201);

  // Invite Bob (should get slot 1)
  await req('POST', `/api/workspaces/${sid}/members`, {
    identifier: `bob_${ts}`, role: 'editor',
  }, jarA, { 'X-CSRF-Token': csrfA });

  // Invite Carol (should get slot 2)
  await req('POST', `/api/workspaces/${sid}/members`, {
    identifier: `carol_${ts}`, role: 'editor',
  }, jarA, { 'X-CSRF-Token': csrfA });

  // Verify initial slots
  const members1 = await req('GET', `/api/workspaces/${sid}/members`, null, jarA);
  assert('3 members total', members1.data?.length === 3);
  
  const findSlot = (data, username) => data.find(m => m.username === username)?.color_slot;
  
  assert('Alice = slot 0', findSlot(members1.data, `alice_${ts}`) === 0);
  assert('Bob = slot 1', findSlot(members1.data, `bob_${ts}`) === 1);
  assert('Carol = slot 2', findSlot(members1.data, `carol_${ts}`) === 2);
  console.log();

  // ─── THE CRITICAL TEST: remove Bob, verify Carol's slot is UNCHANGED ───
  console.log('3. REMOVE BOB → CAROL SLOT MUST NOT SHIFT');
  await req('DELETE', `/api/workspaces/${sid}/members/${userB.data.user.id}`, null, jarA, {
    'X-CSRF-Token': csrfA,
  });

  const members2 = await req('GET', `/api/workspaces/${sid}/members`, null, jarA);
  assert('2 members remain', members2.data?.length === 2);
  assert('Alice still slot 0', findSlot(members2.data, `alice_${ts}`) === 0);
  assert('Carol still slot 2 (NOT 1)', findSlot(members2.data, `carol_${ts}`) === 2);
  console.log();

  // ─── Bonus: re-invite Bob — should get slot 3 (not reuse 1) ───
  console.log('4. RE-INVITE BOB → GETS NEW SLOT (not reused)');
  await req('POST', `/api/workspaces/${sid}/members`, {
    identifier: `bob_${ts}`, role: 'editor',
  }, jarA, { 'X-CSRF-Token': csrfA });

  const members3 = await req('GET', `/api/workspaces/${sid}/members`, null, jarA);
  assert('3 members again', members3.data?.length === 3);
  assert('Alice still slot 0', findSlot(members3.data, `alice_${ts}`) === 0);
  assert('Carol still slot 2', findSlot(members3.data, `carol_${ts}`) === 2);
  assert('Bob re-invited gets slot 3 (max+1)', findSlot(members3.data, `bob_${ts}`) === 3);
  console.log();

  console.log('═══════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
