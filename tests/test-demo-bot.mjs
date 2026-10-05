#!/usr/bin/env node
/**
 * Test Suite: Demo Bot (Ghost Collaborator) Verification
 *
 * Verifies:
 * 1. Server-side isolation (negative tests: bot cannot join/be invited into non-demo workspaces)
 * 2. Seed-lock protocol compliance (bot as first joiner acquires seed lock; no duplication)
 * 3. Solo-visitor live collaboration (bot joins, labeled presence badge, live character-by-character edits, screenshot)
 * 4. Three-party multi-user CRDT convergence (Alice + Bob + Demo Bot converge to exact byte-identical document)
 */

import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import fs from 'fs';
import path from 'path';
import { runDemoBot, getBotTicket } from '../services/demo-bot/bot.mjs';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const WS_HTTP_URL = process.env.WS_HTTP_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:8080';
const EVIDENCE_DIR = path.resolve('docs/evidence/phase-d');

function getChromiumLaunchOptions() {
  const defaultPath = chromium.executablePath();
  if (fs.existsSync(defaultPath)) {
    return { headless: true };
  }
  const fallbackPath = '/Users/devmangukiya/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  if (fs.existsSync(fallbackPath)) {
    return { executablePath: fallbackPath, headless: true };
  }
  return { headless: true };
}

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

