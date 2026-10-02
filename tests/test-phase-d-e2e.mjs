#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45';
const BASE = 'http://localhost:3000';
const WS_BASE = 'http://localhost:8080';

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
  toPlaywrightCookies(domain = 'localhost') {
    return Object.entries(this.cookies).map(([name, value]) => ({
      name,
      value,
      domain,
      path: '/',
      httpOnly: name === 'syncspace_access',
      secure: false,
      sameSite: 'Lax',
    }));
  }
}

async function req(method, endpoint, body, jar, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (jar) headers['Cookie'] = jar.toString();
  const resp = await fetch(`${WS_BASE}${endpoint}`, {
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

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  PHASE D EXECUTION EXPERIENCE END-TO-END TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const jarAlice = new CookieJar();
  const jarBob = new CookieJar();
  const jarCharlie = new CookieJar();

  // 1. Setup Alice (Owner), Bob (Editor), Charlie (Viewer)
  console.log('--- 1. Authentication & Workspace Setup ---');
  await req('POST', '/api/auth/signup', {
    username: `alice_d_${ts}`,
    email: `alice_d_${ts}@example.com`,
    password: 'Password123!',
  }, jarAlice);
  const csrfAlice = jarAlice.get('syncspace_csrf');

  await req('POST', '/api/auth/signup', {
    username: `bob_d_${ts}`,
    email: `bob_d_${ts}@example.com`,
    password: 'Password123!',
  }, jarBob);
  const csrfBob = jarBob.get('syncspace_csrf');

  await req('POST', '/api/auth/signup', {
    username: `charlie_d_${ts}`,
    email: `charlie_d_${ts}@example.com`,
    password: 'Password123!',
  }, jarCharlie);
  const csrfCharlie = jarCharlie.get('syncspace_csrf');

  // Alice creates a Python workspace
  const wsRes = await req('POST', '/api/workspaces', {
    name: `Exec Demo ${ts}`,
    template: 'python',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Alice created Python workspace (status 201)', wsRes.status === 201);
  const shortId = wsRes.data.short_id;

  // Invite Bob as editor
  const invBob = await req('POST', `/api/workspaces/${shortId}/members`, {
    identifier: `bob_d_${ts}`,
    role: 'editor',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Bob invited as editor (status 200/201)', invBob.status === 200 || invBob.status === 201);

  // Invite Charlie as viewer
  const invCharlie = await req('POST', `/api/workspaces/${shortId}/members`, {
    identifier: `charlie_d_${ts}`,
    role: 'viewer',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Charlie invited as viewer (status 200/201)', invCharlie.status === 200 || invCharlie.status === 201);

  // 2. Direct API Role Enforcement: Viewer gets 403 Forbidden
  console.log('\n--- 2. Viewer Role Authorization (Direct API Check) ---');
  const viewerRun = await req('POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'app.py',
    code: 'print("Viewer run attempt")',
    language: 'python',
  }, jarCharlie, { 'X-CSRF-Token': csrfCharlie });
  assert('Viewer is blocked from running code (status 403)', viewerRun.status === 403);
  assert('Viewer error message mentions permissions', viewerRun.data?.error?.includes('viewer'));

  // 3. Browser Contexts E2E Verification
  console.log('\n--- 3. Launching Dual Browser Contexts (Alice & Bob) ---');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const toCookies = (jar) => Object.entries(jar.cookies).map(([name, value]) => ({
    name,
    value,
    domain: 'localhost',
    path: '/',
    httpOnly: name.includes('access') || name.includes('refresh') || name.includes('token'),
    sameSite: 'Lax',
  }));

  const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await contextA.addCookies(toCookies(jarAlice));
  const pageA = await contextA.newPage();
  pageA.on('console', msg => console.log('[pageA]', msg.text()));
  pageA.on('pageerror', err => console.log('[pageA error]', err.message));

  const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await contextB.addCookies(toCookies(jarBob));
  const pageB = await contextB.newPage();

  // Navigate both pages to the workspace
  await Promise.all([
    pageA.goto(`${BASE}/w/${shortId}`),
    pageB.goto(`${BASE}/w/${shortId}`),
  ]);

  await pageA.waitForSelector('.monaco-editor', { timeout: 15000 });
  await pageB.waitForSelector('.monaco-editor', { timeout: 15000 });
  console.log('  Both browser contexts loaded editor');

  // Verify Charlie in Viewer context
  const contextC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await contextC.addCookies(toCookies(jarCharlie));
  const pageC = await contextC.newPage();
  await pageC.goto(`${BASE}/w/${shortId}`);
  await pageC.waitForSelector('.monaco-editor', { timeout: 15000 });
  const runBtnC = pageC.locator('button.btn-run');
  await runBtnC.waitFor({ state: 'visible', timeout: 15000 });
  await pageC.waitForTimeout(800);
  const isDisabledC = await runBtnC.isDisabled();
  assert('Viewer UI: Run button is disabled for Charlie', isDisabledC);

  // 4. Live Streaming Output: A runs, B sees live output
  console.log('\n--- 4. Live Streaming: Alice Runs, Bob Observes ---');
  // Open output panel on page B
  await pageB.click('button:has-text("Output")');
  await pageB.waitForTimeout(500);

  // Alice triggers run of app.py (seeded template)
  const runBtnA = pageA.locator('button.btn-run');
  await runBtnA.waitFor({ state: 'visible', timeout: 15000 });
  await pageA.waitForSelector('button.btn-run:not([disabled])', { timeout: 10000 });
  await runBtnA.click();

  // Bob's page should show Alice running and stream output
  await pageB.waitForSelector('text=running...', { timeout: 8000 });
  assert('Bob sees live notification: Alice is running', true);

  // Wait for run completion on both pages
  await pageA.waitForSelector('text=Exit 1', { timeout: 15000 });
  await pageB.waitForSelector('text=Exit 1', { timeout: 15000 });
  assert('Alice sees run finished (Exit 1)', true);
  assert('Bob sees run finished (Exit 1)', true);

  // 5. One Run Per Workspace & Redis Lock Rejection
  console.log('\n--- 5. Concurrency / Redis Lock: Second Run Rejected ---');
  // Trigger a 3-second sleep script via Alice
  const sleepCode = `
import time
print("Alice long job started")
time.sleep(3)
print("Alice long job done")
`;
  // Start execution via Alice's API
  const aliceRunPromise = req('POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'sleep.py',
    code: sleepCode,
    language: 'python',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });

  // Wait 400ms for lock to be established
  await new Promise(r => setTimeout(r, 400));

  // Bob attempts to run code while Alice's run is active
  const bobRunAttempt = await req('POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'app.py',
    code: 'print("Bob interrupt")',
    language: 'python',
  }, jarBob, { 'X-CSRF-Token': csrfBob });

  assert('Bob run attempt during active run returns 409 Conflict', bobRunAttempt.status === 409);
  assert('409 Conflict message identifies active runner', bobRunAttempt.data?.error?.includes('alice_d_'));

  await aliceRunPromise;

  // 6. Cancel Active Run: Bob cancels Alice's run
  console.log('\n--- 6. Cancel Active Run ---');
  const cancelCode = `
import time
print("Long task started...")
time.sleep(10)
print("Should not see this")
`;
  const aliceCancelRun = req('POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'cancel.py',
    code: cancelCode,
    language: 'python',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });

  await new Promise(r => setTimeout(r, 500));

  // Bob cancels the active run
  const cancelRes = await req('POST', `/api/workspaces/${shortId}/run/cancel`, {}, jarBob, { 'X-CSRF-Token': csrfBob });
  assert('Cancel endpoint returns status 200', cancelRes.status === 200);
  assert('Cancel response indicates cancelled', cancelRes.data?.status === 'cancelled');

  const aliceCancelResult = await aliceCancelRun;
  assert('Alice execution terminated early (cancelled/killed)', aliceCancelResult.data?.cancelled === true || aliceCancelResult.data?.exit_code === -1 || aliceCancelResult.data?.exit_code === 137);

  // 7. History Persistence Across Reload
  console.log('\n--- 7. History Persistence Across Reload ---');
  await pageA.reload();
  await pageA.waitForSelector('.monaco-editor', { timeout: 15000 });
  await pageA.click('button:has-text("Output")');
  await pageA.waitForTimeout(500);

  // Switch to History tab on Page A
  await pageA.click('button:has-text("History")');
  await pageA.waitForSelector('table', { timeout: 5000 });
  const rows = await pageA.locator('tbody tr').count();
  assert(`History persists after reload (${rows} runs recorded)`, rows >= 2);

  // Click first history item and view output
  await pageA.locator('tbody tr').first().click();
  await pageA.waitForTimeout(500);
  const backBtnVisible = await pageA.locator('button:has-text("Back to live")').isVisible();
  assert('Clicking historical run displays recorded output and Back to live button', backBtnVisible);

  // 8. ANSI Color Rendering and XSS Test
  console.log('\n--- 8. ANSI Color Rendering & XSS Safety Proof ---');
  const xssAnsiCode = `
import sys
# Red ANSI text
print("\\033[31mRed text\\033[0m normal")
# Green ANSI text
print("\\033[32mGreen text\\033[0m")
# XSS payload in print statement
print("<script>window.__XSS_TRIGGERED__ = true;</script>")
print("<img src=x onerror=\\"window.__XSS_TRIGGERED__ = true\\">")
`;
  const xssRun = await req('POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'xss_test.py',
    code: xssAnsiCode,
    language: 'python',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });

  assert('XSS test script executed with exit 0', xssRun.data?.exit_code === 0);

  // Switch back to output tab to view rendered ANSI
  await pageA.click('button:has-text("Output")');
  await pageA.waitForTimeout(1000);

  // Check if XSS variable was executed in browser context
  const xssTriggered = await pageA.evaluate(() => (window).__XSS_TRIGGERED__);
  assert('Zero script execution: window.__XSS_TRIGGERED__ is undefined', xssTriggered === undefined);

  // 9. Seeded Planted Bug Three-State Proof
  console.log('\n--- 9. Seeded Planted Bug Three-State Proof ---');
  // State 1: Run fails visible test
  const runFail = await req('POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'app.py',
    language: 'python',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('State 1 (Planted Bug): Run fails temperature check (Exit 1)', runFail.data?.exit_code === 1);
  assert('State 1 Output reports FAIL on 100.0°C', runFail.data?.output?.includes('FAIL: 100.0°C'));

  // State 2: Bug Fix Applied (value * 9 / 5) + 32
  const fixedCode = `"""Temperature conversion utility module."""

def convert_temperature(value: float, unit: str) -> float:
    unit = unit.upper()
    if unit == 'C':
        return (value * 9 / 5) + 32
    elif unit == 'F':
        return (value - 32) * 5 / 9
    raise ValueError(f"Unsupported unit: {unit}")

def run_tests():
    print("Running temperature conversion checks...")
    test_cases = [
        (0.0, 'C', 32.0),
        (100.0, 'C', 212.0),
        (212.0, 'F', 100.0),
        (32.0, 'F', 0.0),
        (-40.0, 'C', -40.0),
    ]

    passed = 0
    for val, unit, expected in test_cases:
        actual = round(convert_temperature(val, unit), 1)
        if actual == expected:
            print(f"  PASS: {val}°{unit} -> {actual}")
            passed += 1
        else:
            print(f"  FAIL: {val}°{unit} expected {expected}, got {actual}")

    print(f"\\nSummary: {passed}/{len(test_cases)} tests passed")
    if passed < len(test_cases):
        raise SystemExit(1)

if __name__ == '__main__':
    run_tests()
`;
  // Update file in workspace
  await req('PUT', `/api/workspaces/${shortId}/file`, {
    path: 'app.py',
    content: fixedCode,
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  console.log('  State 2: Planted bug fixed in app.py: (value * 9 / 5) + 32');

  // State 3: Run passes visible test
  const runPass = await req('POST', `/api/workspaces/${shortId}/run`, {
    file_path: 'app.py',
    code: fixedCode,
    language: 'python',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('State 3 (Fixed): Run passes all temperature checks (Exit 0)', runPass.data?.exit_code === 0);
  assert('State 3 Output reports 5/5 tests passed', runPass.data?.output?.includes('5/5 tests passed'));

  // Capture screenshot of Output Panel showing Exit 0, duration, and footer
  await pageA.click('button:has-text("app.py")');
  await pageA.waitForTimeout(500);
  await pageA.evaluate((code) => {
    const models = window.monaco?.editor?.getModels();
    if (models && models.length > 0) {
      models[0].setValue(code);
    }
  }, fixedCode);
  await pageA.waitForTimeout(500);

  const runBtn = pageA.locator('button.btn-run');
  await runBtn.click();
  console.log('  Clicked Run button on pageA with fixed code');
  await pageA.waitForSelector('text=Exit 0', { timeout: 20000 });
  await pageA.waitForTimeout(1000);

  const proofScreenshotPath = path.join(ARTIFACTS_DIR, 'phase_d_execution_proof.png');
  await pageA.screenshot({ path: proofScreenshotPath });
  console.log(`  Saved E2E screenshot proof to ${proofScreenshotPath}`);

  await browser.close();

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`PHASE D E2E TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════════');
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
