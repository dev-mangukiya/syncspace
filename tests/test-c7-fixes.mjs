#!/usr/bin/env node
/**
 * C.7 Verification: XSS-Safety Proof & Per-User Rate Limiting
 * 
 * Verifies:
 * 1. XSS-Safety in Chat Rendering:
 *    - Posts raw HTML strings: <script>alert('xss')</script>, <img src=x onerror=alert(1)>, javascript:alert(1)
 *    - Playwright dialog listener confirms ZERO alerts execute
 *    - DOM inspection confirms strings render as escaped Text nodes, NOT executed HTML
 *    - Protocol check confirms javascript: never becomes a clickable link
 * 2. Per-User Rate Limiting:
 *    - 30 messages/minute limit per user
 *    - Burst of 30 rapid messages from Alice -> all succeed (HTTP 201)
 *    - Message #31 from Alice -> rejected with HTTP 429 ("too many messages, please slow down")
 *    - Retry-After header verified
 *    - Bob sends a message in the same workspace immediately after Alice is rate-limited -> succeeds (HTTP 201)
 *    - Proves rate limit is strictly isolated per user
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

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  C.7 FIXES VERIFICATION: XSS SAFETY & CHAT RATE LIMITING');
  console.log('═══════════════════════════════════════════════════════════\n');

  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const jarAlice = new CookieJar();
  const jarBob = new CookieJar();

  // 1. Setup Alice and Bob
  console.log('--- 1. Authentication & Workspace Setup ---');
  const regAlice = await req('POST', '/api/auth/signup', {
    username: `alice_xss_${ts}`,
    email: `alice_xss_${ts}@example.com`,
    password: 'Password123!',
  }, jarAlice);
  assert('Alice signed up (status 201)', regAlice.status === 201);
  const csrfAlice = jarAlice.get('syncspace_csrf');

  const regBob = await req('POST', '/api/auth/signup', {
    username: `bob_xss_${ts}`,
    email: `bob_xss_${ts}@example.com`,
    password: 'Password123!',
  }, jarBob);
  assert('Bob signed up (status 201)', regBob.status === 201);
  const csrfBob = jarBob.get('syncspace_csrf');

  const wsRes = await req('POST', '/api/workspaces', {
    name: `XSS & RateLimit Test ${ts}`,
    template: 'typescript',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Workspace created (status 201)', wsRes.status === 201);
  const shortId = wsRes.data.short_id;

  // Invite Bob to workspace
  const inviteRes = await req('POST', `/api/workspaces/${shortId}/members`, {
    identifier: `bob_xss_${ts}`,
    role: 'editor',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Bob invited as editor (status 200/201)', inviteRes.status === 200 || inviteRes.status === 201);

  // 2. XSS Safety Tests
  console.log('\n--- 2. XSS Safety Proof ---');
  const xssPayloads = [
    "<script>window.__xss_executed = true; alert('XSS script');</script>",
    "<img src='invalid-image' onerror=\"window.__xss_img_executed = true; alert('XSS img');\" />",
    "javascript:alert('XSS javascript URI')",
    "```html\n<script>alert('XSS in codeblock')</script>\n```",
    "Check out https://syncspace.dev and javascript:alert(1) test",
  ];

  for (let i = 0; i < xssPayloads.length; i++) {
    const payloadRes = await req('POST', `/api/workspaces/${shortId}/messages`, {
      content: xssPayloads[i],
    }, jarAlice, { 'X-CSRF-Token': csrfAlice });
    assert(`Posted XSS test payload #${i + 1} (status 201)`, payloadRes.status === 201);
  }

  // Launch browser and verify that no script runs and elements are safe
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const cookiesAlice = Object.entries(jarAlice.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: name.includes('token'), sameSite: 'Lax',
  }));
  await context.addCookies(cookiesAlice);

  const page = await context.newPage();

  // Attach dialog listener: if any alert fires, fail immediately!
  let alertFired = false;
  page.on('dialog', async (dialog) => {
    alertFired = true;
    console.log(`  ❌ UNEXPECTED DIALOG FIRED: ${dialog.message()}`);
    await dialog.dismiss();
  });

  await page.goto(`${BASE}/w/${shortId}`);
  await page.waitForSelector('#chat-toggle-btn', { timeout: 15000 });
  await page.click('#chat-toggle-btn');
  await page.waitForSelector('#workspace-chat-panel:not([style*="display: none"])', { timeout: 5000 });
  await page.waitForSelector('.chat-message-item', { timeout: 5000 });

  // Wait to ensure any potential script execution would have triggered
  await page.waitForTimeout(1000);

  // Assertions on browser execution state
  assert('Zero alert() dialogs were triggered (alertFired === false)', !alertFired);

  const windowXssState = await page.evaluate(() => {
    return {
      xssScript: !!(window).__xss_executed,
      xssImg: !!(window).__xss_img_executed,
      scriptTagsInChat: document.querySelectorAll('#chat-messages-container script').length,
      imgTagsInChat: document.querySelectorAll('#chat-messages-container img[onerror]').length,
      javascriptLinksInChat: document.querySelectorAll('#chat-messages-container a[href^="javascript:"]').length,
      safeLinksInChat: document.querySelectorAll('#chat-messages-container a[href^="https://syncspace.dev"]').length,
    };
  });

  assert('window.__xss_executed is false', windowXssState.xssScript === false);
  assert('window.__xss_img_executed is false', windowXssState.xssImg === false);
  assert('Zero <script> tags injected into chat DOM', windowXssState.scriptTagsInChat === 0);
  assert('Zero <img onerror> tags injected into chat DOM', windowXssState.imgTagsInChat === 0);
  assert('Zero javascript: links created as <a> anchors', windowXssState.javascriptLinksInChat === 0);
  assert('Valid https:// URL rendered as safe anchor', windowXssState.safeLinksInChat === 1);

  await browser.close();

  // 3. Per-User Rate Limiting Verification
  console.log('\n--- 3. Per-User Rate Limiting on Chat POST ---');
  console.log('  Testing 30 messages/minute limit per user...');

  // Alice already posted 5 messages in step 2.
  // We send 25 more messages to reach exactly 30 messages within the minute.
  let aliceSuccessCount = 5;
  for (let i = 6; i <= 30; i++) {
    const postRes = await req('POST', `/api/workspaces/${shortId}/messages`, {
      content: `Rapid burst message #${i} from Alice`,
    }, jarAlice, { 'X-CSRF-Token': csrfAlice });
    if (postRes.status === 201) {
      aliceSuccessCount++;
    } else {
      console.log(`  Unexpected status for msg #${i}: ${postRes.status}`);
    }
  }
  assert('Alice sent up to limit (30 messages succeeded with 201)', aliceSuccessCount === 30);

  // Message 31 from Alice MUST be rejected with 429
  const rateLimitHit = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: 'Message #31 which exceeds rate limit',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });

  assert('Message #31 from Alice returns HTTP 429 Too Many Requests', rateLimitHit.status === 429);
  assert('Rate limit error response says "too many messages, please slow down"',
    rateLimitHit.data?.error === 'too many messages, please slow down');
  assert('Retry-After header is returned (60 seconds)',
    rateLimitHit.headers.get('retry-after') === '60');

  // Verify rate limit is strictly PER-USER:
  // Bob (a different user) sends a message right now in the same workspace
  console.log('\n  Verifying isolation: Bob sends a message while Alice is rate-limited...');
  const bobPostRes = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: 'Hello from Bob! My rate limit bucket is completely separate.',
  }, jarBob, { 'X-CSRF-Token': csrfBob });

  assert('Bob request succeeds with HTTP 201 while Alice is rate-limited', bobPostRes.status === 201);
  assert('Bob message author is Bob', bobPostRes.data?.username === `bob_xss_${ts}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  C.7 FIXES RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('═══════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error in C.7 fixes test runner:', err);
  process.exit(1);
});
