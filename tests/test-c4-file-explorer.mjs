#!/usr/bin/env node
// C.4 E2E Test: File Explorer — CRUD + Path Validation + Upload Constraints + Live Propagation

import WebSocket from 'ws';

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

class CookieJar {
  constructor() { this.cookies = {}; }
  parseSetCookies(headers) {
    const raw = headers.getSetCookie?.() || [];
    for (const h of raw) {
      const [kv] = h.split(';');
      const [k, ...rest] = kv.split('=');
      this.cookies[k.trim()] = rest.join('=').trim();
    }
  }
  get(name) { return this.cookies[name]; }
  toString() { return Object.entries(this.cookies).map(([k,v]) => `${k}=${v}`).join('; '); }
}

async function req(method, path, body, jar, extraHeaders = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...extraHeaders } };
  if (jar) opts.headers['Cookie'] = jar.toString();
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, opts);
  jar?.parseSetCookies(res.headers);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function run() {
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  console.log('═══════════════════════════════════════');
  console.log('C.4 E2E: File Explorer + Live Propagation');
  console.log('═══════════════════════════════════════\n');

  // ─── Setup: Create user + workspace ───
  console.log('1. SETUP');
  const jar = new CookieJar();
  await req('POST', '/api/auth/signup', {
    username: `fexp_${ts}`, email: `fexp_${ts}@test.com`, password: 'test12345'
  }, jar);
  const csrf = jar.get('syncspace_csrf');
  assert('User created', !!csrf);

  const ws = await req('POST', '/api/workspaces', { name: `fexp-${ts}` }, jar, { 'X-CSRF-Token': csrf });
  const slug = ws.data?.slug;
  const shortId = ws.data?.short_id;
  assert('Workspace created', ws.status === 201 && !!slug);
  console.log();

  // ─── Create File ───
  console.log('2. CREATE FILE');
  const f1 = await req('POST', `/api/workspaces/${shortId}/file`, { path: 'main.py', content: 'print("hello")' }, jar, { 'X-CSRF-Token': csrf });
  assert('Create returns 201', f1.status === 201);
  assert('File has correct path', f1.data?.path === 'main.py');
  assert('Language detected as python', f1.data?.language === 'python');

  await req('POST', `/api/workspaces/${shortId}/file`, { path: 'utils.js', content: 'export const x = 1;' }, jar, { 'X-CSRF-Token': csrf });

  const list1 = await req('GET', `/api/workspaces/${shortId}/files`, null, jar);
  assert('File list has 3+ files', list1.data?.length >= 3);
  const mainPy = list1.data?.find(f => f.path === 'main.py');
  assert('main.py in file list', !!mainPy);
  console.log();

  // ─── Duplicate file rejected ───
  console.log('3. DUPLICATE FILE REJECTED');
  const dup = await req('POST', `/api/workspaces/${shortId}/file`, { path: 'main.py', content: 'x' }, jar, { 'X-CSRF-Token': csrf });
  assert('Duplicate returns 409', dup.status === 409);
  console.log();

  // ─── Upload Constraints ───
  console.log('4. UPLOAD CONSTRAINTS');
  const bigContent = 'x'.repeat(512 * 1024 + 1);
  const big = await req('POST', `/api/workspaces/${shortId}/file`, { path: 'big.txt', content: bigContent }, jar, { 'X-CSRF-Token': csrf });
  assert('Oversized file returns 413', big.status === 413);

  const txt = await req('POST', `/api/workspaces/${shortId}/file`, { path: 'test.txt', content: 'valid text' }, jar, { 'X-CSRF-Token': csrf });
  assert('Valid text accepted', txt.status === 201);
  console.log();

  // ─── Rename File ───
  console.log('5. RENAME FILE');
  const rename1 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'utils.js', new_path: 'helpers.ts'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Rename returns 200', rename1.status === 200);

  const list2 = await req('GET', `/api/workspaces/${shortId}/files`, null, jar);
  const oldFile = list2.data?.find(f => f.path === 'utils.js');
  const newFile = list2.data?.find(f => f.path === 'helpers.ts');
  assert('Old path no longer in list', !oldFile);
  assert('New path in list', !!newFile);
  assert('Language updated to typescript', newFile?.language === 'typescript');
  console.log();

  // ─── Rename Path Validation ───
  console.log('6. RENAME PATH VALIDATION (source + dest)');
  const r1 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: '../etc/passwd', new_path: 'safe.txt'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Traversal in source → 400', r1.status === 400);

  const r2 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'main.py', new_path: '../../../etc/shadow'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Traversal in dest → 400', r2.status === 400);

  const r3 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'main.py', new_path: 'foo//bar.py'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Double-slash in dest → 400', r3.status === 400);

  const r4 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'main.py', new_path: '.hidden'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Leading dot in dest → 400', r4.status === 400);

  const r5 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'main.py', new_path: 'main.py'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Same source=dest → 400', r5.status === 400);

  const r6 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'nonexistent.xyz', new_path: 'valid.txt'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Nonexistent source → 404', r6.status === 404);

  const r7 = await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'main.py', new_path: 'helpers.ts'
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Dest already exists → 409', r7.status === 409);
  console.log();

  // ─── Create Path Validation ───
  console.log('7. CREATE PATH VALIDATION');
  const p1 = await req('POST', `/api/workspaces/${shortId}/file`, { path: '../escape.py', content: '' }, jar, { 'X-CSRF-Token': csrf });
  assert('Traversal in create → 400', p1.status === 400);

  const p2 = await req('POST', `/api/workspaces/${shortId}/file`, { path: '/absolute.py', content: '' }, jar, { 'X-CSRF-Token': csrf });
  assert('Absolute path in create → 400', p2.status === 400);
  console.log();

  // ─── Delete File ───
  console.log('8. DELETE FILE');
  const del1 = await req('DELETE', `/api/workspaces/${shortId}/file?path=test.txt`, null, jar, { 'X-CSRF-Token': csrf });
  assert('Delete returns 200', del1.status === 200);

  const list3 = await req('GET', `/api/workspaces/${shortId}/files`, null, jar);
  const deleted = list3.data?.find(f => f.path === 'test.txt');
  assert('Deleted file not in list', !deleted);

  const del2 = await req('DELETE', `/api/workspaces/${shortId}/file?path=nope.txt`, null, jar, { 'X-CSRF-Token': csrf });
  assert('Delete nonexistent → 404', del2.status === 404);
  console.log();

  // ─── WS File Tree Event Propagation ───
  console.log('9. WS FILE TREE EVENT PROPAGATION');
  const ticket = await req('POST', '/api/ws-ticket', null, jar, { 'X-CSRF-Token': csrf });
  assert('WS ticket obtained', ticket.status === 200 && !!ticket.data?.ticket);

  const wsUrl = `ws://localhost:8080/ws/${shortId}/main.py?ticket=${ticket.data?.ticket}`;
  
  const events = [];
  const wsConn = await new Promise((resolve, reject) => {
    const conn = new WebSocket(wsUrl);
    conn.on('open', () => resolve(conn));
    conn.on('error', reject);
    conn.on('message', (data, isBinary) => {
      // Control messages arrive as text frames; Yjs sync as binary frames
      if (!isBinary) {
        try {
          events.push(JSON.parse(data.toString()));
        } catch (e) {}
      }
    });
    setTimeout(() => reject(new Error('WS timeout')), 5000);
  });
  assert('WS connected', wsConn.readyState === WebSocket.OPEN);

  // Trigger file operations — events should arrive over WS
  await req('POST', `/api/workspaces/${shortId}/file`, { path: 'live.rs', content: 'fn main() {}' }, jar, { 'X-CSRF-Token': csrf });
  await new Promise(r => setTimeout(r, 300));

  await req('POST', `/api/workspaces/${shortId}/file/rename`, {
    old_path: 'live.rs', new_path: 'live_renamed.rs'
  }, jar, { 'X-CSRF-Token': csrf });
  await new Promise(r => setTimeout(r, 300));

  await req('DELETE', `/api/workspaces/${shortId}/file?path=live_renamed.rs`, null, jar, { 'X-CSRF-Token': csrf });
  await new Promise(r => setTimeout(r, 300));

  const createEvent = events.find(e => e.type === 'file_created' && e.path === 'live.rs');
  const renameEvent = events.find(e => e.type === 'file_renamed' && e.path === 'live.rs' && e.new_path === 'live_renamed.rs');
  const deleteEvent = events.find(e => e.type === 'file_deleted' && e.path === 'live_renamed.rs');

  assert('Received file_created event', !!createEvent);
  assert('Received file_renamed event with correct paths', !!renameEvent);
  assert('Received file_deleted event', !!deleteEvent);
  assert('Events arrived in correct order', events.length >= 3);

  wsConn.close();
  console.log();

  // ─── Summary ───
  console.log('═══════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
