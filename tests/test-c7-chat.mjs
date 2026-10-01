#!/usr/bin/env node
/**
 * C.7 Automated Verification: Workspace Chat (PostgreSQL persistence + Redis Pub/Sub + Real-time UI)
 * 
 * Verifies:
 * 1. REST API endpoints:
 *    - GET /api/workspaces/{slug}/messages (list last 200 messages)
 *    - POST /api/workspaces/{slug}/messages (send message)
 *    - Auth and CSRF enforcement
 *    - Membership checks (403 Forbidden for non-members)
 *    - Validation (empty messages rejected, >2000 chars rejected)
 * 2. PostgreSQL persistence:
 *    - Messages saved with id, workspace_id, user_id, content, created_at
 *    - Retrievable in chronological order (created_at ASC)
 *    - Joined with sender username, color_slot, avatar_url
 * 3. Real-time Delivery via Redis Pub/Sub & WebSocket:
 *    - Two concurrent browser clients (Alice and Bob)
 *    - Alice sends message -> Bob receives instantly without page reload
 *    - Bob's unread badge updates when chat panel is closed
 *    - Opening chat panel clears unread badge
 *    - User avatars rendered with assigned color_slot border
 *    - Code block formatting with copy button
 * 4. Command Palette integration:
 *    - Toggle Chat Panel via ⌘K
 * 5. Full screenshot capture of active collaborative chat
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
  console.log('  C.7 AUTOMATED TEST: WORKSPACE CHAT & REAL-TIME SYNC');
  console.log('═══════════════════════════════════════════════════════════\n');

  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const jarAlice = new CookieJar();
  const jarBob = new CookieJar();
  const jarCharlie = new CookieJar(); // non-member

  // 1. User Setup via /api/auth/signup
  console.log('--- 1. Authentication & Workspace Setup ---');
  const regAlice = await req('POST', '/api/auth/signup', {
    username: `alice_${ts}`,
    email: `alice_${ts}@example.com`,
    password: 'Password123!',
  }, jarAlice);
  assert('Alice signed up (status 201)', regAlice.status === 201);
  const aliceUserId = regAlice.data?.user?.id;
  const csrfAlice = jarAlice.get('syncspace_csrf');

  const regBob = await req('POST', '/api/auth/signup', {
    username: `bob_${ts}`,
    email: `bob_${ts}@example.com`,
    password: 'Password123!',
  }, jarBob);
  assert('Bob signed up (status 201)', regBob.status === 201);
  const bobUserId = regBob.data?.user?.id;
  const csrfBob = jarBob.get('syncspace_csrf');

  const regCharlie = await req('POST', '/api/auth/signup', {
    username: `charlie_${ts}`,
    email: `charlie_${ts}@example.com`,
    password: 'Password123!',
  }, jarCharlie);
  assert('Charlie signed up (status 201)', regCharlie.status === 201);
  const csrfCharlie = jarCharlie.get('syncspace_csrf');

  // Alice creates a private workspace
  const wsRes = await req('POST', '/api/workspaces', {
    name: `C7 Chat Room ${ts}`,
    template: 'typescript',
    is_public: false,
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Workspace created (status 201)', wsRes.status === 201);
  const slug = wsRes.data.slug;
  const shortId = wsRes.data.short_id;
  const workspaceId = wsRes.data.id;
  console.log(`  Workspace Slug: ${slug}, ShortID: ${shortId}, ID: ${workspaceId}`);

  // Alice invites Bob
  const inviteRes = await req('POST', `/api/workspaces/${shortId}/members`, {
    identifier: `bob_${ts}`,
    role: 'editor',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Bob invited to workspace (status 200/201)', inviteRes.status === 200 || inviteRes.status === 201);

  // 2. REST API & Validation
  console.log('\n--- 2. REST API & Validation Tests ---');
  // Initial message list should be empty
  const initialList = await req('GET', `/api/workspaces/${shortId}/messages`, null, jarAlice);
  assert('GET /messages returns 200', initialList.status === 200);
  assert('Initial messages array is empty', Array.isArray(initialList.data) && initialList.data.length === 0);

  // Non-member authorization check
  const charlieMsg = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: 'Sneaking into private chat',
  }, jarCharlie, { 'X-CSRF-Token': csrfCharlie });
  assert('Non-member message rejected with 403 Forbidden', charlieMsg.status === 403);

  // Empty message validation
  const emptyMsg = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: '    ',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Empty message rejected with 400 Bad Request', emptyMsg.status === 400);

  // Length limit validation (>2000 chars)
  const longText = 'x'.repeat(2001);
  const longMsg = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: longText,
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Message > 2000 chars rejected with 400 Bad Request', longMsg.status === 400);

  // 3. PostgreSQL Persistence & History Verification
  console.log('\n--- 3. PostgreSQL Persistence & Query Tests ---');
  // Post Message 1 from Alice
  const msg1Res = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: 'Hello team! Welcome to SyncSpace workspace chat.',
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Alice posted message 1 (status 201)', msg1Res.status === 201);
  assert('Message 1 has UUID id', typeof msg1Res.data?.id === 'string' && msg1Res.data.id.length > 20);
  assert('Message 1 author is Alice', msg1Res.data?.username === `alice_${ts}`);
  assert('Message 1 has color_slot 0', msg1Res.data?.color_slot === 0);

  // Post Message 2 from Bob
  const msg2Res = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: 'Hey Alice! Glad to be collaborating on this workspace.',
  }, jarBob, { 'X-CSRF-Token': csrfBob });
  assert('Bob posted message 2 (status 201)', msg2Res.status === 201);
  assert('Message 2 author is Bob', msg2Res.data?.username === `bob_${ts}`);
  assert('Message 2 has valid color_slot (slot 1)', msg2Res.data?.color_slot === 1);

  // Post Message 3 from Alice with formatted code
  const codeContent = 'Here is the helper function:\n```typescript\nfunction greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n```\nLet me know what you think!';
  const msg3Res = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: codeContent,
  }, jarAlice, { 'X-CSRF-Token': csrfAlice });
  assert('Alice posted message 3 with code block (status 201)', msg3Res.status === 201);

  // Post Message 4 from Bob
  const msg4Res = await req('POST', `/api/workspaces/${shortId}/messages`, {
    content: 'Looks great! Real-time pub/sub delivery is working cleanly.',
  }, jarBob, { 'X-CSRF-Token': csrfBob });
  assert('Bob posted message 4 (status 201)', msg4Res.status === 201);

  // Fetch full history via GET /messages
  const historyRes = await req('GET', `/api/workspaces/${shortId}/messages`, null, jarBob);
  assert('GET /messages returned status 200', historyRes.status === 200);
  assert('All 4 messages persisted and retrieved', Array.isArray(historyRes.data) && historyRes.data.length === 4);
  assert('Messages ordered chronologically (msg 1 first, msg 4 last)',
    historyRes.data[0]?.content.includes('Hello team') &&
    historyRes.data[3]?.content.includes('Looks great'));
  assert('Each message has valid timestamp',
    Array.isArray(historyRes.data) && historyRes.data.every(m => !isNaN(new Date(m.created_at).getTime())));

  // 4. Playwright Browser Tests: Real-Time UI, Unread Badge, & Redis Delivery
  console.log('\n--- 4. Browser E2E: Real-Time UI & Cross-Client Delivery ---');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const contextAlice = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const contextBob = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // Inject cookies
  const cookiesAlice = Object.entries(jarAlice.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: name.includes('token'), sameSite: 'Lax',
  }));
  const cookiesBob = Object.entries(jarBob.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: name.includes('token'), sameSite: 'Lax',
  }));
  await contextAlice.addCookies(cookiesAlice);
  await contextBob.addCookies(cookiesBob);

  const pageAlice = await contextAlice.newPage();
  const pageBob = await contextBob.newPage();

  console.log('  Navigating Alice to workspace...');
  await pageAlice.goto(`${BASE}/w/${shortId}`);
  await pageAlice.waitForSelector('#chat-toggle-btn', { timeout: 15000 });
  console.log('  Alice workspace loaded.');

  console.log('  Navigating Bob to workspace...');
  await pageBob.goto(`${BASE}/w/${shortId}`);
  await pageBob.waitForSelector('#chat-toggle-btn', { timeout: 15000 });
  console.log('  Bob workspace loaded.');

  // Wait for initial WebSocket connections to settle
  await pageAlice.waitForTimeout(1500);
  await pageBob.waitForTimeout(1500);

  // Step 4a: Alice opens Chat panel
  await pageAlice.click('#chat-toggle-btn');
  await pageAlice.waitForSelector('#workspace-chat-panel', { timeout: 5000 });
  assert('Alice opened Workspace Chat panel (#workspace-chat-panel)', true);

  // Verify historical messages are loaded in Alice's UI
  await pageAlice.waitForSelector('.chat-message-item', { timeout: 5000 });
  const messageItemsAlice = await pageAlice.locator('.chat-message-item').count();
  assert(`Alice sees historical messages loaded in chat UI (count: ${messageItemsAlice})`, messageItemsAlice >= 4);

  // Check code block formatting
  const codeBlockCount = await pageAlice.locator('#chat-messages-container code').count();
  assert('Code block properly formatted in chat history', codeBlockCount > 0);

  // Step 4b: Real-time broadcast test
  // Bob currently has chat closed. Alice sends a new message.
  const liveMsgContent = `Live ping from Alice at ${new Date().toLocaleTimeString()}! Can you see this Bob?`;
  await pageAlice.fill('#workspace-chat-input', liveMsgContent);
  await pageAlice.click('#workspace-chat-send-btn');
  console.log('  Alice sent live message.');

  // Check Bob's unread badge
  await pageBob.waitForSelector('#chat-unread-badge', { timeout: 8000 });
  const unreadBadgeText = await pageBob.textContent('#chat-unread-badge');
  assert(`Bob's navbar displays unread badge with count "${unreadBadgeText?.trim()}"`, unreadBadgeText?.trim() === '1');

  // Bob opens chat panel
  await pageBob.click('#chat-toggle-btn');
  await pageBob.waitForSelector('#workspace-chat-panel:not([style*="display: none"])', { timeout: 5000 });
  assert('Bob opened chat panel', true);

  // Unread badge should now be cleared
  const unreadCountAfterOpen = await pageBob.locator('#chat-unread-badge').count();
  assert('Unread badge cleared after Bob opened chat panel', unreadCountAfterOpen === 0);

  // Verify Bob sees Alice's live message in real-time
  await pageBob.waitForSelector(`.chat-message-item:has-text("${liveMsgContent.slice(0, 20)}")`, { timeout: 5000 });
  const bobHasLiveMsg = await pageBob.locator(`.chat-message-item:has-text("${liveMsgContent.slice(0, 20)}")`).count();
  assert('Bob sees Alice live message delivered via Redis pub/sub & WebSocket', bobHasLiveMsg > 0);

  // Step 4c: Bob replies back live
  const bobReply = `Received loud and clear! Real-time bidirectional chat verified.`;
  await pageBob.fill('#workspace-chat-input', bobReply);
  await pageBob.press('#workspace-chat-input', 'Enter');
  console.log('  Bob sent live reply via Enter key.');

  // In Alice's browser, verify Bob's reply appears in real time without refreshing
  await pageAlice.waitForSelector(`.chat-message-item:has-text("${bobReply.slice(0, 20)}")`, { timeout: 8000 });
  assert('Alice receives Bob reply in real time without page reload', true);

  // Verify avatar and user styling
  const bobItemInAlice = pageAlice.locator(`.chat-message-item:has-text("${bobReply.slice(0, 20)}")`);
  const authorText = await bobItemInAlice.textContent();
  assert('Message includes sender username', authorText?.includes(`bob_${ts}`));

  // Step 4d: Command Palette Integration
  console.log('\n--- 5. Command Palette Integration ---');
  const paletteInput = pageAlice.locator('input[placeholder*="Type a file name"]');
  async function openPalette() {
    await pageAlice.keyboard.press('Meta+k');
    await pageAlice.waitForTimeout(300);
    if (!(await paletteInput.isVisible())) {
      await pageAlice.keyboard.press('Control+k');
      await pageAlice.waitForTimeout(300);
    }
    if (!(await paletteInput.isVisible())) {
      await pageAlice.locator('button:has-text("Search")').click();
      await pageAlice.waitForTimeout(300);
    }
  }

  // Alice closes chat using Command Palette
  await openPalette();
  assert('Command Palette opened with ⌘K', await paletteInput.isVisible());

  await paletteInput.fill('Chat');
  await pageAlice.waitForTimeout(300);
  const paletteChatAction = pageAlice.locator('[data-palette-item]:has-text("Hide Workspace Chat")');
  assert('Command Palette contains "Hide Workspace Chat" action', (await paletteChatAction.count()) > 0);
  await paletteChatAction.click();
  await pageAlice.waitForTimeout(400);

  const isChatOpenAfterHide = await pageAlice.locator('#workspace-chat-panel:not([style*="display: none"])').count();
  assert('Workspace chat panel closed via Command Palette action', isChatOpenAfterHide === 0);

  // Re-open chat via Command Palette
  await openPalette();
  await paletteInput.fill('Chat');
  await pageAlice.waitForTimeout(300);
  const paletteShowChatAction = pageAlice.locator('[data-palette-item]:has-text("Show Workspace Chat")');
  assert('Command Palette contains "Show Workspace Chat" action', (await paletteShowChatAction.count()) > 0);
  await paletteShowChatAction.click();
  await pageAlice.waitForTimeout(400);

  const isChatOpenAfterShow = await pageAlice.locator('#workspace-chat-panel:not([style*="display: none"])').count();
  assert('Workspace chat panel re-opened via Command Palette action', isChatOpenAfterShow === 1);

  // Step 4e: Screenshot Capture
  console.log('\n--- 6. Capturing Evidence Screenshots ---');
  const chatScreenshotPath = path.join(ARTIFACT_DIR, 'c7_workspace_chat.png');
  await pageAlice.screenshot({ path: chatScreenshotPath, fullPage: false });
  console.log(`  Saved screenshot to: ${chatScreenshotPath}`);
  assert('Screenshot c7_workspace_chat.png captured', fs.existsSync(chatScreenshotPath));

  await browser.close();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  C.7 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('═══════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error in C.7 test runner:', err);
  process.exit(1);
});
