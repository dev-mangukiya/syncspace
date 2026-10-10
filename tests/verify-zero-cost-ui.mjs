import { chromium } from 'playwright';

const PROD_URL = 'https://syncspace-bay.vercel.app';

async function main() {
  console.log('Logging in to live site via API as unverified user...');
  const loginRes = await fetch(`${PROD_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'unverified_1791374084033@syncspace-test.internal',
      password: 'StrongPassword123!',
    }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed with status ${loginRes.status}`);
  }

  const rawSetCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
  const parsedCookies = rawSetCookies.map(cookieStr => {
    const parts = cookieStr.split(';').map(p => p.trim());
    const [name, ...valParts] = parts[0].split('=');
    const value = valParts.join('=');
    return {
      name,
      value,
      domain: 'syncspace-bay.vercel.app',
      path: name === 'syncspace_refresh' ? '/api/auth' : '/',
      httpOnly: name.includes('access') || name.includes('refresh'),
      secure: true,
    };
  });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  await context.addCookies(parsedCookies);

  const page = await context.newPage();

  console.log('1. Navigating to dashboard as unverified user...');
  await page.goto(`${PROD_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45/unverified_dashboard.png', fullPage: true });

  const dashboardBanner = await page.$('#email-unverified-banner');
  console.log('   Dashboard banner found:', !!dashboardBanner);
  if (dashboardBanner) {
    const bannerText = await dashboardBanner.innerText();
    console.log('   Dashboard banner text:\n   ' + bannerText.replace(/\n/g, '\n   '));
    const dashGoogleBtn = await page.$('#dashboard-google-unlock-btn');
    console.log('   Dashboard Google unlock button href:', await dashGoogleBtn?.getAttribute('href'));
  }

  console.log('\n2. Navigating to workspace as unverified user...');
  await page.goto(`${PROD_URL}/w/3311cdf85d4b471ea6b093f4bfbf767a`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Click Run button
  console.log('3. Clicking Run button in workspace...');
  const runBtn = await page.waitForSelector('button:has-text("Run")');
  await runBtn.click();
  await page.waitForTimeout(3000);

  const blockedBanner = await page.$('#email-blocked-banner');
  console.log('   Output panel blocked banner found:', !!blockedBanner);
  if (blockedBanner) {
    const text = await blockedBanner.innerText();
    console.log('   Output panel banner text:\n   ' + text.replace(/\n/g, '\n   '));
    const googleBtn = await page.$('#google-unlock-run-btn');
    console.log('   Output panel Google unlock button href:', await googleBtn?.getAttribute('href'));
  }

  await page.screenshot({ path: '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45/unverified_workspace_blocked.png', fullPage: true });

  await browser.close();
  console.log('\nVerification completed successfully!');
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
