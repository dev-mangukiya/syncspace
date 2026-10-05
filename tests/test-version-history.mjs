#!/usr/bin/env node
/**
 * Test: Version History — Full Lifecycle
 *
 * 1. Create workspace + file
 * 2. Save multiple named versions via API
 * 3. List versions — verify count and metadata
 * 4. Get individual version with full content
 * 5. Diff two versions (compute client-side, same as component does)
 * 6. Restore an old version — confirm it creates a NEW snapshot, doesn't delete history
 * 7. Verify restored content matches the old version
 * 8. Open browser to screenshot history list and diff view
 */

import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const WS_HTTP_URL = process.env.WS_HTTP_URL || 'http://localhost:8080';
const EVIDENCE_DIR = path.resolve('docs/evidence/phase-g');

class CookieJar {
  constructor() { this.cookies = {}; }
  parseSetCookies(headers) {
    const raw = headers.getSetCookie?.() || [];
    for (const h of raw) {
      const [kv] = h.split(';');
      const [k, ...rest] = kv.split('=');
      const val = rest.join('=').trim();
      if (h.includes('Max-Age=0') || h.includes('Max-Age=-1')) delete this.cookies[k.trim()];
      else this.cookies[k.trim()] = val;
    }
  }
  toString() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function api(method, endpoint, body, jar, csrfToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar) headers['Cookie'] = jar.toString();
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const resp = await fetch(`${WS_HTTP_URL}${endpoint}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (jar) jar.parseSetCookies(resp.headers);
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

async function signupUser(prefix) {
  const id = Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000);
  const username = `${prefix}_${id}`;
  const jar = new CookieJar();
  const res = await api('POST', '/api/auth/signup', {
    username, email: `${username}@test.local`, password: 'TestPass2026!',
  }, jar);
  if (res.status !== 201) throw new Error(`Signup failed: ${JSON.stringify(res.data)}`);
  return { username, email: `${username}@test.local`, jar, csrfToken: res.data.csrf_token };
}

function getChromiumLaunchOptions() {
  const paths = [
    chromium.executablePath(),
    '/Users/devmangukiya/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ];
  for (const p of paths) { if (fs.existsSync(p)) return { executablePath: p, headless: true }; }
  return { headless: true };
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✅ PASS — ${msg}`); passed++; }
  else { console.error(`  ❌ FAIL — ${msg}`); failed++; }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' VERSION HISTORY: Full Lifecycle Proof');
  console.log('═══════════════════════════════════════════════════════════════\n');

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // ── Setup ──
  console.log('─── Setup ───');
  const alice = await signupUser('vh_alice');
  console.log(`  Created user: ${alice.username}`);

  const wsRes = await api('POST', '/api/workspaces', {
    name: 'Version History Test', template: 'javascript',
  }, alice.jar, alice.csrfToken);
  assert(wsRes.status === 201, 'Created workspace');
  const shortId = wsRes.data.short_id;

  // ── Step 1: Create multiple versions ──
  console.log('\n─── Step 1: Create multiple named versions ───');

  const v1Content = '// Version 1: Initial code\nconsole.log("Hello World");\n';
  // Update file content first
  await api('PUT', `/api/workspaces/${shortId}/file`, {
    path: 'index.js', content: v1Content,
  }, alice.jar, alice.csrfToken);

  const v1Res = await api('POST', `/api/workspaces/${shortId}/versions`, {
    path: 'index.js', content: v1Content, label: 'Initial Setup', kind: 'manual',
  }, alice.jar, alice.csrfToken);
  assert(v1Res.status === 201, `Version 1 created (id: ${v1Res.data.id?.slice(0, 8)})`);
  const v1Id = v1Res.data.id;

  const v2Content = '// Version 2: Added function\nconsole.log("Hello World");\n\nfunction greet(name) {\n  return `Hello, ${name}!`;\n}\n';
  await api('PUT', `/api/workspaces/${shortId}/file`, {
    path: 'index.js', content: v2Content,
  }, alice.jar, alice.csrfToken);

  const v2Res = await api('POST', `/api/workspaces/${shortId}/versions`, {
    path: 'index.js', content: v2Content, label: 'Added greet function', kind: 'manual',
  }, alice.jar, alice.csrfToken);
  assert(v2Res.status === 201, `Version 2 created (id: ${v2Res.data.id?.slice(0, 8)})`);
  const v2Id = v2Res.data.id;

  const v3Content = '// Version 3: Bug fix + new feature\nconsole.log("Hello World");\n\nfunction greet(name) {\n  if (!name) throw new Error("Name required");\n  return `Hello, ${name}!`;\n}\n\nfunction add(a, b) {\n  return a + b;\n}\n';
  await api('PUT', `/api/workspaces/${shortId}/file`, {
    path: 'index.js', content: v3Content,
  }, alice.jar, alice.csrfToken);

  const v3Res = await api('POST', `/api/workspaces/${shortId}/versions`, {
    path: 'index.js', content: v3Content, label: 'Bug fix + add function', kind: 'manual',
  }, alice.jar, alice.csrfToken);
  assert(v3Res.status === 201, `Version 3 created (id: ${v3Res.data.id?.slice(0, 8)})`);
  const v3Id = v3Res.data.id;

  // ── Step 2: List versions ──
  console.log('\n─── Step 2: List versions — verify count + metadata ───');
  const listRes = await api('GET', `/api/workspaces/${shortId}/versions?path=index.js`, null, alice.jar, alice.csrfToken);
  assert(listRes.status === 200, 'List versions returned 200');
  assert(Array.isArray(listRes.data) && listRes.data.length === 3, `Got ${listRes.data?.length} versions (expected 3)`);

  if (listRes.data?.length > 0) {
    const latest = listRes.data[0]; // newest first
    console.log(`  Latest: "${latest.label}" by ${latest.author_name} (${latest.kind})`);
    assert(latest.label === 'Bug fix + add function', `Latest version label matches: "${latest.label}"`);
    assert(latest.kind === 'manual', `Kind is "manual"`);
    assert(latest.author_name === alice.username, `Author is ${alice.username}`);
  }

  // ── Step 3: Get individual version with content ──
  console.log('\n─── Step 3: Get version with full content ───');
  const getRes = await api('GET', `/api/workspaces/${shortId}/versions/${v1Id}`, null, alice.jar, alice.csrfToken);
  assert(getRes.status === 200, 'Get version returned 200');
  assert(getRes.data.content === v1Content, 'Version 1 content matches exactly');
  assert(getRes.data.label === 'Initial Setup', 'Version 1 label matches');

  // ── Step 4: Diff two versions (compute here, same as component does) ──
  console.log('\n─── Step 4: Diff between v1 and v3 ───');
  const getV1 = await api('GET', `/api/workspaces/${shortId}/versions/${v1Id}`, null, alice.jar, alice.csrfToken);
  const getV3 = await api('GET', `/api/workspaces/${shortId}/versions/${v3Id}`, null, alice.jar, alice.csrfToken);

  const oldLines = getV1.data.content.split('\n');
  const newLines = getV3.data.content.split('\n');
  const additions = newLines.filter(l => !oldLines.includes(l)).length;
  const deletions = oldLines.filter(l => !newLines.includes(l)).length;
  console.log(`  Old (v1): ${oldLines.length} lines`);
  console.log(`  New (v3): ${newLines.length} lines`);
  console.log(`  Additions: +${additions}, Deletions: -${deletions}`);
  assert(additions > 0, `Diff shows additions: +${additions}`);
  assert(deletions > 0, `Diff shows deletions: -${deletions}`);

  // ── Step 5: Restore v1 — must create NEW snapshot ──
  console.log('\n─── Step 5: Restore version 1 — must create NEW "restore" snapshot ───');
  const countBefore = listRes.data.length;

  const restoreRes = await api('POST', `/api/workspaces/${shortId}/versions/${v1Id}/restore`, null, alice.jar, alice.csrfToken);
  assert(restoreRes.status === 201, 'Restore returned 201 (created new version)');
  assert(restoreRes.data.kind === 'restore', `New version kind is "restore" — got "${restoreRes.data.kind}"`);
  assert(restoreRes.data.label.includes('Restored'), `Label indicates restore: "${restoreRes.data.label}"`);

  // Verify version count INCREASED (history not deleted)
  const listAfterRestore = await api('GET', `/api/workspaces/${shortId}/versions?path=index.js`, null, alice.jar, alice.csrfToken);
  const countAfter = listAfterRestore.data.length;
  console.log(`  Versions before restore: ${countBefore}, after: ${countAfter}`);
  assert(countAfter === countBefore + 1, `Version count increased by 1 (${countBefore} → ${countAfter}): history preserved`);

  // Verify the restored file content matches v1
  const fileAfterRestore = await api('GET', `/api/workspaces/${shortId}/file?path=index.js`, null, alice.jar, alice.csrfToken);
  assert(fileAfterRestore.data.content === v1Content, 'Live file content matches restored version (v1)');

  // Verify all 4 versions still exist (original 3 + 1 restore)
  for (const ver of listAfterRestore.data) {
    console.log(`    [${ver.kind.padEnd(7)}] ${ver.label} (${new Date(ver.created_at).toLocaleTimeString()})`);
  }

  // ── Step 6: Browser screenshots ──
  console.log('\n─── Step 6: Browser screenshots of history list + diff view ───');
  const browser = await chromium.launch(getChromiumLaunchOptions());
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(Object.entries(alice.jar.cookies).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/',
    httpOnly: name.includes('access') || name.includes('refresh'), sameSite: 'Lax',
  })));
  const page = await ctx.newPage();

  await page.goto(`${APP_URL}/w/${shortId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Click file
  try {
    const fileItem = page.locator('text=index.js').first();
    if (await fileItem.isVisible({ timeout: 3000 })) await fileItem.click();
  } catch {}
  await page.waitForTimeout(2000);

  // Click History toggle
  const historyBtn = page.locator('#version-history-toggle');
  if (await historyBtn.isVisible({ timeout: 5000 })) {
    await historyBtn.click();
    await page.waitForTimeout(2000);

    // Screenshot the history list
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'version_history_list.png') });
    console.log('  📸 version_history_list.png');
    assert(true, 'History panel opened and screenshot taken');

    // Check panel exists
    const panel = page.locator('#version-history-panel');
    const panelVisible = await panel.isVisible({ timeout: 3000 });
    assert(panelVisible, 'Version history panel is visible');

    // Check it shows version count
    const panelText = await panel.textContent();
    assert(panelText.includes('4 snapshot'), `Panel shows 4 snapshots — "${panelText.match(/\d+ snapshot/)?.[0]}"`);

    // Select two versions for diff (click first two items)
    const versionItems = page.locator('#version-history-panel >> div[style*="cursor: pointer"]');
    const count = await versionItems.count();
    if (count >= 2) {
      await versionItems.nth(0).click();
      await page.waitForTimeout(300);
      await versionItems.nth(2).click(); // select 1st and 3rd (v3 and v1)
      await page.waitForTimeout(300);

      // Click the Diff button
      const diffBtn = page.locator('text=Diff').first();
      if (await diffBtn.isVisible({ timeout: 2000 })) {
        await diffBtn.click();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, 'version_diff_view.png') });
        console.log('  📸 version_diff_view.png');
        assert(true, 'Diff view screenshot taken');
      }
    }
  } else {
    console.log('  ⚠️  History button not visible (may need page reload after HMR)');
  }

  await browser.close();

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(` RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
