import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Set auth cookies directly to log in as unverified_084033
  await context.addCookies([
    {
      name: 'syncspace_access',
      value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiMDAzZTkwZjQtMGVhYS00ZmNjLWEwODktZDQ4ZmUzYjA5MjBhIiwidXNlcm5hbWUiOiJ1bnZlcmlmaWVkXzA4NDAzMyIsImVtYWlsIjoidW52ZXJpZmllZF8xNzkxMzc0MDg0MDMzQHN5bmNzcGFjZS10ZXN0LmludGVybmFsIiwiaXNzIjoic3luY3NwYWNlIiwic3ViIjoiYWNjZXNzIiwiZXhwIjoxNzkxNDQ5Njc1LCJpYXQiOjE3OTE0NDg3NzV9.WreByU-jK2wnAd9SPcs1xBM-THbAzYJakA90SpI2W2Q',
      domain: 'syncspace-bay.vercel.app',
      path: '/',
      httpOnly: true,
      secure: true,
    },
    {
      name: 'syncspace_csrf',
      value: 'ee5cd44e63c7032ae55db976c530ab58',
      domain: 'syncspace-bay.vercel.app',
      path: '/',
      secure: false,
    }
  ]);

  console.log('1. Navigating to dashboard as unverified user...');
  await page.goto('https://syncspace-bay.vercel.app/dashboard', { waitUntil: 'networkidle' });
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
  await page.goto('https://syncspace-bay.vercel.app/w/3311cdf85d4b471ea6b093f4bfbf767a', { waitUntil: 'networkidle' });
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
