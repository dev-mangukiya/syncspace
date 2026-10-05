#!/usr/bin/env node
/**
 * Scenario 3: Non-Overlapping Reconnect Data Loss Probe
 *
 * Tests whether Alice's edit survives in Postgres after:
 * 1. Both Alice and Bob sync on seeded content
 * 2. Both go offline, both edit independently
 * 3. Alice reconnects ALONE, her edit flushes to Postgres
 * 4. Alice FULLY disconnects (client state discarded — tab closed)
 * 5. Bob reconnects ALONE
 * 6. Bob's state flushes to Postgres
 * 7. Query Postgres: does Alice's edit still exist?
 */

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const WS_HTTP_URL = process.env.WS_HTTP_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:8080';

class CookieJar {
  constructor() { this.cookies = {}; }
  parseSetCookies(headers) {
    const raw = headers.getSetCookie?.() || [];
    for (const h of raw) {
      const [kv] = h.split(';');
      const [k, ...rest] = kv.split('=');
      const val = rest.join('=').trim();
      if (h.includes('Max-Age=0') || h.includes('Max-Age=-1')) delete this.cookies[k.trim()];
      else this.cookies[k.trim()] = val;
    }
  }
  toString() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function api(method, endpoint, body, jar, csrfToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar) headers['Cookie'] = jar.toString();
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const resp = await fetch(`${WS_HTTP_URL}${endpoint}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (jar) jar.parseSetCookies(resp.headers);
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

async function signupUser(prefix) {
  const id = Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000);
  const username = `${prefix}_${id}`;
  const jar = new CookieJar();
  const res = await api('POST', '/api/auth/signup', {
    username, email: `${username}@test.local`, password: 'TestPass2026!',
  }, jar);
  if (res.status !== 201) throw new Error(`Signup failed: ${JSON.stringify(res.data)}`);
  return { username, email: `${username}@test.local`, jar, csrfToken: res.data.csrf_token };
}

function connectYjsClient(wsUrl, shortId, filePath, ticket) {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const ws = new WebSocket(`${wsUrl}/ws/${shortId}/${filePath}?ticket=${ticket}`);
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const dec = decoding.createDecoder(new Uint8Array(data));
      const mt = decoding.readVarUint(dec);
      if (mt === 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, doc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      }
    });
    ws.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, doc);
      ws.send(encoding.toUint8Array(enc));
      setTimeout(() => resolve({ doc, ws }), 2000);
    });
    ws.on('error', reject);
  });
}

function sendSnapshot(ws, content) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'content_snapshot', content }));
  }
}

async function reconnectAndFlush(client, wsUrl, shortId, filePath, jar, csrfToken, slug) {
  const ticketRes = await api('POST', '/api/ws-ticket', {}, jar, csrfToken);
  const ws = new WebSocket(`${wsUrl}/ws/${shortId}/${filePath}?ticket=${ticketRes.data.ticket}`);
  ws.binaryType = 'arraybuffer';
  client.ws = ws;

  await new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const dec = decoding.createDecoder(new Uint8Array(data));
      const mt = decoding.readVarUint(dec);
      if (mt === 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, client.doc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      }
    });
    ws.on('open', () => {
      // Push our full state
      const enc1 = encoding.createEncoder();
      encoding.writeVarUint(enc1, 0);
      syncProtocol.writeSyncStep1(enc1, client.doc);
      ws.send(encoding.toUint8Array(enc1));
      const enc2 = encoding.createEncoder();
      encoding.writeVarUint(enc2, 0);
      syncProtocol.writeSyncStep2(enc2, client.doc);
      ws.send(encoding.toUint8Array(enc2));
      // content_snapshot for server persistence
      setTimeout(() => {
        sendSnapshot(ws, client.doc.getText('content').toString());
        setTimeout(resolve, 1500);
      }, 1000);
    });
  });

  // Also REST flush to be doubly sure Postgres has this client's version
  const content = client.doc.getText('content').toString();
  await api('PUT', `/api/workspaces/${slug}/file`, { path: filePath, content }, jar, csrfToken);
  return content;
}

async function getPostgresContent(slug, filePath, jar, csrfToken) {
  const res = await api('GET', `/api/workspaces/${slug}/file?path=${encodeURIComponent(filePath)}`, null, jar, csrfToken);
  return res.data?.content;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' SCENARIO 3: NON-OVERLAPPING RECONNECT DATA LOSS PROBE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── 3.1 Setup ──
  console.log('─── 3.1 Setup ───');
  const alice = await signupUser('alice_s3');
  const bob = await signupUser('bob_s3');

  const wsRes = await api('POST', '/api/workspaces', {
    name: 'S3 Data Loss Probe', template: 'javascript',
  }, alice.jar, alice.csrfToken);
  const shortId = wsRes.data.short_id;
  const slug = wsRes.data.slug;
  console.log(`  Created workspace: ${slug} (${shortId})`);

  await api('POST', `/api/workspaces/${shortId}/members`, {
    identifier: bob.email, role: 'editor',
  }, alice.jar, alice.csrfToken);

  // Seed real content via REST
  const SEED = `// SEED: Original starter content\nconsole.log('Hello from SyncSpace!');\n// This line must survive all merges\n`;
  await api('PUT', `/api/workspaces/${slug}/file`, { path: 'index.js', content: SEED }, alice.jar, alice.csrfToken);

  const pgSeed = await getPostgresContent(slug, 'index.js', alice.jar, alice.csrfToken);
  console.log(`  Postgres seed: ${pgSeed?.length || 0} bytes`);
  console.log(`  Seed matches: ${pgSeed === SEED ? 'YES' : 'NO'}`);

  // ── 3.2 Both connect and sync ──
  console.log('\n─── 3.2 Both connect and sync ───');
  const aliceTicket = await api('POST', '/api/ws-ticket', {}, alice.jar, alice.csrfToken);
  const aliceClient = await connectYjsClient(WS_URL, shortId, 'index.js', aliceTicket.data.ticket);

  // Seed Y.Doc
  aliceClient.doc.transact(() => {
    aliceClient.doc.getText('content').insert(0, SEED);
  });
  sendSnapshot(aliceClient.ws, SEED);
  await new Promise(r => setTimeout(r, 1000));

  const bobTicket = await api('POST', '/api/ws-ticket', {}, bob.jar, bob.csrfToken);
  const bobClient = await connectYjsClient(WS_URL, shortId, 'index.js', bobTicket.data.ticket);
  await new Promise(r => setTimeout(r, 2000));

  console.log(`  Alice Y.Doc: ${aliceClient.doc.getText('content').length} bytes`);
  console.log(`  Bob Y.Doc:   ${bobClient.doc.getText('content').length} bytes`);
  console.log(`  In sync:     ${aliceClient.doc.getText('content').toString() === bobClient.doc.getText('content').toString()}`);

  // ── 3.3 BOTH go offline ──
  console.log('\n─── 3.3 BOTH go offline ───');
  aliceClient.ws.close(); aliceClient.ws = null;
  bobClient.ws.close(); bobClient.ws = null;
  console.log('  Both WebSockets closed. Room empty.');
  await new Promise(r => setTimeout(r, 1500));

  // ── 3.4 Independent offline edits ──
  console.log('\n─── 3.4 Independent offline edits ───');
  aliceClient.doc.transact(() => {
    aliceClient.doc.getText('content').insert(0, '// ALICE_EDIT: made while completely offline\n');
  });
  bobClient.doc.transact(() => {
    const yt = bobClient.doc.getText('content');
    yt.insert(yt.length, '\n// BOB_EDIT: made while completely offline\n');
  });

  const aliceLocal = aliceClient.doc.getText('content').toString();
  const bobLocal = bobClient.doc.getText('content').toString();
  console.log(`  Alice Y.Doc: has ALICE_EDIT=${aliceLocal.includes('ALICE_EDIT')}, has BOB_EDIT=${aliceLocal.includes('BOB_EDIT')}`);
  console.log(`  Bob Y.Doc:   has ALICE_EDIT=${bobLocal.includes('ALICE_EDIT')}, has BOB_EDIT=${bobLocal.includes('BOB_EDIT')}`);

  // ── 3.5 Alice reconnects ALONE → flush → FULL disconnect ──
  console.log('\n─── 3.5 Alice reconnects ALONE → flush → FULL disconnect ───');
  const aliceFlushed = await reconnectAndFlush(aliceClient, WS_URL, shortId, 'index.js', alice.jar, alice.csrfToken, slug);
  console.log(`  Alice flushed to Postgres (${aliceFlushed.length} bytes)`);

  // Verify Alice's edit is in Postgres
  const pgAfterAlice = await getPostgresContent(slug, 'index.js', alice.jar, alice.csrfToken);
  console.log(`  Postgres after Alice flush: ${pgAfterAlice?.length} bytes`);
  console.log(`  Contains ALICE_EDIT: ${pgAfterAlice?.includes('ALICE_EDIT')}`);
  console.log(`  Contains SEED:       ${pgAfterAlice?.includes('SEED')}`);

  // FULLY disconnect Alice — close WS, destroy Y.Doc (tab closed)
  aliceClient.ws.close(); aliceClient.ws = null;
  aliceClient.doc.destroy(); aliceClient.doc = null;
  console.log('  Alice FULLY disconnected — WS closed, Y.Doc destroyed');
  await new Promise(r => setTimeout(r, 2000));

  // ── 3.6 Bob reconnects ALONE ──
  console.log('\n─── 3.6 Bob reconnects ALONE (Alice is gone) ───');
  const bobFlushed = await reconnectAndFlush(bobClient, WS_URL, shortId, 'index.js', bob.jar, bob.csrfToken, slug);
  console.log(`  Bob flushed to Postgres (${bobFlushed.length} bytes)`);

  // Close Bob's WS to trigger room eviction
  bobClient.ws.close(); bobClient.ws = null;
  await new Promise(r => setTimeout(r, 2000));

  // ── 3.7 THE CRITICAL CHECK ──
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' 3.7 THE CRITICAL CHECK: What survived in Postgres?');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const pgFinal = await getPostgresContent(slug, 'index.js', alice.jar, alice.csrfToken);
  console.log(`  Postgres final content (${pgFinal?.length} bytes):`);
  console.log('  ┌──────────────────────────────────────────────');
  pgFinal?.split('\n').forEach(l => console.log(`  │ ${l}`));
  console.log('  └──────────────────────────────────────────────\n');

