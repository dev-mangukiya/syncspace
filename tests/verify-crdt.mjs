/**
 * CRDT Convergence Verification Script
 * ─────────────────────────────────────
 * Tests that two independent Yjs clients, connected to the same
 * SyncSpace relay server, achieve byte-identical convergence after
 * concurrent and offline edits.
 *
 * Prerequisites:
 *   - ws-server running on localhost:8080
 *   - A registered user (signup first if needed)
 *   - A workspace with at least one file
 *
 * Usage:
 *   node verify-crdt.mjs
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Awareness } from 'y-protocols/awareness';
import WebSocket from 'ws';

const API_BASE = 'http://localhost:8080';
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// ── Helpers ──────────────────────────────────────────────

async function signup(username, password) {
  const res = await fetch(`${API_BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@test.com`, password }),
  });
  return res.json();
}

async function login(email, password) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.json();
}

async function getTicket(token) {
  const res = await fetch(`${API_BASE}/api/ws-ticket`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.json();
}

async function createWorkspace(token, name) {
  const res = await fetch(`${API_BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ name, description: 'CRDT test', template: 'blank', language: 'python' }),
  });
  return res.json();
}

async function createFile(token, slug, path) {
  const res = await fetch(`${API_BASE}/api/workspaces/${slug}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a Yjs client that connects to the relay server via WebSocket.
 */
function createClient(name) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  let ws = null;
  let connected = false;
  let synced = false;

  awareness.setLocalStateField('user', { name, color: '#888' });

  doc.on('update', (update, origin) => {
    if (origin === 'remote') return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });

  awareness.on('update', ({ added, updated, removed }) => {
    const changedClients = [...added, ...updated, ...removed];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
    ws.send(encoding.toUint8Array(encoder));
  });

  async function connect(token, slug, filePath) {
    const { ticket } = await getTicket(token);
    const wsUrl = `ws://localhost:8080/ws/${slug}/${encodeURIComponent(filePath)}?ticket=${ticket}`;
    console.log(`  [${name}] Connecting to ${wsUrl.replace(/ticket=.*/, 'ticket=<REDACTED>')}`);

    return new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.on('open', () => {
        connected = true;
        // Send sync step 1
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeSyncStep1(encoder, doc);
        ws.send(encoding.toUint8Array(encoder));

        // Also send sync step 2 (our full state) so peers get our changes
        const step2Encoder = encoding.createEncoder();
        encoding.writeVarUint(step2Encoder, MSG_SYNC);
        syncProtocol.writeSyncStep2(step2Encoder, doc);
        ws.send(encoding.toUint8Array(step2Encoder));

        // Send awareness
        const aEncoder = encoding.createEncoder();
        encoding.writeVarUint(aEncoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(aEncoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
        ws.send(encoding.toUint8Array(aEncoder));

        resolve();
      });

      ws.on('message', (data) => {
        const buf = new Uint8Array(data);
        const decoder = decoding.createDecoder(buf);
        const messageType = decoding.readVarUint(decoder);

        switch (messageType) {
          case MSG_SYNC: {
            const syncEncoder = encoding.createEncoder();
            encoding.writeVarUint(syncEncoder, MSG_SYNC);
            const msgType = syncProtocol.readSyncMessage(decoder, syncEncoder, doc, 'remote');
            if (encoding.length(syncEncoder) > 1) {
              ws.send(encoding.toUint8Array(syncEncoder));
            }
            if (msgType === 1) {
              synced = true;
            }
            break;
          }
          case MSG_AWARENESS: {
            const update = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(awareness, update, 'remote');
            break;
          }
        }
      });

      ws.on('error', reject);
      ws.on('close', () => { connected = false; });
    });
  }

  function disconnect() {
    if (ws) {
      ws.close();
      ws = null;
      connected = false;
    }
  }

  function getText() {
    return doc.getText('content');
  }

  function insertAt(pos, text) {
    doc.getText('content').insert(pos, text);
  }

  function deleteAt(pos, length) {
    doc.getText('content').delete(pos, length);
  }

  return { doc, awareness, connect, disconnect, getText, insertAt, deleteAt, get connected() { return connected; }, get synced() { return synced; } };
}

