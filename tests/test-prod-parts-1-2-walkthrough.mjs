import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const PROD_URL = 'https://syncspace-bay.vercel.app';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARTIFACT_DIR = '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45';

async function runBrowserWalkthrough() {
  console.log('=== REAL PRODUCTION BROWSER WALKTHROUGH: PARTS 1 & 2 ===');
  console.log('Target:', PROD_URL);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // 1. Walkthrough Signup Page
  console.log('\n1. Navigating to /auth/signup in real browser...');
  await page.goto(`${PROD_URL}/auth/signup`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const googleSignupBtn = await page.locator('#google-signup-btn');
  const googleBtnVisible = await googleSignupBtn.isVisible();
  console.log(`   [Check] "Continue with Google" button visible: ${googleBtnVisible}`);

  const termsCheckbox = await page.locator('#terms-checkbox');
  const termsCheckboxVisible = await termsCheckbox.isVisible();
  console.log(`   [Check] Terms and Privacy checkbox visible: ${termsCheckboxVisible}`);

  const turnstileContainer = await page.locator('#turnstile-container');
  const turnstileVisible = await turnstileContainer.isVisible();
  console.log(`   [Check] Cloudflare Turnstile container mounted: ${turnstileVisible}`);

  const signupScreenshot = path.join(ARTIFACT_DIR, 'prod_signup_page.png');
  await page.screenshot({ path: signupScreenshot, fullPage: true });
  console.log(`   Screenshot saved: ${signupScreenshot}`);

  // 2. Click "Continue with Google" button and trace full redirect round-trip
  console.log('\n2. Clicking "Continue with Google" and tracing OAuth redirect...');
  const [response] = await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(e => null),
    googleSignupBtn.click(),
  ]);

  const currentUrl = page.url();
  console.log(`   Navigated to URL: ${currentUrl}`);

  // Inspect cookies in context
  const cookies = await context.cookies();
  const oauthCookie = cookies.find(c => c.name === 'syncspace_oauth_state');
  if (oauthCookie) {
    console.log(`   [Success] syncspace_oauth_state cookie stored in browser:`);
    console.log(`     Value: ${oauthCookie.value.slice(0, 16)}...`);
    console.log(`     Domain: ${oauthCookie.domain}`);
    console.log(`     Path: ${oauthCookie.path}`);
    console.log(`     SameSite: ${oauthCookie.sameSite}`);
    console.log(`     Secure: ${oauthCookie.secure}`);
    console.log(`     HttpOnly: ${oauthCookie.httpOnly}`);
  } else {
    console.log(`   [Notice] Cookies present:`, cookies.map(c => c.name));
  }

  const isGoogleAccounts = currentUrl.includes('accounts.google.com');
  console.log(`   [Check] Browser landed on accounts.google.com: ${isGoogleAccounts}`);

  const oauthScreenshot = path.join(ARTIFACT_DIR, 'prod_google_oauth_redirect.png');
  await page.screenshot({ path: oauthScreenshot, fullPage: false });
  console.log(`   Screenshot saved: ${oauthScreenshot}`);

  // 3. Walkthrough Login Page
  console.log('\n3. Navigating to /auth/login in real browser...');
  await page.goto(`${PROD_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  const googleLoginBtn = await page.locator('#google-login-btn');
  const googleLoginBtnVisible = await googleLoginBtn.isVisible();
  console.log(`   [Check] "Continue with Google" button visible on login: ${googleLoginBtnVisible}`);

  const loginScreenshot = path.join(ARTIFACT_DIR, 'prod_login_page.png');
  await page.screenshot({ path: loginScreenshot, fullPage: true });
  console.log(`   Screenshot saved: ${loginScreenshot}`);

  // 4. Walkthrough /terms Page
  console.log('\n4. Navigating to /terms in real browser...');
  await page.goto(`${PROD_URL}/terms`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  const termsText = await page.textContent('body');
  const hasBetaNotice = termsText.includes('Public Beta Disclaimer') && termsText.includes('No Uptime Guarantee');
  const hasBlockerNotice = termsText.includes('BLOCKER-001') && termsText.includes('Offline-Sync Limitation');
  const hasCollected = termsText.includes('Information We Collect');
  console.log(`   [Check] Beta disclaimer present: ${hasBetaNotice}`);
  console.log(`   [Check] BLOCKER-001 offline limitation present: ${hasBlockerNotice}`);
  console.log(`   [Check] Information collected section present: ${hasCollected}`);

  const termsScreenshot = path.join(ARTIFACT_DIR, 'prod_terms_page.png');
  await page.screenshot({ path: termsScreenshot, fullPage: true });
  console.log(`   Screenshot saved: ${termsScreenshot}`);

  // 5. Walkthrough /privacy Page
  console.log('\n5. Navigating to /privacy in real browser...');
  await page.goto(`${PROD_URL}/privacy`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  const privacyText = await page.textContent('body');
  const hasPrivacyCollected = privacyText.includes('Data We Collect');
  const hasInfra = privacyText.includes('Neon') && privacyText.includes('Render') && privacyText.includes('Cloudflare');
  const hasRetentionNotice = privacyText.includes('Offline-Synchronization');
  console.log(`   [Check] Data collected section present: ${hasPrivacyCollected}`);
  console.log(`   [Check] Third-party infrastructure listed: ${hasInfra}`);
  console.log(`   [Check] Offline retention notice present: ${hasRetentionNotice}`);

  const privacyScreenshot = path.join(ARTIFACT_DIR, 'prod_privacy_page.png');
  await page.screenshot({ path: privacyScreenshot, fullPage: true });
  console.log(`   Screenshot saved: ${privacyScreenshot}`);

  await browser.close();
  console.log('\n=== BROWSER WALKTHROUGH COMPLETE ===');
}

runBrowserWalkthrough().catch(err => {
  console.error('Browser walkthrough error:', err);
  process.exit(1);
});
