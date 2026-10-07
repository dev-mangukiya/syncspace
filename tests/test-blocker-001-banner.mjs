/**
 * Test: BLOCKER-001 Disclaimer Banner Verification
 * 
 * Verifies BOTH triggers without assumption:
 * 1. Test Case 1: DIRECT WEBSOCKET FORCE-CLOSE (Network state UNTOUCHED)
 *    - Force-closes the WebSocket directly in the browser (simulating server close, Render redeploy, idle timeout).
 *    - navigator.onLine remains true (zero context.setOffline).
 *    - Waits past the >= 3s threshold.
 *    - WebSocket reconnects NATURALLY via scheduleReconnect().
 *    - Asserts BLOCKER-001 banner appears (#blocker-001-reconnect-notice).
 *    - Asserts plain-language copy, Version History button opens panel, dismiss button closes banner.
 * 
 * 2. Test Case 2: BROWSER-OFFLINE INTERFACE DROP (Original path)
 *    - Toggles context.setOffline(true) for 4.5 seconds.
 *    - Restores context.setOffline(false).
 *    - Confirms natural reconnect triggers the same BLOCKER-001 banner.
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://localhost:3001';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARTIFACT_DIR = '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45';
const EVIDENCE_DIR = path.resolve('tests/evidence_part7');

if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

async function runTest() {
  console.log('======================================================');
  console.log('TESTING BLOCKER-001 WIDENED DISCONNECT TRIGGER');
  console.log('Target URL:', APP_URL);
  console.log('======================================================\n');

  const runId = Math.random().toString(36).substring(2, 7);
  const username = `b001_${runId}`;
  const email = `b001_${runId}@example.com`;
  const password = `P@ssword123!_${runId}`;

  // 1. Signup via API proxy
  console.log('1. Registering test user:', username);
  const signupRes = await fetch(`${APP_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });

  if (signupRes.status !== 201) {
    throw new Error(`Signup failed with status ${signupRes.status}: ${await signupRes.text()}`);
  }

  const setCookieHeaders = signupRes.headers.getSetCookie?.() || [];
  const rawCookieHeader = signupRes.headers.get('set-cookie');
  const allCookieStrings = setCookieHeaders.length > 0 ? setCookieHeaders : (rawCookieHeader ? [rawCookieHeader] : []);
  
  const cookiesToSet = [];
  for (const cStr of allCookieStrings) {
    const parts = cStr.split(';').map(p => p.trim());
    const [name, val] = parts[0].split('=');
    cookiesToSet.push({
      name,
      value: val,
      domain: new URL(APP_URL).hostname,
      path: '/',
      httpOnly: name.includes('access') || name.includes('refresh'),
      secure: false,
      sameSite: 'Lax',
    });
  }

  const signupData = await signupRes.json();
  const csrfToken = signupData.csrf_token;
  console.log('   User registered. CSRF token acquired.');

  // 2. Create Python workspace
  console.log('2. Creating Python workspace...');
  const cookieHeaderVal = cookiesToSet.map(c => `${c.name}=${c.value}`).join('; ');
  const wsRes = await fetch(`${APP_URL}/api/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      'Cookie': cookieHeaderVal,
    },
    body: JSON.stringify({
      name: `b001-test-${runId}`,
      description: 'BLOCKER-001 disclaimer banner test',
      template: 'python',
      language: 'python',
    }),
  });

  if (wsRes.status !== 201) {
    throw new Error(`Workspace creation failed: ${wsRes.status} ${await wsRes.text()}`);
  }

  const wsData = await wsRes.json();
  const shortId = wsData.short_id;
  console.log('   Workspace created:', shortId);

  // 3. Launch browser
  console.log('3. Launching Chromium...');
  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(cookiesToSet);

  const page = await context.newPage();
  page.on('console', msg => console.log('   [Browser]:', msg.text()));

  // 4. Open workspace and wait for initial sync
  console.log(`4. Navigating to ${APP_URL}/w/${shortId}...`);
  await page.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'networkidle' });

  // Wait for Monaco editor to load
  await page.waitForFunction(() => {
    return window.monaco?.editor?.getModels()?.[0]?.getValue() !== undefined;
  }, { timeout: 15000 });

  await page.waitForTimeout(1000);

  // Check that the banner is NOT visible initially
  const bannerInitiallyVisible = await page.isVisible('#blocker-001-reconnect-notice');
  console.log('5. Initial banner visibility check:', bannerInitiallyVisible ? 'FAIL (visible)' : 'PASS (hidden)');
  if (bannerInitiallyVisible) {
    throw new Error('Banner should NOT be visible on initial connection');
  }

  // ══════════════════════════════════════════════════════════════
  // TEST CASE 1: DIRECT WEBSOCKET CLOSE (Network state UNTOUCHED)
  // ══════════════════════════════════════════════════════════════
  console.log('\n──────────────────────────────────────────────────────');
  console.log('CASE 1: DIRECT WEBSOCKET FORCE-CLOSE (Network untouched)');
  console.log('──────────────────────────────────────────────────────');

  // Verify browser network is online
  const isOnlineInitially = await page.evaluate(() => window.navigator.onLine);
  console.log('   Browser navigator.onLine:', isOnlineInitially);
  if (!isOnlineInitially) throw new Error('Browser should be online');

  // Force-close the WebSocket directly
  console.log('   Executing direct WebSocket close (server/socket drop emulation)...');
  await page.evaluate(() => {
    if (window.__activeWs) {
      window.__activeWs.close();
    } else if (window.__syncProvider) {
      window.__syncProvider.forceClose();
    } else {
      throw new Error('No active WebSocket found on window');
    }
  });

  // Confirm browser network state was NOT changed
  const isStillOnline = await page.evaluate(() => window.navigator.onLine);
  console.log('   Browser navigator.onLine after WS close:', isStillOnline, '(MUST BE TRUE)');
  if (!isStillOnline) throw new Error('Browser network state was modified!');

  // Wait past the threshold (> 3 seconds) while WebSocket reconnects naturally via scheduleReconnect()
  console.log('   Waiting past the 3s threshold for natural auto-reconnect...');
  await page.waitForSelector('#blocker-001-reconnect-notice', { timeout: 15000 });
  console.log('   ✅ Banner appeared successfully after direct socket drop!');

  const bannerText1 = await page.locator('#blocker-001-reconnect-notice').textContent();
  console.log('   Banner text:', bannerText1.trim());

  if (!bannerText1.includes('Version History') || !bannerText1.includes('confirm nothing was overwritten')) {
    throw new Error(`Banner does not contain expected disclaimer text! Got: "${bannerText1}"`);
  }
  console.log('   ✅ Banner text verification passed.');

  // Screenshot evidence for Case 1
  const screenshotPathArtifact = path.join(ARTIFACT_DIR, 'blocker_001_ws_close_banner.png');
  const screenshotPathEvidence = path.join(EVIDENCE_DIR, 'blocker_001_ws_close_banner.png');
  await page.screenshot({ path: screenshotPathArtifact });
  await page.screenshot({ path: screenshotPathEvidence });
  console.log('   📸 Saved Case 1 screenshot to:', screenshotPathArtifact);

  // Test opening Version History panel
  console.log('   Testing Version History button in banner...');
  await page.click('#banner-open-history-btn');
  await page.waitForTimeout(500);

  const vhPanel = page.locator('#version-history-panel');
  const vhVisible = await vhPanel.isVisible();
  console.log('   Version History panel opened:', vhVisible ? '✅ PASS' : '❌ FAIL');
  if (!vhVisible) {
    throw new Error('Clicking Version History button did not open version history panel');
  }

  // Close version history panel
  const closeVhBtn = page.locator('#version-history-panel button[title="Close (Esc)"], #version-history-panel button').first();
  await closeVhBtn.click();
  await page.waitForTimeout(300);

  // Dismiss banner
  console.log('   Dismissing banner (#dismiss-reconnect-notice-btn)...');
  await page.click('#dismiss-reconnect-notice-btn');
  await page.waitForTimeout(500);

  const bannerDismissed1 = await page.isVisible('#blocker-001-reconnect-notice');
  console.log('   Banner visibility after dismiss:', bannerDismissed1 ? 'FAIL (still visible)' : '✅ PASS (dismissed)');
  if (bannerDismissed1) {
    throw new Error('Dismiss button did not dismiss the banner');
  }

  // ══════════════════════════════════════════════════════════════
  // TEST CASE 2: BROWSER-OFFLINE INTERFACE DROP (Original path)
  // ══════════════════════════════════════════════════════════════
  console.log('\n──────────────────────────────────────────────────────');
  console.log('CASE 2: BROWSER-OFFLINE INTERFACE DROP (Original path)');
  console.log('──────────────────────────────────────────────────────');

  console.log('   Simulating browser network drop (context.setOffline(true)) for 4.5s...');
  await context.setOffline(true);
  await page.waitForTimeout(4500);

  console.log('   Restoring browser network (context.setOffline(false))...');
  await context.setOffline(false);

  console.log('   Waiting for reconnect and BLOCKER-001 banner to appear...');
  await page.waitForSelector('#blocker-001-reconnect-notice', { timeout: 15000 });
  console.log('   ✅ Banner appeared successfully after browser-offline recovery!');

  const bannerText2 = await page.locator('#blocker-001-reconnect-notice').textContent();
  if (!bannerText2.includes('Version History') || !bannerText2.includes('confirm nothing was overwritten')) {
    throw new Error(`Banner does not contain expected disclaimer text! Got: "${bannerText2}"`);
  }
  console.log('   ✅ Case 2 banner copy verified.');

  // Dismiss banner
  await page.click('#dismiss-reconnect-notice-btn');
  await page.waitForTimeout(500);
  const bannerDismissed2 = await page.isVisible('#blocker-001-reconnect-notice');
  if (bannerDismissed2) {
    throw new Error('Dismiss button did not dismiss Case 2 banner');
  }
  console.log('   ✅ Case 2 dismissed cleanly.');

  await browser.close();
  console.log('\n======================================================');
  console.log('🎉 BOTH TRIGGER PATHS VERIFIED & PASSING WITH EVIDENCE!');
  console.log('======================================================\n');
}

runTest().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