async function api(method, endpoint, body, jar, csrfToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar) headers['Cookie'] = jar.toString();
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const resp = await fetch(`${WS_HTTP_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (jar) jar.parseSetCookies(resp.headers);
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

async function signupUser(usernamePrefix) {
  const id = Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000);
  const username = `${usernamePrefix}_${id}`;
  const email = `${username}@syncspace.test`;
  const jar = new CookieJar();

  const res = await api('POST', '/api/auth/signup', {
    username,
    email,
    password: 'UserSecret2026!',
  }, jar);

  if (res.status !== 201) {
    throw new Error(`Failed to signup ${username}: ${JSON.stringify(res.data)}`);
  }

  return {
    username,
    email,
    jar,
    csrfToken: res.data.csrf_token,
    user: res.data.user,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' DEMO BOT (GHOST COLLABORATOR) PROOF SUITE');
  console.log(` WS Server: ${WS_HTTP_URL} | Frontend: ${APP_URL}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS — ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL — ${message}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. NEGATIVE TESTS: Server-Side Enforcement (Non-Demo Workspace)
  // ─────────────────────────────────────────────────────────────
  console.log('─── 1. NEGATIVE TEST: Server-Side Bot Isolation ───');
  const alice = await signupUser('alice');

  // Create normal non-demo workspace
  const nonDemoWsRes = await api('POST', '/api/workspaces', {
    name: 'Standard Private Workspace',
    is_demo: false,
    template: 'python',
  }, alice.jar, alice.csrfToken);

  assert(nonDemoWsRes.status === 201, 'Created non-demo workspace');
  assert(nonDemoWsRes.data.is_demo === false, 'Confirmed is_demo is false');
  const nonDemoSlug = nonDemoWsRes.data.slug;

  // NEW: Prove is_demo is NOT client-settable — request with is_demo:true is silently ignored
  const sneakyDemoRes = await api('POST', '/api/workspaces', {
    name: 'Sneaky Demo Attempt',
    is_demo: true,
    template: 'python',
  }, alice.jar, alice.csrfToken);

  assert(sneakyDemoRes.status === 201, 'is_demo:true in request body was accepted (field is ignored, not rejected)');
  assert(
    sneakyDemoRes.data.is_demo === false,
    `is_demo was silently ignored — workspace has is_demo=${sneakyDemoRes.data.is_demo} (expected false). ` +
    'Rationale: is_demo is excluded from the request schema; only the owner-only SetDemo endpoint can toggle it.'
  );
  // Clean up the sneaky workspace
  await api('DELETE', `/api/workspaces/${sneakyDemoRes.data.slug}`, null, alice.jar, alice.csrfToken);

  // Attempt to invite demo-bot into non-demo workspace
  const inviteRes = await api('POST', `/api/workspaces/${nonDemoSlug}/members`, {
    identifier: 'demo-bot@syncspace.internal',
    role: 'editor',
  }, alice.jar, alice.csrfToken);

  assert(
    inviteRes.status === 403,
    `Server rejected inviting demo-bot to non-demo workspace (HTTP ${inviteRes.status})`
  );
  assert(
    JSON.stringify(inviteRes.data).includes('forbidden') || JSON.stringify(inviteRes.data).includes('demo bot'),
    `Server returned expected forbidden reason: ${JSON.stringify(inviteRes.data)}`
  );

  // Attempt direct WebSocket connection as demo-bot to non-demo workspace
  const botJar = new CookieJar();
  const botLoginRes = await api('POST', '/api/auth/login', {
    email: 'demo-bot@syncspace.internal',
    password: 'DemoBotSecret2026!',
  }, botJar);
  assert(botLoginRes.status === 200, 'Authenticated under demo-bot account');

  const botTicketRes = await api('POST', '/api/ws-ticket', {}, botJar, botLoginRes.data.csrf_token);
  assert(botTicketRes.status === 200 && botTicketRes.data.ticket, 'Obtained single-use WS ticket for demo-bot');

  const wsDirectRes = await fetch(`${WS_HTTP_URL}/ws/${nonDemoSlug}/app.py?ticket=${botTicketRes.data.ticket}`);
  assert(
    wsDirectRes.status === 403,
    `Server rejected WebSocket connection to non-demo workspace (HTTP ${wsDirectRes.status})`
  );

  // ─────────────────────────────────────────────────────────────
  // 2. SEED-LOCK / FIRST-JOINER TEST: Bot Respects Seed Lock
  // ─────────────────────────────────────────────────────────────
  console.log('\n─── 2. SEED-LOCK TEST: Bot As First Joiner ───');
  const demoWsRes = await api('POST', '/api/workspaces', {
    name: 'Demo Seed Lock Room',
    template: 'python',
  }, alice.jar, alice.csrfToken);
  // Enable demo mode via owner-only SetDemo endpoint (is_demo is not client-settable at creation)
  await api('POST', `/api/workspaces/${demoWsRes.data.slug}/demo`, { is_demo: true }, alice.jar, alice.csrfToken);

  assert(demoWsRes.status === 201, 'Created workspace then enabled demo via SetDemo endpoint');
  const demoSlug = demoWsRes.data.short_id || demoWsRes.data.slug;

  // Bot joins FIRST into the empty room
  const seedTemplate = `def convert_temperature(val, unit):\n    return (val * 5 / 9) + 32\n`;
  let botSawSeedGrant = false;

  const firstJoinerBot = await runDemoBot({
    httpUrl: WS_HTTP_URL,
    wsUrl: WS_URL,
    workspaceSlug: demoSlug,
    filePath: 'app.py',
    seedContentIfGranted: seedTemplate,
    onStep: (step) => {
      if (step.step === 'seed_granted_and_applied') {
        botSawSeedGrant = true;
      }
    }
  });

  await new Promise(r => setTimeout(r, 600));
  assert(firstJoinerBot.canSeed() || botSawSeedGrant, 'Demo Bot acquired seed lock as first joiner');
  assert(firstJoinerBot.ytext.toString().includes('convert_temperature'), 'Bot seeded initial content successfully');

  // Real client Alice connects SECOND
  const aliceTicketRes = await api('POST', '/api/ws-ticket', {}, alice.jar, alice.csrfToken);
  const aliceWs = new WebSocket(`${WS_URL}/ws/${demoSlug}/app.py?ticket=${aliceTicketRes.data.ticket}`);
  aliceWs.binaryType = 'arraybuffer';

  const aliceDoc = new Y.Doc();
  let aliceSawSeedGrant = false;

  aliceWs.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'seed_grant') aliceSawSeedGrant = true;
      } catch {}
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const msgType = decoding.readVarUint(decoder);
    if (msgType === 0) {
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, 0);
      syncProtocol.readSyncMessage(decoder, syncEncoder, aliceDoc, aliceWs);
      if (encoding.length(syncEncoder) > 1) aliceWs.send(encoding.toUint8Array(syncEncoder));
    }
  });

  await new Promise(r => {
    aliceWs.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, aliceDoc);
      aliceWs.send(encoding.toUint8Array(enc));
      setTimeout(r, 800);
    });
  });

  assert(!aliceSawSeedGrant, 'Alice (second joiner) did NOT receive seed_grant (seed lock respected)');
  assert(
    aliceDoc.getText('content').toString() === firstJoinerBot.ytext.toString(),
    'Alice document synced cleanly from Bot seeder without duplication'
  );

  aliceWs.close();
  firstJoinerBot.disconnect();

  // ─────────────────────────────────────────────────────────────
  // 3. SOLO-VISITOR TEST (Playwright Browser + Screenshot)
  // ─────────────────────────────────────────────────────────────
  console.log('\n─── 3. SOLO-VISITOR TEST: Browser UI & Live Bot Edits ───');
  const browser = await chromium.launch(getChromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // Create workspace then enable demo mode via SetDemo endpoint
  const visitorWsRes = await api('POST', '/api/workspaces', {
    name: 'Temperature Bug Demo',
    template: 'python',
  }, alice.jar, alice.csrfToken);
  await api('POST', `/api/workspaces/${visitorWsRes.data.slug}/demo`, { is_demo: true }, alice.jar, alice.csrfToken);

  const visitorShortId = visitorWsRes.data.short_id;
  console.log(`  Demo workspace created: /w/${visitorShortId}`);

  // Inject session cookies into Playwright context
  const cookiesToAdd = Object.entries(alice.jar.cookies).map(([name, value]) => ({
    name,
    value,
    domain: 'localhost',
    path: '/',
    httpOnly: name.includes('access') || name.includes('refresh'),
    sameSite: 'Lax',
  }));
  await context.addCookies(cookiesToAdd);

  const page = await context.newPage();
  await page.goto(`${APP_URL}/w/${visitorShortId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Click app.py if needed
  try {
    const fileItem = page.locator('text=app.py').first();
    if (await fileItem.isVisible({ timeout: 3000 })) {
      await fileItem.click();
    }
  } catch {}
  await page.waitForTimeout(1000);

  // Check initial editor content
  const initialText = await page.evaluate(() => {
    return window.monaco?.editor?.getModels()?.[0]?.getValue() || '';
  });
  assert(initialText.includes('5 / 9'), 'Editor initialized with temperature bug (5 / 9)');

  // Wait for Demo Bot to join workspace
  console.log('  Waiting for Demo Bot to join workspace...');
  await page.waitForSelector('#bot-presence-badge', { timeout: 10000 });
  const badgeVisible = await page.isVisible('#bot-presence-badge');
  assert(badgeVisible, 'Bot presence badge [🤖 Demo Bot (BOT)] rendered prominently in header');

  // Verify status bar shows bot presence
  const statusText = await page.locator('#workspace-status-bar').textContent();
  assert(statusText.includes('Demo Bot'), `Status bar displays bot collaborator: "${statusText.trim()}"`);

  // Wait for in-progress typing and capture screenshot
  await page.waitForTimeout(1200);
  const screenshotPath = path.join(EVIDENCE_DIR, 'demo_bot_solo_visitor.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`  📸 Screenshot saved: ${screenshotPath}`);

  // Wait for bot edit to complete in Monaco editor
  await page.waitForFunction(() => {
    const val = window.monaco?.editor?.getModels()?.[0]?.getValue() || '';
    return val.includes('9 / 5') && val.includes('Fixed by Demo Bot');
  }, { timeout: 15000 });

  const finalText = await page.evaluate(() => {
    return window.monaco?.editor?.getModels()?.[0]?.getValue() || '';
  });

  assert(finalText.includes('9 / 5'), 'Monaco editor model updated live with bot fix (9 / 5)');
  assert(finalText.includes('# Fixed by Demo Bot'), 'Monaco editor model includes bot comment');

  await context.close();

  // ─────────────────────────────────────────────────────────────
  // 4. THREE-PARTY TEST: Real Multi-User CRDT Convergence
  // ─────────────────────────────────────────────────────────────
  console.log('\n─── 4. THREE-PARTY TEST: Bot + Alice + Bob Convergence ───');
  const bob = await signupUser('bob');

  // Create workspace then enable demo mode via SetDemo endpoint
  const triadWsRes = await api('POST', '/api/workspaces', {
    name: 'Three-Party CRDT Convergence Demo',
    template: 'python',
  }, alice.jar, alice.csrfToken);
  await api('POST', `/api/workspaces/${triadWsRes.data.slug}/demo`, { is_demo: true }, alice.jar, alice.csrfToken);

  const triadShortId = triadWsRes.data.short_id;

  // Enroll Bob as editor
  await api('POST', `/api/workspaces/${triadShortId}/members`, {
    identifier: bob.email,
    role: 'editor',
  }, alice.jar, alice.csrfToken);

  // Browser Context Alice
  const ctxAlice = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctxAlice.addCookies(cookiesToAdd);
  const pageAlice = await ctxAlice.newPage();
  await pageAlice.goto(`${APP_URL}/w/${triadShortId}`, { waitUntil: 'networkidle' });
  await pageAlice.waitForTimeout(1500);

  // Browser Context Bob
  const bobCookiesToAdd = Object.entries(bob.jar.cookies).map(([name, value]) => ({
    name,
    value,
    domain: 'localhost',
    path: '/',
    httpOnly: name.includes('access') || name.includes('refresh'),
    sameSite: 'Lax',
  }));
  const ctxBob = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctxBob.addCookies(bobCookiesToAdd);
  const pageBob = await ctxBob.newPage();
  await pageBob.goto(`${APP_URL}/w/${triadShortId}`, { waitUntil: 'networkidle' });
  await pageBob.waitForTimeout(1500);

  // Verify both Alice and Bob see Demo Bot badge
  await pageAlice.waitForSelector('#bot-presence-badge', { timeout: 10000 });
  await pageBob.waitForSelector('#bot-presence-badge', { timeout: 10000 });
  assert(true, 'Both Alice and Bob browser contexts observe Demo Bot presence badge');

  // Alice inserts header docstring
  const aliceInsert = `"""SyncSpace Collaborative Triad Test Suite."""\n`;
  await pageAlice.evaluate((text) => {
    const model = window.monaco.editor.getModels()[0];
    model.applyEdits([{ range: new window.monaco.Range(1, 1, 1, 1), text }]);
  }, aliceInsert);

  // Bob inserts footer comment
  const bobInsert = `\n# End of collaborative triad verification\n`;
  await pageBob.evaluate((text) => {
    const model = window.monaco.editor.getModels()[0];
    const lineCount = model.getLineCount();
    const lastCol = model.getLineMaxColumn(lineCount);
    model.applyEdits([{ range: new window.monaco.Range(lineCount, lastCol, lineCount, lastCol), text }]);
  }, bobInsert);

  // Wait for bot edit to complete
  await pageAlice.waitForFunction(() => {
    const val = window.monaco?.editor?.getModels()?.[0]?.getValue() || '';
    return val.includes('9 / 5') && val.includes('Fixed by Demo Bot');
  }, { timeout: 15000 });

  // Connect a separate Y.Doc WebSocket client as bot to inspect CRDT convergence directly
  const botTicket = await getBotTicket(WS_HTTP_URL);
  const botWs = new WebSocket(`${WS_URL}/ws/${triadShortId}/app.py?ticket=${botTicket}`);
  botWs.binaryType = 'arraybuffer';
  const botDoc = new Y.Doc();

  botWs.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const msgType = decoding.readVarUint(decoder);
    if (msgType === 0) {
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, 0);
      syncProtocol.readSyncMessage(decoder, syncEncoder, botDoc, botWs);
      if (encoding.length(syncEncoder) > 1) botWs.send(encoding.toUint8Array(syncEncoder));
    }
  });

  await new Promise(r => {
    botWs.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, botDoc);
      botWs.send(encoding.toUint8Array(enc));
      setTimeout(r, 2000);
    });
  });

  const textInAlice = await pageAlice.evaluate(() => window.monaco.editor.getModels()[0].getValue());
  const textInBob = await pageBob.evaluate(() => window.monaco.editor.getModels()[0].getValue());
  const textInBot = botDoc.getText('content').toString();

  assert(textInAlice.includes('SyncSpace Collaborative Triad Test Suite'), 'Alice insert propagated to Alice');
  assert(textInBob.includes('SyncSpace Collaborative Triad Test Suite'), 'Alice insert propagated to Bob');
  assert(textInBot.includes('SyncSpace Collaborative Triad Test Suite'), 'Alice insert propagated to Bot');

  assert(textInAlice.includes('End of collaborative triad verification'), 'Bob insert propagated to Alice');
  assert(textInBob.includes('End of collaborative triad verification'), 'Bob insert propagated to Bob');
  assert(textInBot.includes('End of collaborative triad verification'), 'Bob insert propagated to Bot');

  assert(textInAlice.includes('9 / 5') && textInAlice.includes('Fixed by Demo Bot'), 'Bot fix propagated to Alice');
  assert(textInBob.includes('9 / 5') && textInBob.includes('Fixed by Demo Bot'), 'Bot fix propagated to Bob');
  assert(textInBot.includes('9 / 5') && textInBot.includes('Fixed by Demo Bot'), 'Bot fix verified in Bot CRDT state');

  assert(
    textInAlice === textInBob && textInBob === textInBot,
    `Three-way CRDT convergence: Alice (${textInAlice.length}b), Bob (${textInBob.length}b), Bot (${textInBot.length}b) are BYTE-IDENTICAL`
  );

  const screenshot3Path = path.join(EVIDENCE_DIR, 'demo_bot_three_party.png');
  await pageAlice.screenshot({ path: screenshot3Path });
  console.log(`  📸 Three-party screenshot saved: ${screenshot3Path}`);

  botWs.close();
  await browser.close();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(` RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
