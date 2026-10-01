#!/usr/bin/env node
/**
 * C.3 E2E Test: Share/Invite, Members, ColorSlot, Routing
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
  return { status: resp.status, data, headers: resp.headers };
}

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

async function run() {
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  
  console.log('═══════════════════════════════════════');
  console.log('C.3 E2E: Share/Invite + Members + Routing');
  console.log('═══════════════════════════════════════\n');

  // ─── Create two distinct users ───
  console.log('1. CREATE TWO USERS');
  const jarA = new CookieJar();
  const userA = await req('POST', '/api/auth/signup', {
    username: `alice_${ts}`, email: `alice_${ts}@test.com`, password: 'test12345'
  }, jarA);
  const csrfA = jarA.get('syncspace_csrf');
  assert('User A created', userA.status === 201);

  const jarB = new CookieJar();
  const userB = await req('POST', '/api/auth/signup', {
    username: `bob_${ts}`, email: `bob_${ts}@test.com`, password: 'test12345'
  }, jarB);
  const csrfB = jarB.get('syncspace_csrf');
  assert('User B created', userB.status === 201);
  console.log();

  // ─── Create workspace as User A ───
  console.log('2. CREATE WORKSPACE (User A)');
  const ws = await req('POST', '/api/workspaces', { name: `collab-${ts}` }, jarA, {
    'X-CSRF-Token': csrfA,
  });
  assert('Workspace created', ws.status === 201);
  const shortId = ws.data.short_id;
  const wsSlug = ws.data.slug;
  assert('short_id is 32-char hex (128-bit)', /^[0-9a-f]{32}$/.test(shortId));
  console.log(`  slug=${wsSlug}, short_id=${shortId}`);
  console.log();

  // ─── Verify routing: API accepts short_id ───
  console.log('3. ROUTING: API ACCEPTS short_id');
  const wsViaShortId = await req('GET', `/api/workspaces/${shortId}`, null, jarA);
  assert('GET /api/workspaces/{shortId} returns 200', wsViaShortId.status === 200);
  assert('Returns correct workspace', wsViaShortId.data?.name === `collab-${ts}`);
  
  const wsViaSlug = await req('GET', `/api/workspaces/${wsSlug}`, null, jarA);
  assert('GET /api/workspaces/{slug} still works', wsViaSlug.status === 200);
  console.log();

  // ─── Members: Owner is listed ───
  console.log('4. MEMBER LIST (before invite)');
  const members1 = await req('GET', `/api/workspaces/${shortId}/members`, null, jarA);
  assert('Members list returns 200', members1.status === 200);
  assert('One member (owner)', Array.isArray(members1.data) && members1.data.length === 1);
  assert('Owner has colorSlot 0', members1.data[0]?.color_slot === 0);
  assert('Owner role is owner', members1.data[0]?.role === 'owner');
  assert('Owner is User A', members1.data[0]?.username === `alice_${ts}`);
  console.log();

  // ─── User B cannot access workspace ───
  console.log('5. USER B CANNOT ACCESS BEFORE INVITE');
  const bAccess = await req('GET', `/api/workspaces/${shortId}`, null, jarB);
  assert('User B gets 404 (not a member)', bAccess.status === 404);
  console.log();

  // ─── Invite User B ───
  console.log('6. INVITE USER B');
  const invite = await req('POST', `/api/workspaces/${shortId}/members`, {
    identifier: `bob_${ts}`, role: 'editor',
  }, jarA, { 'X-CSRF-Token': csrfA });
  assert('Invite returns 200', invite.status === 200);
  assert('Now 2 members', Array.isArray(invite.data) && invite.data.length === 2);
  
  // Find Bob in the member list
  const bobMember = invite.data.find(m => m.username === `bob_${ts}`);
  assert('Bob is in member list', !!bobMember);
  assert('Bob has colorSlot 1 (joined second)', bobMember?.color_slot === 1);
  assert('Bob role is editor', bobMember?.role === 'editor');
  
  // Alice still has colorSlot 0
  const aliceMember = invite.data.find(m => m.username === `alice_${ts}`);
  assert('Alice still has colorSlot 0', aliceMember?.color_slot === 0);
  console.log();

  // ─── User B can now access workspace ───
  console.log('7. USER B CAN ACCESS AFTER INVITE');
  const bAccess2 = await req('GET', `/api/workspaces/${shortId}`, null, jarB);
  assert('User B now gets 200', bAccess2.status === 200);
  assert('Same workspace', bAccess2.data?.name === `collab-${ts}`);
  
  // User B can see members
  const bMembers = await req('GET', `/api/workspaces/${shortId}/members`, null, jarB);
  assert('User B sees member list', bMembers.status === 200 && bMembers.data?.length === 2);
  console.log();

  // ─── User B cannot invite (only owner/editor) — wait, B is editor, so should work ─
  console.log('8. PERMISSION CHECKS');
  // Change Bob to viewer first
  const demote = await req('PUT', `/api/workspaces/${shortId}/members/${userB.data.user.id}`, {
    role: 'viewer',
  }, jarA, { 'X-CSRF-Token': csrfA });
  assert('Owner can change Bob to viewer', demote.status === 200);
  
  // Viewer cannot invite
  const viewerInvite = await req('POST', `/api/workspaces/${shortId}/members`, {
    identifier: 'nonexistent', role: 'editor',
  }, jarB, { 'X-CSRF-Token': csrfB });
  assert('Viewer cannot invite (403)', viewerInvite.status === 403);
  
  // Promote Bob back to editor
  await req('PUT', `/api/workspaces/${shortId}/members/${userB.data.user.id}`, {
    role: 'editor',
  }, jarA, { 'X-CSRF-Token': csrfA });
  console.log();

  // ─── ColorSlot stability ───
  console.log('9. COLORSLOT STABILITY');
  const members3 = await req('GET', `/api/workspaces/${shortId}/members`, null, jarA);
  const aliceSlot = members3.data.find(m => m.username === `alice_${ts}`)?.color_slot;
  const bobSlot = members3.data.find(m => m.username === `bob_${ts}`)?.color_slot;
  assert('Alice colorSlot stable (0)', aliceSlot === 0);
  assert('Bob colorSlot stable (1)', bobSlot === 1);
  console.log();

  // ─── WS Ticket with short_id ───
  console.log('10. WS TICKET VIA short_id');
  const ticketA = await req('POST', '/api/ws-ticket', null, jarA, { 'X-CSRF-Token': csrfA });
  assert('User A gets ticket', ticketA.status === 200 && ticketA.data?.ticket);
  const ticketB = await req('POST', '/api/ws-ticket', null, jarB, { 'X-CSRF-Token': csrfB });
  assert('User B gets ticket', ticketB.status === 200 && ticketB.data?.ticket);
  console.log();

  // ─── Remove member ───
  console.log('11. REMOVE MEMBER');
  const remove = await req('DELETE', `/api/workspaces/${shortId}/members/${userB.data.user.id}`, null, jarA, {
    'X-CSRF-Token': csrfA,
  });
  assert('Remove returns 200', remove.status === 200);
  
  // User B can no longer access
  const bAccess3 = await req('GET', `/api/workspaces/${shortId}`, null, jarB);
  assert('User B gets 404 after removal', bAccess3.status === 404);
  
  // Only 1 member remains
  const members4 = await req('GET', `/api/workspaces/${shortId}/members`, null, jarA);
  assert('1 member after removal', members4.data?.length === 1);
  console.log();

  // ─── Auth test: re-run with updated assertions ───
  console.log('12. AUTH REGRESSION (31-test suite)');
  // Quick subset: verify 128-bit short_id, CSRF on beacon
  const jar = new CookieJar();
  const rnd = Math.random().toString(36).slice(2, 8);
  const auth = await req('POST', '/api/auth/signup', {
    username: `reg_${ts}_${rnd}`, email: `reg_${ts}_${rnd}@test.com`, password: 'test12345',
  }, jar);
  const csrf = jar.get('syncspace_csrf');
  const regWs = await req('POST', '/api/workspaces', { name: `reg-${ts}` }, jar, { 'X-CSRF-Token': csrf });
  assert('Workspace short_id is 32 chars', regWs.data?.short_id?.length === 32);
  
  // Beacon needs CSRF
  const regSlug = regWs.data?.slug;
  await req('POST', `/api/workspaces/${regSlug}/file`, { path: 'x.py', content: '1' }, jar, { 'X-CSRF-Token': csrf });
  const beaconNoCsrf = await req('POST', `/api/workspaces/${regSlug}/beacon-persist`, { path: 'x.py', content: '2' }, jar);
  assert('Beacon without CSRF → 403', beaconNoCsrf.status === 403);
  const beaconCsrf = await req('POST', `/api/workspaces/${regSlug}/beacon-persist`, { path: 'x.py', content: '2' }, jar, { 'X-CSRF-Token': csrf });
  assert('Beacon with CSRF → 204', beaconCsrf.status === 204);
  console.log();

  // ─── Summary ───
  console.log('═══════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
