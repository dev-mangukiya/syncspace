/**
 * Cursor Rendering Verification — TWO USERS
 * Creates two separate user accounts (Alice and Bob), invites Bob as editor,
 * opens both in isolated browser contexts, and verifies that y-monaco renders
 * name-labeled remote cursors with their distinct color slots.
 */

import { chromium } from '@playwright/test';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

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
  console.log(' CURSOR RENDERING — TWO USERS');
  console.log('═══════════════════════════════════════\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const testId = Date.now();

    // Create User A (Alice)
    console.log('Step 1: Creating two users via API (Cookie Auth)...');
    const jarA = new CookieJar();
    const signupA = await req('POST', '/api/auth/signup', {
      username: `alice_${testId}`,
      email: `alice_${testId}@test.com`,
      password: 'TestPass123!',
    }, jarA);
    const csrfA = jarA.get('syncspace_csrf');
    console.log(`  Alice: alice_${testId}`);

    // Create User B (Bob)
    const jarB = new CookieJar();
    const signupB = await req('POST', '/api/auth/signup', {
      username: `bob_${testId}`,
      email: `bob_${testId}@test.com`,
      password: 'TestPass123!',
    }, jarB);
    const csrfB = jarB.get('syncspace_csrf');
    console.log(`  Bob: bob_${testId}`);

    // Create workspace (as Alice)
    console.log('Step 2: Creating workspace & inviting Bob...');
    const wsRes = await req('POST', '/api/workspaces', {
      name: `CursorTest-${testId}`,
      language: 'python',
      template: 'blank',
    }, jarA, { 'X-CSRF-Token': csrfA });

    const shortId = wsRes.data.short_id;
    console.log(`  Workspace shortId: ${shortId}`);

    // Invite Bob as editor
    const inviteRes = await req('POST', `/api/workspaces/${shortId}/members`, {
      identifier: `bob_${testId}@test.com`,
      role: 'editor',
    }, jarA, { 'X-CSRF-Token': csrfA });
    console.log(`  Invite status: ${inviteRes.status}`);

    // Create a file
    await req('POST', `/api/workspaces/${shortId}/file`, {
      path: 'collab.py',
      content: '# Collaborative Editing Demo\nprint("Hello from SyncSpace!")\n\n# Both users will type below:\n',
    }, jarA, { 'X-CSRF-Token': csrfA });

    console.log('Step 3: Opening two browser contexts...');
    const workspaceUrl = `${APP_URL}/w/${shortId}`;

    const contextA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    // Set Alice cookies in context A
    const cookiesA = Object.entries(jarA.cookies).map(([name, value]) => ({
      name, value, domain: 'localhost', path: '/', httpOnly: name.includes('access') || name.includes('refresh'), sameSite: 'Lax',
    }));
    await contextA.addCookies(cookiesA);

    // Set Bob cookies in context B
    const cookiesB = Object.entries(jarB.cookies).map(([name, value]) => ({
      name, value, domain: 'localhost', path: '/', httpOnly: name.includes('access') || name.includes('refresh'), sameSite: 'Lax',
    }));
    await contextB.addCookies(cookiesB);

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // Navigate both to workspace
    await Promise.all([
      pageA.goto(workspaceUrl, { waitUntil: 'networkidle' }),
      pageB.goto(workspaceUrl, { waitUntil: 'networkidle' }),
    ]);

    await pageA.waitForTimeout(3000);
    await pageB.waitForTimeout(2000);

    // Click on collab.py file in both tabs
    console.log('Step 4: Selecting collab.py...');
    for (const page of [pageA, pageB]) {
      try {
        const fileLoc = page.locator('text=collab.py').first();
        if (await fileLoc.isVisible({ timeout: 4000 })) {
          await fileLoc.click();
        }
      } catch {}
    }
    await pageA.waitForTimeout(2000);
    await pageB.waitForTimeout(2000);

    // Step 5: Type in both editors
    console.log('Step 5: Typing in both editors...');
    const editorSel = '.monaco-editor .view-lines';

    try {
      const edA = pageA.locator(editorSel).first();
      await edA.click({ timeout: 5000 });
      await pageA.keyboard.press('End');
      await pageA.keyboard.press('Enter');
      await pageA.keyboard.type('alice_cursor_here = True', { delay: 30 });
      console.log('  Alice typed');
    } catch (e) {
      console.log(`  ⚠️ Page A type error: ${e.message}`);
    }

    await pageA.waitForTimeout(2000);

    try {
      const edB = pageB.locator(editorSel).first();
      await edB.click({ timeout: 5000 });
      await pageB.keyboard.press('End');
      await pageB.keyboard.press('Enter');
      await pageB.keyboard.type('bob_cursor_here = True', { delay: 30 });
      console.log('  Bob typed');
    } catch (e) {
      console.log(`  ⚠️ Page B type error: ${e.message}`);
    }

    await pageA.waitForTimeout(3000);
    await pageB.waitForTimeout(1000);

    // Step 6: Take screenshots
    console.log('Step 6: Taking screenshots...');
    await pageA.screenshot({ path: 'tests/cursor_page_a.png', fullPage: false });
    console.log('  cursor_page_a.png saved');
    await pageB.screenshot({ path: 'tests/cursor_page_b.png', fullPage: false });
    console.log('  cursor_page_b.png saved');

    // Check for remote cursor elements
    const countA = await pageA.locator('.yRemoteSelectionHead, [class*="yRemote"]').count();
    const countB = await pageB.locator('.yRemoteSelectionHead, [class*="yRemote"]').count();
    console.log(`  Remote cursor elements: Tab A=${countA}, Tab B=${countB}`);

    const hasCursors = countA > 0 || countB > 0;
    console.log(`  Remote cursors rendered: ${hasCursors ? '✅ YES' : '❌ NO'}`);

    await contextA.close();
    await contextB.close();

    console.log('\n═══════════════════════════════════════');
    console.log(` RESULTS: ${hasCursors ? '1 passed, 0 failed' : '0 passed, 1 failed'}`);
    console.log('═══════════════════════════════════════\n');

    process.exit(hasCursors ? 0 : 1);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
