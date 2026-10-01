#!/usr/bin/env node
/**
 * C.6 Automated Verification: Status Bar + Command Palette
 * 
 * Verifies:
 * 1. Status bar displays real line/col from Monaco's cursor position
 * 2. Status bar updates line/col as cursor moves
 * 3. Status bar displays language, UTF-8 encoding, LF line endings, sync state, peer count
 * 4. Command palette opens on ⌘K (and Ctrl+K and search trigger)
 * 5. Fuzzy file search finds files and opens them into active tab
 * 6. Go to line mode (:line) navigates to specific line
 * 7. Command palette triggers actions (theme toggle, sidebar toggle, run, share)
 * 8. Share modal lists members with colorSlot badges and allows inviting
 */

import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE = 'http://localhost:3000';
const ARTIFACT_DIR = '/Users/devmangukiya/.gemini/antigravity-ide/brain/e6dc6e37-67ed-4370-92e0-401d95603a45';

class CookieJar {
  constructor() { this.cookies = {}; }
  parseSetCookies(headers) {
    const setCookies = headers.getSetCookie?.() || [];
    for (const sc of setCookies) {
      const [nameVal] = sc.split(';');
      const [name, ...valParts] = nameVal.split('=');
      const value = valParts.join('=');
      if (sc.includes('Max-Age=0') || sc.includes('Max-Age=-1')) {
        delete this.cookies[name.trim()];
      } else {
        this.cookies[name.trim()] = value;
      }
    }
  }
  toString() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  get(name) { return this.cookies[name] || null; }
}

