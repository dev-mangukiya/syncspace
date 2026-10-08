import { chromium } from '@playwright/test';

const PROD_URL = 'https://syncspace-bay.vercel.app';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testTurnstileSignup() {
  console.log('Testing browser signup with real Turnstile widget...');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${PROD_URL}/auth/signup`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Check turnstile widget
  const turnstileResponse = await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '');
  console.log('Turnstile token present:', !!turnstileResponse, turnstileResponse ? `Length: ${turnstileResponse.length}` : 'Empty');

  const ts = Date.now().toString().slice(-6);
  await page.fill('#username', `devtest_${ts}`);
  await page.fill('#email', `dev.mangukiya@djsce.edu.in`);
  await page.fill('#password', 'TestPassword123!');
  await page.check('#terms-checkbox');

  console.log('Submitting signup form...');
  const [response] = await Promise.all([
    page.waitForResponse(res => res.url().includes('/api/auth/signup')),
    page.click('#signup-submit-btn'),
  ]);

  console.log('Signup HTTP Status:', response.status());
  const json = await response.json();
  console.log('Signup Response:', JSON.stringify(json, null, 2));

  await page.waitForTimeout(2000);
  console.log('Current URL after submit:', page.url());

  await browser.close();
}

testTurnstileSignup().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
