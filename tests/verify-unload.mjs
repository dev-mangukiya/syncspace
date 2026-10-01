/**
 * Flush-on-Tab-Close Test — Direct verification
 * Uses a longer wait after typing to ensure y-monaco binding propagates
 * the edit to the Y.Doc before closing the tab.
 */

import { chromium } from '@playwright/test';

const APP_URL = 'http://localhost:3000';
const WS_URL = 'http://localhost:8080';

async function main() {
  console.log('═══════════════════════════════════════');
  console.log(' FLUSH ON TAB CLOSE TEST');
  console.log('═══════════════════════════════════════\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    const testId = Date.now();

    // Step 1: Create user, workspace, file
    console.log('Step 1: Setup via API...');
    const signupRes = await fetch(`${WS_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `unload2_${testId}`,
        email: `unload2_${testId}@test.com`,
        password: 'TestPass123!',
      }),
    });
    const { token } = await signupRes.json();

    const wsRes = await fetch(`${WS_URL}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: `Unload2-${testId}` }),
    });
    const workspace = await wsRes.json();
    const slug = workspace.slug;

    const initialContent = 'LINE_A = 1\nLINE_B = 2\nLINE_C = 3';
    await fetch(`${WS_URL}/api/workspaces/${slug}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ path: 'beacon.py', content: initialContent }),
    });

    console.log(`  Workspace: ${slug}`);
    console.log(`  Initial: "${initialContent}"`);

    // Step 2: Open browser
    console.log('\nStep 2: Opening browser...');
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    await page.goto(APP_URL);
    await page.evaluate((t) => localStorage.setItem('syncspace_token', t), token);
    await page.goto(`${APP_URL}/workspace/${slug}`);
    await page.waitForTimeout(3000);

    // Select file
    console.log('  Selecting beacon.py...');
    try {
      await page.locator('text=beacon.py').first().click({ timeout: 5000 });
      console.log('  File selected');
    } catch {
      console.log('  ⚠️ Could not click beacon.py');
    }
    await page.waitForTimeout(3000); // Wait for sync + Y.Doc to seed

    // Verify editor shows the file content
    const editorContent = await page.evaluate(() => {
      const lines = document.querySelectorAll('.monaco-editor .view-line');
      return Array.from(lines).map(l => l.textContent).join('\n');
    });
    console.log(`  Editor shows: "${editorContent.substring(0, 100)}"`);

    // Step 3: Type edit
    const MARKER = `BEACON_SAVED_${testId}`;
    console.log(`\nStep 3: Typing: "${MARKER}"...`);

    try {
      const ed = page.locator('.monaco-editor .view-lines').first();
      if (await ed.isVisible({ timeout: 5000 })) {
        await ed.click();
        await page.keyboard.press('Meta+End');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type(MARKER, { delay: 30 });
        console.log('  Typed successfully');
      }
    } catch (e) {
      console.log(`  ⚠️ Error: ${e.message}`);
    }

    // Wait 1s for y-monaco to propagate the edit to Y.Doc
    // This is LESS than the 3s debounce, so the normal save timer won't fire
    await page.waitForTimeout(1000);

    // Verify Y.Doc has the edit
    const yDocContent = await page.evaluate(() => {
      // Access the sync provider through the window
      return window.__syncDebug?.getText?.() || 'NO_DEBUG_ACCESS';
    });
    console.log(`  Y.Doc content: "${typeof yDocContent === 'string' ? yDocContent.substring(0, 100) : yDocContent}"`);

    // Step 4: Close tab IMMEDIATELY (1s < 3s debounce)
    console.log('\nStep 4: Closing tab (1s after edit, before 3s debounce)...');
    
    // Try using page.close with runBeforeUnload option
    await page.close({ runBeforeUnload: true });
    console.log('  Tab closed with runBeforeUnload: true');

    // Wait for keepalive fetch
    await new Promise(r => setTimeout(r, 3000));

    // Step 5: Check content
    console.log('\nStep 5: Fetching saved content...');
    const fileRes = await fetch(`${WS_URL}/api/workspaces/${slug}/file?path=beacon.py`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const file = await fileRes.json();
    const savedContent = file.content;

    console.log(`\n  BEFORE: "${initialContent}"`);
    console.log(`  AFTER:  "${savedContent}"`);
    
    const saved = savedContent.includes(MARKER);
    console.log(`  Contains MARKER: ${saved ? '✅ YES' : '❌ NO'}`);

    if (saved) {
      console.log('\n  ✅ PASS — keepalive fetch saved the edit on tab close');
    } else {
      console.log('\n  ❌ FAIL — edit lost (checking if debounce might have fired)');
      
      // Check if it was the debounce or the beacon
      // If content changed but doesn't have the marker, something else saved
      if (savedContent !== initialContent) {
        console.log(`  Content DID change, but marker missing`);
      }
    }

    await context.close();

    console.log('\n═══════════════════════════════════════');
    console.log(' DONE');
    console.log('═══════════════════════════════════════\n');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
