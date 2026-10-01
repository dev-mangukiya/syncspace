#!/usr/bin/env node
/**
 * C.6 Verification Follow-up:
 * 1. Sync Status Honesty Under Real Failure:
 *    - Kill WS server on port 8080
 *    - Load workspace in browser
 *    - Verify status bar NEVER shows "Synced" (shows Offline / Connecting)
 *    - Restart WS server
 *    - Verify status bar transitions to "Synced"
 * 
 * 2. ⌘K Double-Fire Test:
 *    - Rapidly press ⌘K twice
 *    - Verify clean open -> clean close without double-toggle or flicker
 *    - Rapidly press ⌘K 4 times: open -> close -> open -> close
 */

import { chromium } from '@playwright/test';
import { spawn, execSync } from 'child_process';
import path from 'path';

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

async function req(method, endpoint, body, jar, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (jar) headers['Cookie'] = jar.toString();
  const resp = await fetch(`${BASE}${endpoint}`, {
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
  console.log('═══════════════════════════════════════════════════════');
  console.log(' C.6 FOLLOWUP: SYNC FAILURE HONESTY & ⌘K DOUBLE-FIRE');
  console.log('═══════════════════════════════════════════════════════\n');

  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  // Setup: Create user & workspace
  console.log('1. SETUP: Create User & Workspace');
  const jar = new CookieJar();
  const signup = await req('POST', '/api/auth/signup', {
    username: `honesty_${ts}`,
    email: `honesty_${ts}@test.com`,
    password: 'TestPassword123!',
  }, jar);
  assert('User created', signup.status === 201);
  const csrf = jar.get('syncspace_csrf');

  const ws = await req('POST', '/api/workspaces', { name: `HonestyWorkspace-${ts}` }, jar, {
    'X-CSRF-Token': csrf,
  });
  assert('Workspace created', ws.status === 201);
  const shortId = ws.data.short_id;
  console.log(`  short_id: ${shortId}\n`);

  // Launch browser with cookies
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const cookiesToAdd = Object.entries(jar.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: name.includes('access') || name.includes('refresh'), sameSite: 'Lax',
  }));
  await context.addCookies(cookiesToAdd);

  const page = await context.newPage();

  // Test 1: Normal connection under healthy server
  console.log('2. HEALTHY SERVER CHECK');
  await page.goto(`${BASE}/w/${shortId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const footer = page.locator('footer');
  let footerText = await footer.innerText();
  console.log(`  Footer with WS server running: "${footerText.replace(/\n/g, ' | ')}"`);
  assert('Status bar shows "Synced" when WS server is healthy', footerText.includes('Synced'));
  console.log();

  // Test 2: Double-fire ⌘K test with Monaco focused
  console.log('3. ⌘K DOUBLE-FIRE / RAPID TOGGLE TEST');
  const monacoEditor = page.locator('.monaco-editor').first();
  await monacoEditor.waitFor({ state: 'visible' });
  await monacoEditor.click();
  await page.waitForTimeout(200);

  const paletteInput = page.locator('input[placeholder*="Type a file name"]');

  // Test rapid double-tap: Press 1 -> open, Press 2 -> close
  console.log('  Testing rapid ⌘K double press: open then close...');
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(100);
  const openAfterFirst = await paletteInput.isVisible();
  assert('Palette opened on first ⌘K', openAfterFirst);

  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(200);
  const closedAfterSecond = !(await paletteInput.isVisible());
  assert('Palette closed cleanly on second ⌘K (no double-fire / flicker)', closedAfterSecond);

  // Test 4 rapid presses: open -> close -> open -> close
  console.log('  Testing 4 rapid consecutive ⌘K presses:');
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(100);
  assert('Toggle 1 (open): visible', await paletteInput.isVisible());

  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(100);
  assert('Toggle 2 (close): hidden', !(await paletteInput.isVisible()));

  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(100);
  assert('Toggle 3 (open): visible', await paletteInput.isVisible());

  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(100);
  assert('Toggle 4 (close): hidden', !(await paletteInput.isVisible()));
  console.log();

  // Test 3: Stop WS server & test sync status honesty
  console.log('4. SYNC STATUS HONESTY UNDER REAL FAILURE');
  console.log('  Stopping WS server (pkill -f bin/ws-server)...');
  try { execSync('pkill -f "bin/ws-server"'); } catch {}
  await page.waitForTimeout(800);

  // Sample footer status over 2.5 seconds (way past the 400ms solitary fallback!)
  console.log('  Sampling status bar over 2500ms with WS server DOWN...');
  let falselySynced = false;
  const samples = [];
  for (let t = 0; t < 5; t++) {
    await page.waitForTimeout(500);
    const text = await footer.innerText();
    const cleanText = text.replace(/\n/g, ' | ');
    samples.push(cleanText);
    if (cleanText.includes('Synced')) {
      falselySynced = true;
    }
  }

  console.log('  Observed status bar samples with server DOWN:');
  samples.forEach((s, idx) => console.log(`    sample ${(idx + 1) * 500}ms: "${s}"`));

  assert('Status bar NEVER falsely flipped to "Synced" while server is down', !falselySynced);
  const finalFailureText = samples[samples.length - 1];
  assert('Status bar correctly displays "Offline" or "Connecting" under failure',
    finalFailureText.includes('Offline') || finalFailureText.includes('Connecting'));
  console.log();

  // Test 4: Restart WS server & observe recovery
  console.log('5. RECOVERY VERIFICATION: Restart WS server');
  console.log('  Restarting ws-server binary on :8080...');
  const wsProc = spawn('./bin/ws-server', [], {
    cwd: '/Users/devmangukiya/.gemini/antigravity-ide/scratch/syncspace/ws-server',
    env: {
      ...process.env,
      CORS_ORIGIN: 'http://localhost:3000',
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'syncspace',
      POSTGRES_PASSWORD: 'syncspace_dev',
      POSTGRES_DB: 'syncspace',
      JWT_SECRET: 'dev-jwt-secret-change-in-production',
      PORT: '8080',
      REDIS_URL: 'redis://localhost:6379',
    },
    detached: true,
    stdio: 'ignore',
  });
  wsProc.unref();
  await page.waitForTimeout(2000);

  // Wait for reconnect (provider reconnects every 2000ms)
  console.log('  Waiting for automatic reconnection...');
  let recovered = false;
  let recoveredFooter = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(1000);
    recoveredFooter = await footer.innerText();
    if (recoveredFooter.includes('Synced')) {
      recovered = true;
      break;
    }
  }
  console.log(`  Recovered footer: "${recoveredFooter.replace(/\n/g, ' | ')}"`);
  assert('Status bar recovered to "Synced" after server restart', recovered);
  assert('Peer count shows 1 online after recovery', recoveredFooter.includes('1 online'));

  await browser.close();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
