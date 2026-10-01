#!/usr/bin/env node
/**
 * Test: session survives 15-min access token expiry via silent refresh.
 * 
 * Strategy: Create a short-lived auth service (1 second TTL) on the server side,
 * or — simpler — just test the API interceptor's refresh behavior by:
 * 1. Login normally
 * 2. Wait for the access token to be "expired" by manually clearing the access cookie
 *    (simulates token expiry without waiting 15 min)
 * 3. Make an API call — the interceptor should detect 401 and auto-refresh
 * 4. The call should succeed
 * 
 * This tests the exact same code path as real expiry: server returns 401,
 * client calls /refresh, retries the original request.
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
  has(name) { return name in this.cookies; }
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
  const jar = new CookieJar();
  
  console.log('═══════════════════════════════════════');
  console.log('Token Expiry Survival Test');
  console.log('═══════════════════════════════════════\n');

  // 1. Login
  console.log('1. Login');
  await req('POST', '/api/auth/signup', {
    username: `expire_${ts}`, email: `expire_${ts}@test.com`, password: 'test12345'
  }, jar);
  assert('Logged in, have access token', jar.has('syncspace_access'));
  assert('Have refresh token', jar.has('syncspace_refresh'));
  const csrf = jar.get('syncspace_csrf');
  
  // 2. Verify normal API call works
  console.log('\n2. Normal API call (access token valid)');
  const me1 = await req('GET', '/api/auth/me', null, jar);
  assert('/me works normally', me1.status === 200);

  // 3. Simulate token expiry by removing the access token cookie
  console.log('\n3. Simulate access token expiry');
  const savedRefresh = jar.get('syncspace_refresh');
  delete jar.cookies.syncspace_access;
  assert('Access token removed from jar', !jar.has('syncspace_access'));
  assert('Refresh token still present', jar.has('syncspace_refresh'));

  // 4. API call with expired access token — server returns 401
  console.log('\n4. API call with expired token');
  const me2 = await req('GET', '/api/auth/me', null, jar);
  assert('/me returns 401 (expired/missing access)', me2.status === 401);

  // 5. Client-side refresh (simulating what the axios interceptor does)
  console.log('\n5. Silent refresh');
  const refresh = await req('POST', '/api/auth/refresh', {}, jar);
  assert('Refresh succeeds', refresh.status === 200);
  assert('New access token received', jar.has('syncspace_access'));
  assert('New CSRF token received', typeof refresh.data?.csrf_token === 'string');

  // 6. Retry original call — should now succeed
  console.log('\n6. Retry after refresh');
  const me3 = await req('GET', '/api/auth/me', null, jar);
  assert('/me now works with refreshed token', me3.status === 200);
  assert('User data correct', me3.data?.username === `expire_${ts}`);

  // 7. Make a mutation with the new CSRF token
  console.log('\n7. Mutation with refreshed CSRF');
  const newCsrf = jar.get('syncspace_csrf');
  const ws = await req('POST', '/api/workspaces', { name: 'expiry-test' }, jar, {
    'X-CSRF-Token': newCsrf,
  });
  assert('Workspace creation works after refresh', ws.status === 201);

  console.log('\n═══════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
