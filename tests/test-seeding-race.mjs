#!/usr/bin/env node
/**
 * Test Seeding Race Condition Reproduction
 * ─────────────────────────────────────────
 * Tests 2, 3, and 5 isolated browser contexts opening the same file
 * with existing content simultaneously via Promise.all.
 *
 * Asserts:
 *  - Final editor text equals database content EXACTLY ONCE (no duplication).
 *  - Database persisted content remains unchanged.
 */

import { chromium } from '@playwright/test';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const WS_URL  = process.env.WS_URL  || 'http://localhost:8080';

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

async function req(method, endpoint, body, jar, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (jar) headers['Cookie'] = jar.toString();
  const resp = await fetch(`${APP_URL}${endpoint}`, {
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

async function runSeedingTest(browser, numClients) {
  console.log(`\n───────────────────────────────────────────────────────────────`);
  console.log(` TESTING SEEDING CONCURRENCY WITH ${numClients} CONTEXTS`);
  console.log(`───────────────────────────────────────────────────────────────`);

  const ts = Date.now();
  const jar = new CookieJar();
  const initialContent = `# Seeded Content ${ts}\ndef compute():\n    return 42\n`;

  // 1. Create user, workspace, and seeded file
  const user = `seed_u${numClients}_${ts}`;
  await req('POST', '/api/auth/signup', {
    username: user, email: `${user}@test.com`, password: 'Password123!',
  }, jar);

  const csrf = jar.get('syncspace_csrf');
  const ws = await req('POST', '/api/workspaces', {
    name: `SeedWS-${numClients}-${ts}`,
    language: 'python',
    template: 'blank',
  }, jar, { 'X-CSRF-Token': csrf });

  const shortId = ws.data.short_id;
  const fileName = 'calc.py';

  await req('POST', `/api/workspaces/${shortId}/file`, {
    path: fileName,
    content: initialContent,
  }, jar, { 'X-CSRF-Token': csrf });

  console.log(`  Workspace: ${shortId}, File: ${fileName}`);
  console.log(`  Initial length: ${initialContent.length} chars`);

  // 2. Open N isolated browser contexts simultaneously
  const contexts = [];
  const pages = [];

  for (let i = 0; i < numClients; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const cookiesToAdd = Object.entries(jar.cookies).map(([name, value]) => ({
      name, value, domain: 'localhost', path: '/',
      httpOnly: name.includes('access') || name.includes('refresh') || name.includes('token'),
      sameSite: 'Lax',
    }));
    await ctx.addCookies(cookiesToAdd);
    contexts.push(ctx);
    pages.push(await ctx.newPage());
  }

  console.log(`  Navigating ${numClients} pages simultaneously via Promise.all...`);
  await Promise.all(pages.map(p => p.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'domcontentloaded' })));

  // Select file on each page if needed and wait for Monaco
  await Promise.all(pages.map(async (p, idx) => {
    try {
      await p.waitForSelector('.monaco-editor', { timeout: 30000 });
    } catch (err) {
      console.log(`  Page ${idx + 1} URL: ${p.url()}`);
      const body = await p.evaluate(() => document.body.innerText).catch(() => '');
      console.log(`  Page ${idx + 1} Body:\n${body.slice(0, 200)}`);
      throw err;
    }
    try {
      const fileTab = p.locator(`text=${fileName}`).first();
      if (await fileTab.isVisible({ timeout: 3000 })) {
        await fileTab.click();
      }
    } catch {}
  }));

  // Allow CRDT sync cycles to settle
  await new Promise(r => setTimeout(r, 3000));

  // 3. Inspect final text in each editor
  const editorTexts = await Promise.all(pages.map(p =>
    p.evaluate(() => {
      const ed = (window).monaco?.editor?.getEditors?.()[0];
      return ed?.getValue() || '';
    })
  ));

  let failed = false;
  for (let i = 0; i < numClients; i++) {
    const text = editorTexts[i];
    const occurrences = (text.match(/def compute/g) || []).length;
    console.log(`  Context ${i + 1}: length=${text.length}, "def compute" count=${occurrences}`);
    if (occurrences !== 1 || text !== initialContent) {
      console.log(`  ❌ Context ${i + 1} HAS DUPLICATED / CORRUPTED CONTENT!`);
      console.log(`     Got:\n${text}`);
      failed = true;
    }
  }

  // 4. Inspect DB content
  const dbFile = await req('GET', `/api/workspaces/${shortId}/file?path=${encodeURIComponent(fileName)}`, null, jar);
  const dbContent = dbFile.data?.content || '';
  const dbOccurrences = (dbContent.match(/def compute/g) || []).length;
  console.log(`  Database persisted content count: ${dbOccurrences}`);

  for (const ctx of contexts) {
    await ctx.close();
  }

  if (failed || dbOccurrences !== 1) {
    throw new Error(`Seeding race detected with ${numClients} clients: content duplicated (occurrences=${dbOccurrences})`);
  }

  console.log(`  ✅ ${numClients} contexts converged cleanly with exact single instance of content.`);
}

async function testOfflineReconnectAfterRoomReset(browser) {
  console.log(`\n───────────────────────────────────────────────────────────────`);
  console.log(` TESTING OFFLINE RECONNECT AFTER ROOM RESET (OPTION A PROOF)`);
  console.log(`───────────────────────────────────────────────────────────────`);

  const ts = Date.now();
  const jar = new CookieJar();
  const initialContent = `# Baseline Content ${ts}\ndef main():\n    return 100\n`;

  const user = `seed_off_${ts}`;
  await req('POST', '/api/auth/signup', {
    username: user, email: `${user}@test.com`, password: 'Password123!',
  }, jar);

  const csrf = jar.get('syncspace_csrf');
  const ws = await req('POST', '/api/workspaces', {
    name: `SeedOff-${ts}`,
    language: 'python',
    template: 'blank',
  }, jar, { 'X-CSRF-Token': csrf });

  const shortId = ws.data.short_id;
  const fileName = 'app.py';

  await req('POST', `/api/workspaces/${shortId}/file`, {
    path: fileName,
    content: initialContent,
  }, jar, { 'X-CSRF-Token': csrf });

  const cookiesToAdd = Object.entries(jar.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/',
    httpOnly: name.includes('access') || name.includes('refresh') || name.includes('token'),
    sameSite: 'Lax',
  }));

  // Context A opens
  const ctxA = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await ctxA.addCookies(cookiesToAdd);
  const pageA = await ctxA.newPage();
  await pageA.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'networkidle' });
  await pageA.waitForSelector('.monaco-editor', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  // Client A goes offline (disconnect network)
  console.log(`  Client A goes offline...`);
  await ctxA.setOffline(true);
  await new Promise(r => setTimeout(r, 1000));

  // Client A types local edit while offline
  console.log(`  Client A makes offline edits in Monaco...`);
  await pageA.evaluate(() => {
    const ed = (window).monaco?.editor?.getEditors?.()[0];
    if (ed) {
      const val = ed.getValue();
      ed.setValue(`# Offline Modification\n` + val);
    }
  });

  // Client A closes page (simulating browser close or disconnect)
  // Now room is empty on server. Server room empties and resets seed lock.
  await pageA.close();
  console.log(`  Client A page closed. Waiting for ws-server room cleanup and seed lock release...`);
  await new Promise(r => setTimeout(r, 4000));

  // Context B opens while room was empty
  console.log(`  Client B opens room fresh...`);
  const ctxB = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await ctxB.addCookies(cookiesToAdd);
  const pageB = await ctxB.newPage();
  await pageB.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('.monaco-editor', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  const textB = await pageB.evaluate(() => {
    const ed = (window).monaco?.editor?.getEditors?.()[0];
    return ed?.getValue() || '';
  });
  console.log(`  Client B initial loaded content length: ${textB.length}`);

  // Now Client A comes back online in a new page within ctxA (or ctxA reconnected)
  console.log(`  Client A reconnects online...`);
  await ctxA.setOffline(false);
  const pageAReconnect = await ctxA.newPage();
  await pageAReconnect.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'domcontentloaded' });
  await pageAReconnect.waitForSelector('.monaco-editor', { timeout: 15000 });

  // Wait for sync convergence with polling
  let synced = false;
  let finalA = '';
  let finalB = '';
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    finalA = await pageAReconnect.evaluate(() => (window).monaco?.editor?.getEditors?.()[0]?.getValue() || '');
    finalB = await pageB.evaluate(() => (window).monaco?.editor?.getEditors?.()[0]?.getValue() || '');
    if (finalA.length > 0 && finalA === finalB) {
      synced = true;
      break;
    }
  }

  console.log(`  Final Text A length: ${finalA.length}`);
  console.log(`  Final Text B length: ${finalB.length}`);

  const occurrencesA = (finalA.match(/def main/g) || []).length;
  const occurrencesB = (finalB.match(/def main/g) || []).length;
  console.log(`  Occurrences in A: ${occurrencesA}, B: ${occurrencesB}`);

  await ctxA.close();
  await ctxB.close();

  if (occurrencesA !== 1 || occurrencesB !== 1 || finalA !== finalB) {
    throw new Error(`Offline reconnect convergence failed: A(${occurrencesA}) vs B(${occurrencesB}), match=${finalA === finalB}`);
  }

  console.log(`  ✅ Offline-reconnect-after-room-reset converged cleanly! Both clients identical, no duplicated seed.`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' SEEDING RACE CONDITION TEST (2, 3, 5 CONTEXTS)');
  console.log('═══════════════════════════════════════════════════════════════');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    await runSeedingTest(browser, 2);
    await runSeedingTest(browser, 3);
    await runSeedingTest(browser, 5);
    await testOfflineReconnectAfterRoomReset(browser);
    console.log('\n✅ All seeding race tests PASSED!');
    console.log(' RESULTS: 4 passed, 0 failed, 0 skipped\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED AS EXPECTED (REPRODUCED):', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
