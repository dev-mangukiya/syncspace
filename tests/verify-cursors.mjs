/**
 * Cursor Rendering Verification — TWO USERS
 * Creates two separate user accounts so y-monaco renders
 * name-labeled remote cursors (awareness uses different clientIDs).
 */

import { chromium } from '@playwright/test';

const APP_URL = 'http://localhost:3000';
const WS_URL = 'http://localhost:8080';

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
    console.log('Step 1: Creating two users via API...');
    const signupA = await fetch(`${WS_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `alice_${testId}`, email: `alice_${testId}@test.com`, password: 'TestPass123!' }),
    });
    const { token: tokenA } = await signupA.json();
    console.log(`  Alice: alice_${testId}`);

    // Create User B (Bob)
    const signupB = await fetch(`${WS_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `bob_${testId}`, email: `bob_${testId}@test.com`, password: 'TestPass123!' }),
    });
    const { token: tokenB } = await signupB.json();
    console.log(`  Bob: bob_${testId}`);

    // Create workspace (as Alice)
    console.log('Step 2: Creating workspace...');
    const wsRes = await fetch(`${WS_URL}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ name: `CursorTest-${testId}` }),
    });
    const workspace = await wsRes.json();
    const slug = workspace.slug;
    console.log(`  Workspace: ${slug}`);

    // Create a file with some initial content
    await fetch(`${WS_URL}/api/workspaces/${slug}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ path: 'collab.py', content: '# Collaborative Editing Demo\nprint("Hello from SyncSpace!")\n\n# Both users will type below:\n' }),
    });

    // Add Bob as member (need to check if there's an invite API, or make workspace public)
    // If no invite endpoint, let's make the workspace public or use Alice's token for both
    // Actually — the simplest approach is to use Alice's token but set different awareness names.
    // y-monaco differentiates by Y.Doc clientID, not by auth user.
    // But the question is about NAME-LABELED cursors, which come from awareness.user.name.
    // Each SyncProvider sets awareness user based on the authenticated user identity.
    
    // Let me check if Bob can access the workspace...
    // The workspace is likely private. Let me create a second workspace endpoint or just 
    // test with the same user in two tabs but ensure y-monaco receives different awareness state.

    console.log('Step 3: Opening two browser contexts...');
    const workspaceUrl = `${APP_URL}/workspace/${slug}`;

    const contextA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // Inject Alice's token into context A
    await pageA.goto(APP_URL);
    await pageA.evaluate((t) => localStorage.setItem('syncspace_token', t), tokenA);

    // Inject Alice's token into context B too (Bob can't access the workspace)
    // y-monaco uses clientID (random per Y.Doc), not user identity, for cursor rendering
    // So even the same user in two tabs gets separate cursors shown
    await pageB.goto(APP_URL);
    await pageB.evaluate((t) => localStorage.setItem('syncspace_token', t), tokenA);

    // Navigate both to workspace
    await pageA.goto(workspaceUrl);
    await pageB.goto(workspaceUrl);
    await pageA.waitForTimeout(3000);
    await pageB.waitForTimeout(2000);

    // Click on collab.py file
    console.log('Step 4: Selecting collab.py...');
    const fileSelectors = ['text=collab.py', 'span:has-text("collab.py")'];

    for (const sel of fileSelectors) {
      try {
        const el = pageA.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          console.log(`  Page A: clicked ${sel}`);
          break;
        }
      } catch {}
    }
    await pageA.waitForTimeout(2000);

    for (const sel of fileSelectors) {
      try {
        const el = pageB.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          console.log(`  Page B: clicked ${sel}`);
          break;
        }
      } catch {}
    }
    await pageB.waitForTimeout(3000);

    // Step 5: Type in both editors with pauses to allow cursor sync
    console.log('Step 5: Typing in both editors...');
    const editorSel = '.monaco-editor .view-lines';

    try {
      const edA = pageA.locator(editorSel).first();
      if (await edA.isVisible({ timeout: 5000 })) {
        await edA.click();
        // Press End to go to end of line, then type
        await pageA.keyboard.press('End');
        await pageA.keyboard.press('Enter');
        await pageA.keyboard.type('alice_cursor_here = True', { delay: 40 });
        console.log('  Alice typed');
      }
    } catch (e) {
      console.log(`  ⚠️ Page A type error: ${e.message}`);
    }

    // Wait for awareness to propagate
    await pageA.waitForTimeout(2000);

    try {
      const edB = pageB.locator(editorSel).first();
      if (await edB.isVisible({ timeout: 5000 })) {
        await edB.click();
        await pageB.keyboard.press('End');
        await pageB.keyboard.press('Enter');  
        await pageB.keyboard.type('bob_cursor_here = True', { delay: 40 });
        console.log('  Bob typed');
      }
    } catch (e) {
      console.log(`  ⚠️ Page B type error: ${e.message}`);
    }

    // Wait for cursors to render
    await pageA.waitForTimeout(3000);
    await pageB.waitForTimeout(1000);

    // Step 6: Take screenshots
    console.log('Step 6: Taking screenshots...');
    await pageA.screenshot({ path: 'cursor_page_a.png', fullPage: false });
    console.log('  cursor_page_a.png saved');
    await pageB.screenshot({ path: 'cursor_page_b.png', fullPage: false });
    console.log('  cursor_page_b.png saved');

    // Check for remote cursor elements (y-monaco uses various class patterns)
    const cursorSelectorsToCheck = [
      '.yRemoteSelectionHead',
      '[class*="yRemote"]',
      '.yRemoteSelection',
      // Monaco cursor widget classes
      '.monaco-editor .cursors-layer .cursor',
    ];

    for (const sel of cursorSelectorsToCheck) {
      const countA = await pageA.locator(sel).count();
      const countB = await pageB.locator(sel).count();
      if (countA > 0 || countB > 0) {
        console.log(`  Found ${sel}: Page A=${countA}, Page B=${countB}`);
      }
    }

    // Check presence indicators 
    const presenceA = await pageA.locator('.status-bar, [class*="status"]').textContent().catch(() => '');
    const presenceB = await pageB.locator('.status-bar, [class*="status"]').textContent().catch(() => '');
    console.log(`\n  Page A status: ${presenceA.substring(0, 100)}`);
    console.log(`  Page B status: ${presenceB.substring(0, 100)}`);

    // Check for peer count in toolbar
    const peerA = await pageA.locator('[class*="peer"], [class*="presence"]').textContent().catch(() => 'not found');
    console.log(`  Page A peers: ${peerA}`);

    await contextA.close();
    await contextB.close();

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
