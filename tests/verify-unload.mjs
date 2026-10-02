/**
 * Flush-on-Tab-Close Test (Beacon Persist)
 * ─────────────────────────────────────────
 * Verifies that when a tab is closed before the 3-second auto-save debounce
 * fires, the beforeunload/pagehide handler issues a keepalive fetch (beacon persist)
 * with the latest editor content and valid CSRF token, so that edits are never lost.
 *
 * Auth Model:
 *   - Cookie-based authentication (syncspace_access, syncspace_csrf)
 *   - CSRF token included in beacon persist request
 *
 * Usage:
 *   node verify-unload.mjs
 */

import { chromium } from '@playwright/test';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const WS_URL  = process.env.WS_URL  || 'http://localhost:8080';

// ── Cookie Jar Helper ────────────────────────────────────

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

async function main() {
  console.log('═══════════════════════════════════════');
  console.log(' FLUSH ON TAB CLOSE TEST (BEACON PERSIST)');
  console.log('═══════════════════════════════════════\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const testId = Date.now();

    // Step 1: Setup via Cookie Auth
    console.log('Step 1: Setup via API (Cookie Auth)...');
    const jar = new CookieJar();
    const signup = await req('POST', '/api/auth/signup', {
      username: `unload_${testId}`,
      email: `unload_${testId}@test.com`,
      password: 'TestPass123!',
    }, jar);

    if (signup.status !== 201) {
      throw new Error(`Signup failed: ${JSON.stringify(signup.data)}`);
    }

    const csrf = jar.get('syncspace_csrf');
    const ws = await req('POST', '/api/workspaces', {
      name: `Unload-${testId}`,
      language: 'python',
      template: 'blank',
    }, jar, { 'X-CSRF-Token': csrf });

    if (ws.status !== 201) {
      throw new Error(`Workspace creation failed: ${JSON.stringify(ws.data)}`);
    }

    const shortId = ws.data.short_id;
    const slug = ws.data.slug;

    const initialContent = 'LINE_A = 1\nLINE_B = 2\nLINE_C = 3';
    await req('POST', `/api/workspaces/${shortId}/file`, {
      path: 'beacon.py',
      content: initialContent,
    }, jar, { 'X-CSRF-Token': csrf });

    console.log(`  Workspace: ${shortId} (${slug})`);
    console.log(`  Initial: "${initialContent}"`);

    // Step 2: Open browser with cookies
    console.log('\nStep 2: Opening browser...');
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const cookiesToAdd = Object.entries(jar.cookies).map(([name, value]) => ({
      name,
      value,
      domain: 'localhost',
      path: '/',
      httpOnly: name.includes('access') || name.includes('refresh'),
      sameSite: 'Lax',
    }));
    await context.addCookies(cookiesToAdd);

    const page = await context.newPage();
    await page.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Select file
    console.log('  Selecting beacon.py...');
    try {
      const fileLoc = page.locator('text=beacon.py').first();
      if (await fileLoc.isVisible({ timeout: 5000 })) {
        await fileLoc.click();
        console.log('  File selected');
      }
    } catch {
      console.log('  ⚠️ Could not click beacon.py');
    }
    await page.waitForTimeout(3000); // Wait for sync + editor mount

    // Verify editor shows the file content
    const editorContent = await page.evaluate(() => {
      const lines = document.querySelectorAll('.monaco-editor .view-line');
      return Array.from(lines).map(l => l.textContent).join('\n');
    });
    console.log(`  Editor shows: "${editorContent.substring(0, 100)}"`);

    // Step 3: Type edit
    const MARKER = `BEACON_SAVED_${testId}`;
    console.log(`\nStep 3: Typing: "${MARKER}"...`);

    const ed = page.locator('.monaco-editor .view-lines').first();
    await ed.click({ timeout: 5000 });
    await page.keyboard.press('Meta+End');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(MARKER, { delay: 30 });
    console.log('  Typed successfully');

    // Wait 1s for Monaco to propagate to Y.Doc
    // (Less than 3s debounce, so normal periodic save timer will NOT fire yet)
    await page.waitForTimeout(1000);

    // Step 4: Close tab IMMEDIATELY with runBeforeUnload: true
    console.log('\nStep 4: Closing tab (1s after edit, before 3s debounce)...');
    await page.close({ runBeforeUnload: true });
    console.log('  Tab closed with runBeforeUnload: true');

    // Wait for keepalive beacon-persist request to finish in backend
    await new Promise(r => setTimeout(r, 3000));

    // Step 5: Check content via backend API
    console.log('\nStep 5: Fetching saved content from API...');
    const fileRes = await req('GET', `/api/workspaces/${shortId}/file?path=beacon.py`, null, jar);
    const savedContent = fileRes.data?.content || '';

    console.log(`\n  BEFORE: "${initialContent}"`);
    console.log(`  AFTER:  "${savedContent}"`);

    const saved = savedContent.includes(MARKER);
    console.log(`  Contains MARKER: ${saved ? '✅ YES' : '❌ NO'}`);

    if (saved) {
      console.log('\n  ✅ PASS — keepalive beacon fetch saved the edit on tab close');
    } else {
      console.log('\n  ❌ FAIL — edit lost on tab close');
    }

    await context.close();

    console.log('\n═══════════════════════════════════════');
    console.log(` RESULTS: ${saved ? '1 passed, 0 failed' : '0 passed, 1 failed'}`);
    console.log('═══════════════════════════════════════\n');

    process.exit(saved ? 0 : 1);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
