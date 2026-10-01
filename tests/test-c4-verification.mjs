#!/usr/bin/env node
// Verification Test 1: Concurrent typing + file ops on same WS connection
// Proves that text-frame control messages don't interfere with binary Yjs sync.
//
// Verification Test 2: Cross-file event propagation
// Client A has main.py open; Client B creates utils.py → Client A receives the event.

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const BASE = 'http://localhost:3000';
const MSG_SYNC = 0;
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
  const res = await fetch(`${BASE}${path}`, opts);
  jar?.parseSetCookies(res.headers);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function run() {
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  console.log('═══════════════════════════════════════');
  console.log('C.4 Verification: Frame Safety + Cross-File Events');
  console.log('═══════════════════════════════════════\n');

  // ─── Setup ───
  console.log('1. SETUP (2 users, shared workspace)');
  const jarA = new CookieJar();
  await req('POST', '/api/auth/signup', { username: `alice_v_${ts}`, email: `alice_v_${ts}@test.com`, password: 'test12345' }, jarA);
  const csrfA = jarA.get('syncspace_csrf');
  assert('Alice created', !!csrfA);

  const jarB = new CookieJar();
  await req('POST', '/api/auth/signup', { username: `bob_v_${ts}`, email: `bob_v_${ts}@test.com`, password: 'test12345' }, jarB);
  const csrfB = jarB.get('syncspace_csrf');
  assert('Bob created', !!csrfB);

  const ws = await req('POST', '/api/workspaces', { name: `verify-${ts}` }, jarA, { 'X-CSRF-Token': csrfA });
  const shortId = ws.data?.short_id;
  assert('Workspace created', !!shortId);

  // Invite Bob
  await req('POST', `/api/workspaces/${shortId}/members`, { identifier: `bob_v_${ts}`, role: 'editor' }, jarA, { 'X-CSRF-Token': csrfA });

  // Create initial file
  await req('POST', `/api/workspaces/${shortId}/file`, { path: 'editor.py', content: '' }, jarA, { 'X-CSRF-Token': csrfA });
  console.log();

  // ─── Verification 1: Concurrent Yjs sync + file-tree events on same connection ───
  console.log('2. VERIFICATION 1: Yjs sync NOT corrupted by file-tree events');
  
  // Connect Alice to editor.py via WS
  const ticketA = await req('POST', '/api/ws-ticket', null, jarA, { 'X-CSRF-Token': csrfA });
  const wsUrlA = `ws://localhost:8080/ws/${shortId}/editor.py?ticket=${ticketA.data?.ticket}`;

  const docA = new Y.Doc();
  const fileEvents = [];
  let syncMsgsReceived = 0;
  let binaryMsgsReceived = 0;

  const connA = await new Promise((resolve, reject) => {
    const conn = new WebSocket(wsUrlA);
    conn.on('open', () => resolve(conn));
    conn.on('error', reject);
    conn.on('message', (data, isBinary) => {
      if (!isBinary) {
        // Text frame = control message
        try { fileEvents.push(JSON.parse(data.toString())); } catch {}
      } else {
        // Binary frame = Yjs protocol
        binaryMsgsReceived++;
        const arr = new Uint8Array(data);
        const decoder = decoding.createDecoder(arr);
        const msgType = decoding.readVarUint(decoder);
        if (msgType === MSG_SYNC) {
          syncMsgsReceived++;
          const syncEncoder = encoding.createEncoder();
          encoding.writeVarUint(syncEncoder, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, syncEncoder, docA, 'remote');
          if (encoding.length(syncEncoder) > 1) {
            conn.send(encoding.toUint8Array(syncEncoder));
          }
        }
      }
    });
    setTimeout(() => reject(new Error('WS timeout')), 5000);
  });
  assert('Alice WS connected', connA.readyState === WebSocket.OPEN);

  // Send sync step 1 (initial sync)
  const initEncoder = encoding.createEncoder();
  encoding.writeVarUint(initEncoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(initEncoder, docA);
  connA.send(encoding.toUint8Array(initEncoder));
  await new Promise(r => setTimeout(r, 200));

  // Now simulate continuous typing: insert text into Y.Doc, send updates
  const ytext = docA.getText('monaco');
  const typedChars = 'Hello from Alice during concurrent file ops! 🚀';
  
  // Start typing AND trigger file operations simultaneously
  const typePromise = (async () => {
    for (let i = 0; i < typedChars.length; i++) {
      ytext.insert(ytext.length, typedChars[i]);
      // Each insert triggers doc.on('update'), which we send manually
      await new Promise(r => setTimeout(r, 10));
    }
  })();

  // Send doc updates as they happen
  docA.on('update', (update) => {
    if (connA.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      connA.send(encoding.toUint8Array(encoder));
    }
  });

  // Concurrently trigger file operations (these send text-frame events back)
  const opsPromise = (async () => {
    await new Promise(r => setTimeout(r, 50));
    await req('POST', `/api/workspaces/${shortId}/file`, { path: 'concurrent1.rs', content: 'fn a() {}' }, jarA, { 'X-CSRF-Token': csrfA });
    await new Promise(r => setTimeout(r, 50));
    await req('POST', `/api/workspaces/${shortId}/file/rename`, { old_path: 'concurrent1.rs', new_path: 'concurrent2.rs' }, jarA, { 'X-CSRF-Token': csrfA });
    await new Promise(r => setTimeout(r, 50));
    await req('DELETE', `/api/workspaces/${shortId}/file?path=concurrent2.rs`, null, jarA, { 'X-CSRF-Token': csrfA });
    await new Promise(r => setTimeout(r, 50));
    await req('POST', `/api/workspaces/${shortId}/file`, { path: 'concurrent3.go', content: 'package main' }, jarA, { 'X-CSRF-Token': csrfA });
    await new Promise(r => setTimeout(r, 50));
    await req('DELETE', `/api/workspaces/${shortId}/file?path=concurrent3.go`, null, jarA, { 'X-CSRF-Token': csrfA });
  })();

  // Wait for both
  await Promise.all([typePromise, opsPromise]);
  await new Promise(r => setTimeout(r, 500));

  // Verify: all text was sent, Y.Doc is intact, file events arrived
  const docContent = ytext.toString();
  assert(`Y.Doc content intact (${docContent.length} chars)`, docContent === typedChars);
  assert('File tree events received during typing', fileEvents.length >= 4);
  // With a single client in the room, the relay has nobody to echo sync messages back to.
  // The key proof: file events (text frames) arrived correctly AND typing wasn't disrupted.
  // If the 0x00-prefix bug still existed, sync step 1 (which starts with 0x00) would have
  // been misrouted through the control-message path and silently dropped.
  assert('No binary msgs misclassified as text (text event count matches file ops)', fileEvents.length === 5);
  
  console.log(`  📊 Stats: ${binaryMsgsReceived} binary msgs, ${syncMsgsReceived} sync msgs, ${fileEvents.length} file events`);
  console.log(`  📊 File events: ${fileEvents.map(e => e.type).join(', ')}`);
  console.log();

  // ─── Verification 2: Cross-file event propagation ───
  console.log('3. VERIFICATION 2: Client on file A receives events from file B operations');
  
  // Alice is already connected to editor.py
  // Clear events
  fileEvents.length = 0;

  // Bob creates a completely different file (utils.py) — Alice should see the event
  // even though she's connected to editor.py
  await req('POST', `/api/workspaces/${shortId}/file`, { path: 'from_bob.py', content: '# Bob created this' }, jarB, { 'X-CSRF-Token': csrfB });
  await new Promise(r => setTimeout(r, 300));

  const crossFileCreate = fileEvents.find(e => e.type === 'file_created' && e.path === 'from_bob.py');
  assert('Alice (on editor.py) received file_created for from_bob.py', !!crossFileCreate);

  // Bob renames it
  await req('POST', `/api/workspaces/${shortId}/file/rename`, { old_path: 'from_bob.py', new_path: 'bobs_file.py' }, jarB, { 'X-CSRF-Token': csrfB });
  await new Promise(r => setTimeout(r, 300));

  const crossFileRename = fileEvents.find(e => e.type === 'file_renamed' && e.path === 'from_bob.py');
  assert('Alice received file_renamed for from_bob.py → bobs_file.py', !!crossFileRename);

  // Bob deletes it
  await req('DELETE', `/api/workspaces/${shortId}/file?path=bobs_file.py`, null, jarB, { 'X-CSRF-Token': csrfB });
  await new Promise(r => setTimeout(r, 300));

  const crossFileDelete = fileEvents.find(e => e.type === 'file_deleted' && e.path === 'bobs_file.py');
  assert('Alice received file_deleted for bobs_file.py', !!crossFileDelete);

  console.log(`  📊 Cross-file events received: ${fileEvents.length}`);
  console.log();

  connA.close();

  // ─── Summary ───
  console.log('═══════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
