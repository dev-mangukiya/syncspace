/**
 * Test: BLOCKER-001 Disclaimer Banner Verification
 * 
 * Verifies:
 * 1. Banner is NOT shown on initial clean connect.
 * 2. When client is disconnected for > 3 seconds and then reconnects:
 *    - Banner appears prominently above the editor (#blocker-001-reconnect-notice).
 *    - Banner displays plain language: "If you were offline while editing, check Version History to confirm nothing was overwritten."
 * 3. Clicking "Version History" opens the Version History panel (#version-history-panel).
 * 4. Clicking the dismiss button ('X') closes the notice.
 * 5. Captures screenshot evidence into artifacts directory.
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
  console.log('TESTING BLOCKER-001 RECONNECT DISCLAIMER BANNER');
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

  // 6. Simulate a network disconnect of > 3 seconds (4 seconds)
  console.log('6. Simulating network disconnect for 4.5 seconds...');
  await context.setOffline(true);
  console.log('   Context offline. Waiting 4.5 seconds...');
  await page.waitForTimeout(4500);

  // 7. Reconnect
  console.log('7. Re-enabling network (context online)...');
  await context.setOffline(false);

  // Wait for reconnect and sync
  console.log('8. Waiting for reconnect and BLOCKER-001 disclaimer banner to appear...');
  await page.waitForSelector('#blocker-001-reconnect-notice', { timeout: 12000 });
  console.log('   ✅ Banner appeared successfully!');

  // Check the text
  const bannerText = await page.locator('#blocker-001-reconnect-notice').textContent();
  console.log('   Banner text:', bannerText.trim());

  const expectedSnippet = 'If you were offline while editing, check Version History to confirm nothing was overwritten.';
  if (!bannerText.includes('Version History') || !bannerText.includes('confirm nothing was overwritten')) {
    throw new Error(`Banner does not contain expected disclaimer text! Got: "${bannerText}"`);
  }
  console.log('   ✅ Banner text verification passed.');

  // Take screenshot of the banner
  const screenshotPathArtifact = path.join(ARTIFACT_DIR, 'blocker_001_banner.png');
  const screenshotPathEvidence = path.join(EVIDENCE_DIR, 'blocker_001_banner.png');
  await page.screenshot({ path: screenshotPathArtifact });
  await page.screenshot({ path: screenshotPathEvidence });
  console.log('   📸 Saved screenshot to:', screenshotPathArtifact);

  // 8. Test clicking "Version History"
  console.log('9. Testing Version History button in banner...');
  const vhBtn = page.locator('#banner-open-history-btn');
  await vhBtn.click();
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

  // 9. Test dismiss button ('X')
  console.log('10. Testing dismiss button (#dismiss-reconnect-notice-btn)...');
  await page.click('#dismiss-reconnect-notice-btn');
  await page.waitForTimeout(500);

  const bannerStillVisible = await page.isVisible('#blocker-001-reconnect-notice');
  console.log('    Banner visibility after dismiss:', bannerStillVisible ? 'FAIL (still visible)' : '✅ PASS (dismissed)');
  if (bannerStillVisible) {
    throw new Error('Dismiss button did not dismiss the banner');
  }

  await browser.close();
  console.log('\n======================================================');
  console.log('🎉 ALL BLOCKER-001 BANNER CHECKS PASSED PERFECTLY!');
  console.log('======================================================\n');
}

runTest().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
