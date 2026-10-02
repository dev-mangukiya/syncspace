#!/usr/bin/env node
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACTS_DIR = '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45';

async function main() {
  const executablePath = '/Users/devmangukiya/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Navigating to http://localhost:3000/brand...');
  await page.goto('http://localhost:3000/brand', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const screenshotPath = path.join(ARTIFACTS_DIR, 'brand_page_actual_size.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✓ Saved /brand screenshot to: ${screenshotPath}`);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