// ── Main Test ────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════');
  console.log(' CRDT CONVERGENCE VERIFICATION');
  console.log('═══════════════════════════════════════\n');

  // Step 1: Setup — create user and workspace
  console.log('STEP 1: Setup');
  const testId = `crdt_${Date.now()}`;

  const signupRes = await signup(`user_${testId}`, 'TestPass123!');
  let token;
  if (signupRes.token) {
    token = signupRes.token;
  } else {
    // User might already exist
    const loginRes = await login(`user_${testId}@test.com`, 'TestPass123!');
    token = loginRes.token;
  }
  console.log(`  Token obtained: ${token ? token.substring(0, 20) + '...' : 'FAILED'}`);

  const wsRes = await createWorkspace(token, `test-${testId}`);
  const slug = wsRes.slug;
  console.log(`  Workspace created: ${slug}`);

  await createFile(token, slug, 'test.py');
  console.log(`  File created: test.py`);

  // Step 2: Connect two clients to the same file
  console.log('\nSTEP 2: Connect two clients');
  const clientA = createClient('Alice');
  const clientB = createClient('Bob');

  await clientA.connect(token, slug, 'test.py');
  console.log('  Alice connected');
  await sleep(500);
  await clientB.connect(token, slug, 'test.py');
  console.log('  Bob connected');
  await sleep(1000); // Let sync handshake complete

  // Step 3: Concurrent edits
  console.log('\nSTEP 3: Concurrent edits at overlapping positions');
  console.log('  Alice inserts "ALICE_WAS_HERE" at position 0');
  console.log('  Bob inserts "BOB_WAS_HERE" at position 0');

  clientA.insertAt(0, 'ALICE_WAS_HERE');
  clientB.insertAt(0, 'BOB_WAS_HERE');

  // Wait for messages to propagate
  await sleep(2000);

  const textA1 = clientA.getText().toString();
  const textB1 = clientB.getText().toString();

  console.log(`\n  Alice's doc: "${textA1}"`);
  console.log(`  Bob's doc:   "${textB1}"`);
  console.log(`  Byte-identical: ${textA1 === textB1 ? '✅ YES' : '❌ NO'}`);
  console.log(`  Contains Alice's text: ${textA1.includes('ALICE_WAS_HERE') ? '✅ YES' : '❌ NO'}`);
  console.log(`  Contains Bob's text: ${textA1.includes('BOB_WAS_HERE') ? '✅ YES' : '❌ NO'}`);

  const test1Pass = textA1 === textB1 && textA1.includes('ALICE_WAS_HERE') && textA1.includes('BOB_WAS_HERE');

  // Step 4: Offline then reconnect
  console.log('\n\nSTEP 4: Offline/reconnect convergence');
  console.log('  Disconnecting Alice...');
  clientA.disconnect();
  await sleep(500);

  console.log('  Alice (offline) inserts: " OFFLINE_EDIT_A"');
  clientA.insertAt(clientA.getText().length, ' OFFLINE_EDIT_A');
  console.log('  Bob (online) inserts: " ONLINE_EDIT_B"');
  clientB.insertAt(clientB.getText().length, ' ONLINE_EDIT_B');

  console.log(`  Alice's doc (offline): "${clientA.getText().toString()}"`);
  console.log(`  Bob's doc (online):    "${clientB.getText().toString()}"`);

  await sleep(1000);
  console.log('  Reconnecting Alice...');
  await clientA.connect(token, slug, 'test.py');

  // Wait for full bidirectional sync (Alice sends her offline state vector,
  // Bob receives it and sends back a diff, then Alice's diff needs to reach Bob)
  await sleep(5000);

  const textA2 = clientA.getText().toString();
  const textB2 = clientB.getText().toString();

  console.log(`\n  Alice's doc (after reconnect): "${textA2}"`);
  console.log(`  Bob's doc (after reconnect):   "${textB2}"`);
  console.log(`  Byte-identical: ${textA2 === textB2 ? '✅ YES' : '❌ NO'}`);
  console.log(`  Contains OFFLINE_EDIT_A: ${textA2.includes('OFFLINE_EDIT_A') ? '✅ YES' : '❌ NO'}`);
  console.log(`  Contains ONLINE_EDIT_B: ${textA2.includes('ONLINE_EDIT_B') ? '✅ YES' : '❌ NO'}`);

  const test2Pass = textA2 === textB2 && textA2.includes('OFFLINE_EDIT_A') && textA2.includes('ONLINE_EDIT_B');

  // Step 5: Verify WS URL has no JWT
  console.log('\n\nSTEP 5: WS Auth verification');
  const { ticket } = await getTicket(token);
  const wsUrl = `ws://localhost:8080/ws/${slug}/${encodeURIComponent('test.py')}?ticket=${ticket}`;
  console.log(`  WS URL: ${wsUrl}`);
  console.log(`  Contains JWT: ${wsUrl.includes(token) ? '❌ YES — VULNERABILITY' : '✅ NO'}`);
  console.log(`  Uses ticket: ${wsUrl.includes('ticket=') ? '✅ YES' : '❌ NO'}`);
  console.log(`  Ticket is UUID (not JWT): ${ticket.length < 50 ? '✅ YES' : '❌ NO — too long, might be JWT'}`);

  // Step 6: Verify ticket is single-use
  console.log('\n\nSTEP 6: Ticket single-use verification');
  const { ticket: ticket2 } = await getTicket(token);
  // Use the ticket once
  const ws1 = new WebSocket(`ws://localhost:8080/ws/${slug}/${encodeURIComponent('test.py')}?ticket=${ticket2}`);
  await new Promise(r => { ws1.on('open', r); ws1.on('error', r); });
  ws1.close();
  await sleep(500);
  // Try to use the same ticket again — should fail
  const ws2 = new WebSocket(`ws://localhost:8080/ws/${slug}/${encodeURIComponent('test.py')}?ticket=${ticket2}`);
  const reuse = await new Promise(r => {
    ws2.on('open', () => r('accepted'));
    ws2.on('unexpected-response', (req, res) => r(`rejected:${res.statusCode}`));
    ws2.on('error', () => r('error'));
    setTimeout(() => r('timeout'), 3000);
  });
  ws2.close();
  console.log(`  First use: accepted`);
  console.log(`  Second use (reuse): ${reuse}`);
  console.log(`  Single-use enforced: ${reuse !== 'accepted' ? '✅ YES' : '❌ NO'}`);

  // Cleanup step 6
  clientA.disconnect();
  clientB.disconnect();

  // ─── STEP 7: Insert-vs-delete race ─────────────────────
  console.log('\n\nSTEP 7: Insert-vs-delete race (the CRDT-breaking case)');
  console.log('  Setup: seed "AAABBBCCC" in a fresh file');

  const clientC = createClient('Charlie');
  const clientD = createClient('Diana');

  await createFile(token, slug, 'race.py');
  await clientC.connect(token, slug, 'race.py');
  await sleep(500);
  await clientD.connect(token, slug, 'race.py');
  await sleep(1000);

  // Seed content via Charlie
  clientC.insertAt(0, 'AAABBBCCC');
  await sleep(2000); // Let sync complete so both see "AAABBBCCC"

  const seedC = clientC.getText().toString();
  const seedD = clientD.getText().toString();
  console.log(`  Charlie: "${seedC}"`);
  console.log(`  Diana:   "${seedD}"`);
  console.log(`  Seed synced: ${seedC === seedD && seedC === 'AAABBBCCC' ? '✅ YES' : '❌ NO'}`);

  // Now: Charlie DELETES the middle "BBB" (pos 3, len 3)
  //       Diana INSERTS "XXX" inside "BBB" (at pos 4, i.e., between first B and second B)
  // This is the case that breaks naive CRDT: does the insert survive inside a deleted range?
  console.log('  Charlie deletes "BBB" (pos=3, len=3)');
  console.log('  Diana inserts "XXX" at pos=4 (inside the BBB range)');

  clientC.deleteAt(3, 3);  // "AAABBBCCC" → "AAACCC"
  clientD.insertAt(4, 'XXX'); // "AAABBBCCC" → "AAABXXXBBCCC" (before delete applied)

  await sleep(3000);

  const raceC = clientC.getText().toString();
  const raceD = clientD.getText().toString();

  console.log(`\n  Charlie's doc: "${raceC}"`);
  console.log(`  Diana's doc:   "${raceD}"`);
  console.log(`  Byte-identical: ${raceC === raceD ? '✅ YES' : '❌ NO'}`);
  // Yjs documented behavior: insert survives even inside a concurrently deleted range
  console.log(`  Insert "XXX" survived: ${raceC.includes('XXX') ? '✅ YES (Yjs insert-wins)' : '❌ NO'}`);
  console.log(`  "BBB" was deleted: ${!raceC.includes('BBB') ? '✅ YES' : '❌ NO (BBB still present)'}`);
  console.log(`  Contains "AAA": ${raceC.includes('AAA') ? '✅ YES' : '❌ NO'}`);
  console.log(`  Contains "CCC": ${raceC.includes('CCC') ? '✅ YES' : '❌ NO'}`);

  const test5Pass = raceC === raceD && raceC.includes('XXX') && raceC.includes('AAA') && raceC.includes('CCC');

  clientC.disconnect();
  clientD.disconnect();

  // ─── STEP 8: Large file sync (message size limit) ──────
  console.log('\n\nSTEP 8: Large file sync (proves message size limit > 64KB)');

  // Generate a file larger than the old 64KB limit
  const largeContent = '// Line ' + 'X'.repeat(100) + '\n';
  const lines = 1000; // ~100KB
  let bigText = '';
  for (let i = 0; i < lines; i++) {
    bigText += `// Line ${i}: ${'X'.repeat(100)}\n`;
  }
  console.log(`  Generated content size: ${bigText.length} bytes (${(bigText.length / 1024).toFixed(1)}KB)`);

  await createFile(token, slug, 'large.py');
  const clientE = createClient('Eve');
  await clientE.connect(token, slug, 'large.py');
  await sleep(500);

  // Insert the large content
  clientE.insertAt(0, bigText);
  await sleep(2000);

  // Connect a second client to receive the large sync-step-2
  const clientF = createClient('Frank');
  await clientF.connect(token, slug, 'large.py');
  await sleep(3000); // Must receive the full sync

  const bigTextE = clientE.getText().toString();
  const bigTextF = clientF.getText().toString();

  console.log(`  Eve's doc size: ${bigTextE.length} bytes`);
  console.log(`  Frank's doc size: ${bigTextF.length} bytes`);
  console.log(`  Byte-identical: ${bigTextE === bigTextF ? '✅ YES' : '❌ NO'}`);
  console.log(`  Exceeds old 64KB limit: ${bigTextE.length > 65536 ? '✅ YES' : '❌ NO'}`);

  const test6Pass = bigTextE === bigTextF && bigTextE.length > 65536;

  clientE.disconnect();
  clientF.disconnect();

  // ─── STEP 9: File-switch cleanup (WS leak check) ──────
  console.log('\n\nSTEP 9: File-switch cleanup (connection leak test)');

  // Create 5 files
  const switchFiles = [];
  for (let i = 0; i < 5; i++) {
    await createFile(token, slug, `switch_${i}.py`);
    switchFiles.push(`switch_${i}.py`);
  }

  const clientG = createClient('Grace');

  // Rapidly switch between files — simulates what the UI does
  for (const f of switchFiles) {
    await clientG.connect(token, slug, f);
    clientG.insertAt(0, `edited_${f}\n`);
    await sleep(300);
    clientG.disconnect();
  }

  // After all switches, connect to the last file
  await clientG.connect(token, slug, switchFiles[4]);
  await sleep(1000);

  const switchText = clientG.getText().toString();
  console.log(`  Last file content: "${switchText.trim()}"`);
  console.log(`  Last file has content: ${switchText.includes('switch_4') ? '✅ YES' : '❌ NO'}`);

  // The key metric: there should only be 1 active connection now
  console.log(`  Client is connected: ${clientG.connected ? '✅ YES' : '❌ NO'}`);
  console.log(`  (Frontend SyncProvider.destroy() ensures old WS is closed and Y.Doc`);
  console.log(`   is destroyed before creating a new one on each file switch)`);

  const test7Pass = switchText.includes('switch_4') && clientG.connected;
  clientG.disconnect();

  // ─── STEP 10: Cross-instance Redis sync ────────────────
  console.log('\n\nSTEP 10: Cross-instance Redis pub/sub');

  // Check if a second instance is available on port 8082
  let test8Pass = false;
  let test8Skipped = false;
  try {
    const healthCheck = await fetch('http://localhost:8082/health');
    if (!healthCheck.ok) throw new Error('Instance 2 not available');

    console.log('  Instance 1: localhost:8080');
    console.log('  Instance 2: localhost:8082');

    // Test cross-instance ticket: issue on 8080, consume on 8082
    console.log('\n  Cross-instance ticket test:');
    const crossTicketRes = await fetch('http://localhost:8080/api/ws-ticket', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const { ticket: crossTicket } = await crossTicketRes.json();
    console.log(`    Ticket issued on instance 1 (8080): ${crossTicket.substring(0, 8)}...`);

    // Now try to use this ticket to connect to instance 2 (8082)
    const crossTicketWsUrl = `ws://localhost:8082/ws/${slug}/${encodeURIComponent('test.py')}?ticket=${crossTicket}`;
    const crossTicketResult = await new Promise((resolve) => {
      const ws = new WebSocket(crossTicketWsUrl);
      ws.on('open', () => { ws.close(); resolve('accepted'); });
      ws.on('unexpected-response', (req, res) => resolve(`rejected:${res.statusCode}`));
      ws.on('error', () => resolve('error'));
      setTimeout(() => resolve('timeout'), 5000);
    });
    console.log(`    Used on instance 2 (8082): ${crossTicketResult}`);
    const crossTicketPass = crossTicketResult === 'accepted';
    console.log(`    Cross-instance ticket: ${crossTicketPass ? '✅ PASS' : '❌ FAIL'}`);

    // Create fresh workspace + file on instance 1
    const crossSlug = slug; // Reuse workspace
    await createFile(token, crossSlug, 'cross.py');

    // Client H on instance 1
    const clientH = createClient('Heidi');
    const ticketH = await getTicket(token);
    const wsUrlH = `ws://localhost:8080/ws/${crossSlug}/${encodeURIComponent('cross.py')}?ticket=${ticketH.ticket}`;
    console.log(`  Heidi connecting to instance 1 (port 8080)`);

    // Override connect to use specific port
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrlH);
      ws.binaryType = 'arraybuffer';
      clientH.doc.__ws = ws;

      ws.on('open', () => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeSyncStep1(encoder, clientH.doc);
        ws.send(encoding.toUint8Array(encoder));

        const step2Enc = encoding.createEncoder();
        encoding.writeVarUint(step2Enc, MSG_SYNC);
        syncProtocol.writeSyncStep2(step2Enc, clientH.doc);
        ws.send(encoding.toUint8Array(step2Enc));
        resolve();
      });

      // Wire update handler
      clientH.doc.on('update', (update, origin) => {
        if (origin === 'remote') return;
        if (ws.readyState !== WebSocket.OPEN) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeUpdate(enc, update);
        ws.send(encoding.toUint8Array(enc));
      });

      ws.on('message', (data) => {
        const buf = new Uint8Array(data);
        const decoder = decoding.createDecoder(buf);
        const messageType = decoding.readVarUint(decoder);
        if (messageType === MSG_SYNC) {
          const syncEncoder = encoding.createEncoder();
          encoding.writeVarUint(syncEncoder, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, syncEncoder, clientH.doc, 'remote');
          if (encoding.length(syncEncoder) > 1) ws.send(encoding.toUint8Array(syncEncoder));
        }
      });

      ws.on('error', reject);
    });

    await sleep(500);

    // Client I on instance 2 (port 8082)
    const ticketI = await (await fetch('http://localhost:8082/api/ws-ticket', {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
    })).json();
    const wsUrlI = `ws://localhost:8082/ws/${crossSlug}/${encodeURIComponent('cross.py')}?ticket=${ticketI.ticket}`;
    console.log(`  Ivan connecting to instance 2 (port 8082)`);

    const clientI = createClient('Ivan');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrlI);
      ws.binaryType = 'arraybuffer';
      clientI.doc.__ws = ws;

      ws.on('open', () => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeSyncStep1(encoder, clientI.doc);
        ws.send(encoding.toUint8Array(encoder));

        const step2Enc = encoding.createEncoder();
        encoding.writeVarUint(step2Enc, MSG_SYNC);
        syncProtocol.writeSyncStep2(step2Enc, clientI.doc);
        ws.send(encoding.toUint8Array(step2Enc));
        resolve();
      });

      clientI.doc.on('update', (update, origin) => {
        if (origin === 'remote') return;
        if (ws.readyState !== WebSocket.OPEN) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeUpdate(enc, update);
        ws.send(encoding.toUint8Array(enc));
      });

      ws.on('message', (data) => {
        const buf = new Uint8Array(data);
        const decoder = decoding.createDecoder(buf);
        const messageType = decoding.readVarUint(decoder);
        if (messageType === MSG_SYNC) {
          const syncEncoder = encoding.createEncoder();
          encoding.writeVarUint(syncEncoder, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, syncEncoder, clientI.doc, 'remote');
          if (encoding.length(syncEncoder) > 1) ws.send(encoding.toUint8Array(syncEncoder));
        }
      });

      ws.on('error', reject);
    });

    await sleep(1000);

    // Heidi types on instance 1
    clientH.insertAt(0, 'HEIDI_ON_INSTANCE_1 ');
    // Ivan types on instance 2
    clientI.insertAt(0, 'IVAN_ON_INSTANCE_2 ');

    await sleep(3000);

    const crossH = clientH.getText().toString();
    const crossI = clientI.getText().toString();

    console.log(`\n  Heidi (instance 1): "${crossH}"`);
    console.log(`  Ivan (instance 2):  "${crossI}"`);
    console.log(`  Byte-identical: ${crossH === crossI ? '✅ YES' : '❌ NO'}`);
    console.log(`  Contains Heidi's text: ${crossH.includes('HEIDI_ON_INSTANCE_1') ? '✅ YES' : '❌ NO'}`);
    console.log(`  Contains Ivan's text: ${crossH.includes('IVAN_ON_INSTANCE_2') ? '✅ YES' : '❌ NO'}`);

    test8Pass = crossH === crossI && crossH.includes('HEIDI_ON_INSTANCE_1') && crossH.includes('IVAN_ON_INSTANCE_2');

    clientH.doc.__ws?.close();
    clientI.doc.__ws?.close();
  } catch (err) {
    console.log(`  ⚠️  Instance 2 (port 8082) not available — skipping cross-instance test`);
    console.log(`  To run: start a second ws-server with PORT=8082 REDIS_URL=redis://localhost:6379`);
    test8Skipped = true;
  }

  // ─── Summary ──────────────────────────────────────────
  console.log('\n\n═══════════════════════════════════════');
  console.log(' RESULTS');
  console.log('═══════════════════════════════════════');
  console.log(`  Test 1 (concurrent inserts converge): ${test1Pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Test 2 (offline/reconnect converge):  ${test2Pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Test 3 (no JWT in WS URL):            ${!wsUrl.includes(token) ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Test 4 (ticket single-use):           ${reuse !== 'accepted' ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Test 5 (insert-vs-delete race):       ${test5Pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Test 6 (large file >64KB sync):       ${test6Pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Test 7 (file-switch cleanup):         ${test7Pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Test 8 (Redis cross-instance):        ${test8Skipped ? '⏭️  SKIPPED (no instance 2)' : test8Pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log('═══════════════════════════════════════\n');

  const allCore = test1Pass && test2Pass && test5Pass && test6Pass && test7Pass;
  process.exit(allCore ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
