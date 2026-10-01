#!/usr/bin/env node
/**
 * E2E test for cookie-based auth (C.1+C.2)
 * Tests through the Next.js proxy at localhost:3000 (same-origin, cookies work)
 */

const BASE = 'http://localhost:3000';

// Simple cookie jar
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
  
  toString() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  
  get(name) { return this.cookies[name] || null; }
  
  has(name) { return name in this.cookies; }
}

async function req(method, path, body, jar, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (jar) headers['Cookie'] = jar.toString();
  
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  
  if (jar) jar.parseSetCookies(resp.headers);
  
  let data = null;
  const text = await resp.text();
  try { data = JSON.parse(text); } catch { data = text; }
  
  return { status: resp.status, data, headers: resp.headers };
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

async function run() {
  const jar = new CookieJar();
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  
  console.log('═══════════════════════════════════════');
  console.log('C.1+C.2 E2E Auth Test (via Next.js proxy)');
  console.log('═══════════════════════════════════════\n');

  // ─── Test 1: Signup sets httpOnly cookies ───
  console.log('1. SIGNUP');
  const signup = await req('POST', '/api/auth/signup', {
    username: `e2e_${ts}`,
    email: `e2e_${ts}@test.com`,
    password: 'test12345'
  }, jar);
  assert('Signup returns 201', signup.status === 201);
  assert('Response has user', signup.data?.user?.username === `e2e_${ts}`);
  assert('Response has csrf_token', typeof signup.data?.csrf_token === 'string' && signup.data.csrf_token.length > 0);
  assert('Response does NOT have token field', !('token' in signup.data));
  assert('syncspace_csrf cookie set', jar.has('syncspace_csrf'));
  assert('syncspace_access cookie set (httpOnly, via Set-Cookie)', jar.has('syncspace_access'));
  assert('syncspace_refresh cookie set (httpOnly, via Set-Cookie)', jar.has('syncspace_refresh'));
  console.log();

  // ─── Test 2: /me works with cookie ───
  console.log('2. /ME WITH COOKIE');
  const me = await req('GET', '/api/auth/me', null, jar);
  assert('/me returns 200 with cookie', me.status === 200);
  assert('/me returns correct username', me.data?.username === `e2e_${ts}`);
  console.log();

  // ─── Test 3: /me FAILS with Authorization header (old path) ───
  console.log('3. OLD AUTH PATH REJECTION');
  const accessToken = jar.get('syncspace_access');
  const meOld = await req('GET', '/api/auth/me', null, null, {
    'Authorization': `Bearer ${accessToken}`
  });
  assert('Authorization header alone returns 401', meOld.status === 401);
  assert('Error message says missing cookie', meOld.data?.error?.includes('cookie'));
  console.log();

  // ─── Test 4: CSRF protection ───
  console.log('4. CSRF PROTECTION');
  // POST without CSRF
  const noCSRF = await req('POST', '/api/workspaces', { name: 'no-csrf-test' }, jar);
  assert('POST without X-CSRF-Token returns 403', noCSRF.status === 403);
  
  // POST with CSRF
  const csrf = jar.get('syncspace_csrf');
  const withCSRF = await req('POST', '/api/workspaces', { name: `ws-${ts}` }, jar, {
    'X-CSRF-Token': csrf,
  });
  assert('POST with X-CSRF-Token returns 201', withCSRF.status === 201);
  assert('Workspace has short_id', typeof withCSRF.data?.short_id === 'string' && withCSRF.data.short_id.length === 32);
  assert('short_id is opaque hex (128-bit)', /^[0-9a-f]{32}$/.test(withCSRF.data?.short_id));
  
  // GET without CSRF succeeds (reads exempt)
  const getWS = await req('GET', '/api/workspaces', null, jar);
  assert('GET without CSRF returns 200', getWS.status === 200);
  assert('Workspace list includes new workspace', Array.isArray(getWS.data) && getWS.data.some(w => w.name === `ws-${ts}`));
  console.log();

  // ─── Test 5: Token refresh with rotation ───
  console.log('5. TOKEN REFRESH + ROTATION');
  const oldRefresh = jar.get('syncspace_refresh');
  const refresh1 = await req('POST', '/api/auth/refresh', {}, jar);
  assert('Refresh returns 200', refresh1.status === 200);
  assert('New CSRF token issued', typeof refresh1.data?.csrf_token === 'string');
  
  const newRefresh = jar.get('syncspace_refresh');
  assert('Refresh token rotated (new != old)', newRefresh !== oldRefresh);
  
  // Old refresh token must fail (replay detection)
  const oldJar = new CookieJar();
  oldJar.cookies = { syncspace_refresh: oldRefresh };
  const replay = await req('POST', '/api/auth/refresh', {}, oldJar);
  assert('Old refresh token rejected (401)', replay.status === 401);
  console.log();

  // ─── Test 6: WS ticket works with cookie ───
  console.log('6. WS TICKET (COOKIE AUTH)');
  const newCsrf = jar.get('syncspace_csrf');
  const ticket = await req('POST', '/api/ws-ticket', null, jar, {
    'X-CSRF-Token': newCsrf,
  });
  assert('WS ticket returns 200', ticket.status === 200);
  assert('Ticket has ticket field', typeof ticket.data?.ticket === 'string' && ticket.data.ticket.length > 0);
  console.log();

  // ─── Test 7: Beacon persist (CSRF NOW REQUIRED) ───
  console.log('7. BEACON PERSIST (CSRF REQUIRED)');
  const slug = withCSRF.data?.slug;
  // Create a file first
  const createFile = await req('POST', `/api/workspaces/${slug}/file`, 
    { path: 'test.py', content: 'print("hello")' }, jar, { 'X-CSRF-Token': newCsrf });
  assert('File created', createFile.status === 201);
  
  // Beacon persist WITHOUT CSRF token should FAIL (no exemption)
  const beaconNoCsrf = await req('POST', `/api/workspaces/${slug}/beacon-persist`, 
    { path: 'test.py', content: 'print("updated")' }, jar);  // no X-CSRF-Token
  assert('Beacon persist without CSRF returns 403', beaconNoCsrf.status === 403);
  
  // Beacon persist WITH CSRF token should succeed
  const beaconWithCsrf = await req('POST', `/api/workspaces/${slug}/beacon-persist`, 
    { path: 'test.py', content: 'print("updated")' }, jar, { 'X-CSRF-Token': newCsrf });
  assert('Beacon persist with CSRF returns 204', beaconWithCsrf.status === 204);
  console.log();

  // ─── Test 8: Logout ───
  console.log('8. LOGOUT');
  const logout = await req('POST', '/api/auth/logout', null, jar, {
    'X-CSRF-Token': newCsrf,
  });
  assert('Logout returns 200', logout.status === 200);
  assert('Access cookie cleared', !jar.has('syncspace_access'));
  assert('Refresh cookie cleared', !jar.has('syncspace_refresh'));
  assert('CSRF cookie cleared', !jar.has('syncspace_csrf'));
  
  // After logout, /me with the cleared jar should fail
  const meAfter = await req('GET', '/api/auth/me', null, jar);
  assert('/me after logout returns 401', meAfter.status === 401);
  console.log();

  // ─── Summary ───
  console.log('═══════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