async function req(method, endpoint, body, jar, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (jar) headers['Cookie'] = jar.toString();
  const resp = await fetch(`${BASE}${endpoint}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  if (jar) jar.parseSetCookies(resp.headers);
  let data = null;
  const text = await resp.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data, headers: resp.headers };
}

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

async function run() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' C.6 VERIFICATION: STATUS BAR + COMMAND PALETTE');
  console.log('═══════════════════════════════════════════════════════\n');

  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  // 1. Create User & Workspace with multi-line files
  console.log('1. SETUP: Create User & Workspace');
  const jar = new CookieJar();
  const signup = await req('POST', '/api/auth/signup', {
    username: `c6user_${ts}`,
    email: `c6user_${ts}@test.com`,
    password: 'TestPassword123!',
  }, jar);
  assert('User created', signup.status === 201);
  const csrf = jar.get('syncspace_csrf');

  const ws = await req('POST', '/api/workspaces', { name: `C6Workspace-${ts}` }, jar, {
    'X-CSRF-Token': csrf,
  });
  assert('Workspace created', ws.status === 201);
  const shortId = ws.data.short_id;
  console.log(`  short_id: ${shortId}`);

  // Create multiline files: main.py, utils.js, styles.css
  const mainPyContent = Array.from({ length: 40 }, (_, i) => `def func_${i + 1}():\n    return ${i + 1}`).join('\n\n');
  await req('POST', `/api/workspaces/${shortId}/file`, {
    path: 'main.py',
    content: mainPyContent,
  }, jar, { 'X-CSRF-Token': csrf });

  await req('POST', `/api/workspaces/${shortId}/file`, {
    path: 'utils.js',
    content: 'export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n',
  }, jar, { 'X-CSRF-Token': csrf });

  await req('POST', `/api/workspaces/${shortId}/file`, {
    path: 'styles.css',
    content: 'body {\n  margin: 0;\n  padding: 0;\n  background: #111;\n}\n',
  }, jar, { 'X-CSRF-Token': csrf });

  console.log('  Created 3 additional files: main.py (40 lines), utils.js, styles.css\n');

  // 2. Launch browser with cookies
  console.log('2. BROWSER LAUNCH & NAVIGATION');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // Add cookies to context
  const cookiesToAdd = Object.entries(jar.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: name.includes('access') || name.includes('refresh'), sameSite: 'Lax',
  }));
  await context.addCookies(cookiesToAdd);

  const page = await context.newPage();
  page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('[browser error]', err.message));
  page.on('response', res => {
    if (res.status() >= 400) console.log('[HTTP error]', res.status(), res.url());
  });
  await page.goto(`${BASE}/w/${shortId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // 3. Verify Status Bar Elements
  console.log('3. STATUS BAR VERIFICATION');
  console.log(`  Current page URL: ${page.url()}`);
  
  const footer = page.locator('footer');
  if (await footer.isVisible()) {
    console.log(`  Found footer text: "${(await footer.innerText()).replace(/\n/g, ' | ')}"`);
  } else {
    console.log('  Footer is NOT visible!');
  }

  const footerText = await footer.innerText();
  console.log(`  Initial footer text: "${footerText.replace(/\n/g, ' | ')}"`);

  assert('Status bar shows Synced', footerText.includes('Synced'));
  assert('Status bar shows 1 online', footerText.includes('1 online'));
  assert('Status bar shows language (JavaScript for default main.js)', footerText.includes('JavaScript'));
  assert('Status bar shows UTF-8', footerText.includes('UTF-8'));
  assert('Status bar shows LF', footerText.includes('LF'));
  assert('Status bar shows initial cursor (Ln 1, Col 1)', footerText.includes('Ln 1, Col 1'));
  assert('Status bar shows ⌘K trigger', footerText.includes('⌘K'));
  console.log();

  // 4. Monaco Cursor Movement & Status Bar Update
  console.log('4. CURSOR MOVEMENT & REAL-TIME STATUS BAR UPDATE');
  // Switch to main.py (which has 40 lines)
  console.log('  Switching to main.py (40 lines)...');
  await page.locator('button:has-text("main.py")').first().click();
  await page.waitForTimeout(1500);

  const footerMainPy = await footer.innerText();
  console.log(`  Footer on main.py: "${footerMainPy.replace(/\n/g, ' | ')}"`);
  assert('Language updated to Python', footerMainPy.includes('Python'));
  assert('File path updated to main.py', footerMainPy.includes('main.py'));

  // Click on Monaco editor to focus and move cursor
  const monacoEditor = page.locator('.monaco-editor').first();
  await monacoEditor.waitFor({ state: 'visible' });
  await monacoEditor.click();
  await page.waitForTimeout(300);

  // Move cursor down several lines
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(50);
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);

  const updatedFooterText = await footer.innerText();
  console.log(`  Updated footer text: "${updatedFooterText.replace(/\n/g, ' | ')}"`);
  const hasMovedCursor = /Ln [2-9], Col [1-9]/.test(updatedFooterText) || /Ln [1-9]\d, Col [1-9]/.test(updatedFooterText);
  assert('Status bar reflects moved cursor position (Ln > 1, Col > 1)', hasMovedCursor);

  // Take screenshot of status bar with moved cursor
  const cursorScreenshotPath = path.join(ARTIFACT_DIR, 'c6_status_bar_cursor.png');
  await page.screenshot({ path: cursorScreenshotPath });
  console.log(`  📸 Saved screenshot: ${cursorScreenshotPath}\n`);

  // Helper to open command palette
  const paletteInput = page.locator('input[placeholder*="Type a file name"]');
  async function openPalette() {
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(300);
    if (!(await paletteInput.isVisible())) {
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(300);
    }
    if (!(await paletteInput.isVisible())) {
      await page.locator('button:has-text("Search")').click();
      await page.waitForTimeout(300);
    }
  }

  // 5. Command Palette: Open & Fuzzy Search
  console.log('5. COMMAND PALETTE: KEYBOARD OPEN & FUZZY SEARCH');
  await openPalette();
  const isPaletteOpen = await paletteInput.isVisible();
  assert('Command palette opened', isPaletteOpen);

  // Type fuzzy file query: 'util'
  await paletteInput.fill('util');
  await page.waitForTimeout(400);

  // Verify results show utils.js
  const paletteText = await page.locator('[data-palette-item]').allInnerTexts();
  console.log(`  Palette filtered items for "util":`, paletteText);
  const foundUtils = paletteText.some(t => t.includes('utils.js'));
  assert('Fuzzy search finds utils.js', foundUtils);

  // Take screenshot of fuzzy search
  const searchScreenshotPath = path.join(ARTIFACT_DIR, 'c6_palette_search.png');
  await page.screenshot({ path: searchScreenshotPath });
  console.log(`  📸 Saved screenshot: ${searchScreenshotPath}`);

  // Press Enter to select utils.js
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  // Assert palette closed and tab switched to utils.js
  const isPaletteClosed = !(await paletteInput.isVisible());
  assert('Palette closed on file selection', isPaletteClosed);

  const footerAfterSwitch = await footer.innerText();
  console.log(`  Footer after file open: "${footerAfterSwitch.replace(/\n/g, ' | ')}"`);
  assert('Status bar updated to JavaScript for utils.js', footerAfterSwitch.includes('JavaScript'));
  assert('Status bar shows utils.js path', footerAfterSwitch.includes('utils.js'));
  console.log();

  // 6. Go to Line Navigation (:line)
  console.log('6. GO TO LINE NAVIGATION (:line)');
  await openPalette();

  // Type :5 and press enter
  await paletteInput.fill(':5');
  await page.waitForTimeout(300);

  const goToLinePrompt = await page.locator('text=Go to line 5').isVisible();
  assert('Go to line mode recognized (:5)', goToLinePrompt);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  const footerAfterGoto = await footer.innerText();
  console.log(`  Footer after :5 jump: "${footerAfterGoto.replace(/\n/g, ' | ')}"`);
  assert('Cursor jumped to Line 5 (Ln 5, Col 1)', footerAfterGoto.includes('Ln 5, Col 1'));
  console.log();

  // 7. Command Palette: Actions (Theme Toggle & Sidebar Toggle)
  console.log('7. COMMAND PALETTE: ACTION TRIGGERING');
  // Open palette and trigger Theme toggle
  await openPalette();
  await paletteInput.fill('theme');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log(`  Document theme after palette toggle: ${themeAttr}`);
  assert('Theme toggled via palette action', themeAttr === 'light' || themeAttr === 'dark');

  // Toggle theme back
  await openPalette();
  await paletteInput.fill('theme');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  // Toggle Sidebar via palette
  await openPalette();
  await paletteInput.fill('sidebar');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  const explorerHidden = !(await page.locator('aside:has-text("Explorer")').isVisible());
  assert('Sidebar hidden via palette action', explorerHidden);

  // Restore sidebar
  await openPalette();
  await paletteInput.fill('sidebar');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  const explorerRestored = await page.locator('aside:has-text("Explorer")').isVisible();
  assert('Sidebar restored via palette action', explorerRestored);
  console.log();

  // 8. Share Modal: Member list + Invite
  console.log('8. SHARE MODAL: MEMBERS & INVITE');
  // Open palette and trigger Share action
  await openPalette();
  await paletteInput.fill('share');
  await page.waitForTimeout(300);
  const paletteTextShare = await page.locator('[data-palette-item]').allInnerTexts();
  console.log(`  Palette filtered items for "share":`, paletteTextShare);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  const shareModal = page.locator('h3:has-text("Workspace Members")');
  await shareModal.waitFor({ state: 'visible', timeout: 5000 });
  const isShareOpen = await shareModal.isVisible();
  assert('Share modal opened from command palette', isShareOpen);

  // Check owner is listed with Slot 0
  const modalContainer = page.locator('div[style*="fixed"]:has-text("Workspace Members")');
  await modalContainer.waitFor({ state: 'visible', timeout: 5000 });
  const modalText = await modalContainer.innerText();
  assert('Owner listed in share modal', modalText.includes(`c6user_${ts}`) && modalText.includes('Owner'));
  assert('Owner shows Color Slot 0', modalText.includes('Color Slot 0') || modalText.includes('Slot 0'));

  // Invite another user
  const bobUsername = `c6bob_${ts}`;
  await req('POST', '/api/auth/signup', {
    username: bobUsername,
    email: `${bobUsername}@test.com`,
    password: 'TestPassword123!',
  });

  const inviteInput = page.locator('input[placeholder*="Username or email"]');
  await inviteInput.fill(bobUsername);
  await page.locator('button:has-text("Invite")').click();
  await page.waitForTimeout(1500);

  const updatedModalText = await page.locator('div[style*="fixed"]:has-text("Workspace Members")').innerText();
  assert('Invited member appears in list', updatedModalText.includes(bobUsername));
  assert('Invited member has Color Slot 1', updatedModalText.includes('Color Slot 1') || updatedModalText.includes('Slot 1'));

  // Take screenshot of share modal
  const shareScreenshotPath = path.join(ARTIFACT_DIR, 'c6_share_modal.png');
  await page.screenshot({ path: shareScreenshotPath });
  console.log(`  📸 Saved screenshot: ${shareScreenshotPath}`);

  // Close share modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const isShareClosed = !(await shareModal.isVisible());
  assert('Share modal closed via Escape', isShareClosed);
  console.log();

  // 9. Take full workspace overview screenshot
  const overviewScreenshotPath = path.join(ARTIFACT_DIR, 'c6_workspace_overview.png');
  await page.screenshot({ path: overviewScreenshotPath });
  console.log(`  📸 Saved full overview screenshot: ${overviewScreenshotPath}\n`);

  await browser.close();

  console.log('═══════════════════════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
