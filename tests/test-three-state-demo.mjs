#!/usr/bin/env node
/**
 * Continuous Three-State AI Demo
 * ──────────────────────────────
 * One Playwright run through the UI:
 *   1. New demo workspace with seeded failing check
 *   2. Run → Assert visible failing check (State 1: Exit 1, 4/5 passed, 1 failed)
 *      Screenshot: step1_failing_run.png
 *   3. AI Fix:
 *      - If rotated Groq key is not yet confirmed by Dev, SKIP the AI request step
 *        and apply the code fix via editor to complete the three-state loop.
 *      - If key is available, ask AI to fix, assert no reasoning tags, click Apply to Editor.
 *      Screenshot: step2_ai_apply.png
 *   4. Run → Assert passing check (State 3: Exit 0, 5/5 passed)
 *      Screenshot: step3_passing_run.png
 */

import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACTS_DIR = '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45';

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

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(label, cond) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' CONTINUOUS THREE-STATE DEMO (PLAYWRIGHT)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const ts = Date.now();
  const jar = new CookieJar();

  // 1. Setup user + workspace
  console.log('1. SETUP: Creating user and Python demo workspace...');
  const signup = await req('POST', '/api/auth/signup', {
    username: `demo_${ts}`,
    email: `demo_${ts}@test.com`,
    password: 'DemoPassword123!',
  }, jar);
  assert('User registered', signup.status === 201);

  const csrf = jar.get('syncspace_csrf');
  const ws = await req('POST', '/api/workspaces', {
    name: `Demo-Workspace-${ts}`,
    language: 'python',
    template: 'python',
  }, jar, { 'X-CSRF-Token': csrf });
  assert('Workspace created', ws.status === 201);

  const shortId = ws.data.short_id;
  console.log(`  Workspace: ${shortId} (${ws.data.slug})\n`);

  // Launch browser
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cookiesToAdd = Object.entries(jar.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: name.includes('access') || name.includes('refresh'), sameSite: 'Lax',
  }));
  await context.addCookies(cookiesToAdd);

  const page = await context.newPage();
  await page.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.monaco-editor', { timeout: 15000 });
  await page.waitForTimeout(2000);

  // 2. STATE 1: First Run (Planted Bug Failing Check)
  console.log('2. STATE 1: RUN INITIAL CODE (FAILING CHECK)');
  // Ensure app.py tab is selected
  try {
    const appTab = page.locator('text=app.py').first();
    if (await appTab.isVisible({ timeout: 3000 })) {
      await appTab.click();
    }
  } catch {}
  await page.waitForTimeout(500);

  const runBtn = page.locator('button.btn-run').first();
  await runBtn.waitFor({ state: 'visible', timeout: 15000 });
  await runBtn.click();
  console.log('  Run button clicked...');

  // Wait for run execution to complete
  await page.waitForSelector('text=Exit 1', { timeout: 15000 });
  const outputText = await page.evaluate(() => document.body.innerText);

  assert('State 1: Exit code is 1', outputText.includes('Exit 1') || outputText.includes('exit 1'));
  assert('State 1: Check failed on 100.0°C', outputText.includes('FAIL') && outputText.includes('100.0°C'));

  const shot1 = path.join(ARTIFACTS_DIR, 'step1_failing_run.png');
  await page.screenshot({ path: shot1 });
  console.log(`  📸 Screenshot saved: step1_failing_run.png\n`);

  // 3. STATE 2: AI ASSISTANT / FIX
  console.log('3. STATE 2: AI ASSISTANT FIX');
  // Check AI info
  const aiInfoRes = await fetch(`${WS_URL}/api/ai/info`);
  const aiInfo = await aiInfoRes.json();
  console.log(`  AI status: configured=${aiInfo.configured}, model=${aiInfo.model}`);

  // Note standing rule 0: Dev is rotating the Groq key personally.
  // Until rotated key is present/verified, AI steps are SKIPPED and reported as skipped.
  const aiKeyRotated = process.env.GROQ_KEY_ROTATED === 'true';

  if (!aiKeyRotated) {
    console.log('  ⏭️  SKIPPING AI generation step (standing rule: Dev rotating key personally)');
    console.log('      Reporting AI call as SKIPPED per prompt instructions.');
    skipped++;

    // Apply the fix directly to editor via Monaco evaluate so we verify State 3
    console.log('  Applying bug fix to Monaco editor: (value * 9 / 5) + 32 ...');
    await page.evaluate(() => {
      const ed = (window).monaco?.editor?.getEditors?.()[0];
      if (ed) {
        const val = ed.getValue();
        const fixed = val.replace('(value * 5 / 9) + 32', '(value * 9 / 5) + 32');
        ed.setValue(fixed);
      }
    });
    await page.waitForTimeout(1000);

    const shot2 = path.join(ARTIFACTS_DIR, 'step2_ai_apply.png');
    await page.screenshot({ path: shot2 });
    console.log(`  📸 Screenshot saved: step2_ai_apply.png (skipped AI generation, fix applied to editor)\n`);
  } else {
    // If key is confirmed rotated:
    const aiToggle = page.locator('button:has-text("AI")').first();
    await aiToggle.click();
    await page.waitForSelector('aside:has-text("SyncSpace AI")', { timeout: 5000 });
    const fixBtn = page.locator('button:has-text("Fix")').first();
    await fixBtn.click();
    const applyBtn = await page.waitForSelector('button:has-text("Apply to Editor")', { timeout: 35000 });
    assert('AI generated fix with Apply button', applyBtn !== null);

    // Check no <think> tag leak
    const asideText = await page.$eval('aside', el => el.innerText);
    assert('No <think> reasoning tokens leaked into UI', !asideText.includes('<think>') && !asideText.includes('</think>'));

    await applyBtn.click();
    await page.waitForTimeout(1000);

    const shot2 = path.join(ARTIFACTS_DIR, 'step2_ai_apply.png');
    await page.screenshot({ path: shot2 });
    console.log(`  📸 Screenshot saved: step2_ai_apply.png\n`);
  }

  // 4. STATE 3: RUN FIXED CODE (PASSING CHECK)
  console.log('4. STATE 3: RUN FIXED CODE (PASSING CHECK)');
  await runBtn.click();
  console.log('  Run button clicked on fixed code...');

  await page.waitForSelector('text=Exit 0', { timeout: 15000 });
  const outputText2 = await page.evaluate(() => document.body.innerText);

  assert('State 3: Exit code is 0', outputText2.includes('Exit 0') || outputText2.includes('exit 0'));
  assert('State 3: All 5/5 tests passed', outputText2.includes('5/5 tests passed'));

  const shot3 = path.join(ARTIFACTS_DIR, 'step3_passing_run.png');
  await page.screenshot({ path: shot3 });
  console.log(`  📸 Screenshot saved: step3_passing_run.png\n`);

  await browser.close();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(` RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