  const hasAlice = pgFinal?.includes('ALICE_EDIT');
  const hasBob = pgFinal?.includes('BOB_EDIT');
  const hasSeed = pgFinal?.includes('SEED');

  console.log(`  Contains ALICE_EDIT:  ${hasAlice ? '✅ SURVIVED' : '❌ LOST'}`);
  console.log(`  Contains BOB_EDIT:    ${hasBob ? '✅ SURVIVED' : '❌ LOST'}`);
  console.log(`  Contains SEED:        ${hasSeed ? '✅ SURVIVED' : '❌ LOST'}`);

  console.log('\n─── 3.8 Bob\'s in-memory Y.Doc ───');
  const bobDocStr = bobClient.doc.getText('content').toString();
  console.log(`  Bob Y.Doc (${bobDocStr.length} bytes):`);
  console.log('  ┌──────────────────────────────────────────────');
  bobDocStr.split('\n').forEach(l => console.log(`  │ ${l}`));
  console.log('  └──────────────────────────────────────────────');
  console.log(`  Bob Y.Doc has ALICE_EDIT: ${bobDocStr.includes('ALICE_EDIT')}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  if (hasAlice && hasBob && hasSeed) {
    console.log(' RESULT: ALL DATA SURVIVED — no data loss');
  } else if (!hasAlice && hasBob) {
    console.log(' RESULT: ALICE\'S EDIT WAS LOST — confirmed last-write-wins data loss');
    console.log('');
    console.log(' Root cause: Bob\'s Y.Doc never received Alice\'s edit (they were');
    console.log(' never simultaneously connected). When Bob flushed his flattened');
    console.log(' text to Postgres via content_snapshot/REST, it overwrote Alice\'s');
    console.log(' version. The server stores only flattened text, not Y.Doc CRDT');
    console.log(' state, so there is no merge — it is pure last-write-wins.');
  } else {
    console.log(` RESULT: UNEXPECTED — Alice=${hasAlice}, Bob=${hasBob}, Seed=${hasSeed}`);
  }
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(hasAlice && hasBob ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
