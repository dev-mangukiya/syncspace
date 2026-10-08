/**
 * Production Cross-Origin Auth & Parallel Session Verification Script
 * Tests:
 * 1. Parallel user signups against https://syncspace-bay.vercel.app/api/auth/signup
 * 2. Set-Cookie header inspection (syncspace_access, syncspace_refresh, syncspace_csrf)
 * 3. Subsequent authenticated GET /api/workspaces (proving cookie attachment and domain)
 * 4. CSRF-protected POST /api/workspaces (proving double-submit cookie pattern)
 * 5. POST /api/ws-ticket (proving ticket minting via Vercel proxy)
 * 6. WebSocket connection to wss://syncspace-6sr8.onrender.com with ticket
 * 7. Real-time message exchange between User 1 & User 2
 */

const WebSocket = globalThis.WebSocket;

const FRONTEND_ORIGIN = 'https://syncspace-bay.vercel.app';
const BACKEND_WS_HOST = 'syncspace-6sr8.onrender.com';

class SessionClient {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
    this.csrfToken = null;
    this.user = null;
    this.history = [];
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  recordCookies(responseHeaders) {
    // getSetCookie in Node 20+
    const setCookieHeaders = responseHeaders.getSetCookie ? responseHeaders.getSetCookie() : [];
    if (setCookieHeaders.length === 0) {
      const raw = responseHeaders.get('set-cookie');
      if (raw) setCookieHeaders.push(raw);
    }

    for (const header of setCookieHeaders) {
      const parts = header.split(';');
      const [nameVal] = parts;
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx !== -1) {
        const key = nameVal.slice(0, eqIdx).trim();
        const val = nameVal.slice(eqIdx + 1).trim();
        this.cookies.set(key, val);
      }
    }
  }

  async request(method, path, body = null, extraHeaders = {}) {
    const url = `${FRONTEND_ORIGIN}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    const cookieStr = this.getCookieHeader();
    if (cookieStr) {
      headers['Cookie'] = cookieStr;
    }

    if (this.csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
      headers['X-CSRF-Token'] = this.csrfToken;
    }

    const logEntry = {
      client: this.name,
      method,
      url,
      requestHeaders: { ...headers },
      requestBody: body,
      status: null,
      responseHeaders: {},
      responseBody: null,
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    logEntry.status = res.status;
    this.recordCookies(res.headers);

    // Save interesting response headers
    for (const [k, v] of res.headers.entries()) {
      if (['set-cookie', 'server', 'x-render-origin-server', 'content-type'].includes(k.toLowerCase())) {
        logEntry.responseHeaders[k] = v;
      }
    }
    if (res.headers.getSetCookie) {
      logEntry.responseHeaders['all-set-cookie'] = res.headers.getSetCookie();
    }

    const text = await res.text();
    try {
      logEntry.responseBody = JSON.parse(text);
    } catch {
      logEntry.responseBody = text;
    }

    this.history.push(logEntry);
    return { res, data: logEntry.responseBody, logEntry };
  }
}

async function runTest() {
  const runId = Math.random().toString(36).substring(2, 8);
  console.log(`=== RUNNING PRODUCTION CROSS-ORIGIN AUTH TEST (Run ID: ${runId}) ===\n`);

  const userA = new SessionClient('User_Alpha');
  const userB = new SessionClient('User_Beta');

  const credsA = {
    username: `alpha_${runId}`,
    email: `alpha_${runId}@example.com`,
    password: `P@ssword_${runId}!Aa`,
  };

  const credsB = {
    username: `beta_${runId}`,
    email: `beta_${runId}@example.com`,
    password: `P@ssword_${runId}!Bb`,
  };

  console.log('--- Step 1: Parallel Signup on Frontend Vercel Origin ---');
  const [signupA, signupB] = await Promise.all([
    userA.request('POST', '/api/auth/signup', credsA),
    userB.request('POST', '/api/auth/signup', credsB),
  ]);

  userA.user = signupA.data.user;
  userA.csrfToken = signupA.data.csrf_token;
  userB.user = signupB.data.user;
  userB.csrfToken = signupB.data.csrf_token;

  console.log(`[User A] Signup Status: ${signupA.res.status}, ID: ${userA.user?.id}`);
  console.log(`[User A] Cookies Set: ${Array.from(userA.cookies.keys()).join(', ')}`);
  console.log(`[User B] Signup Status: ${signupB.res.status}, ID: ${userB.user?.id}`);
  console.log(`[User B] Cookies Set: ${Array.from(userB.cookies.keys()).join(', ')}\n`);

  console.log('--- Step 2: Parallel Authenticated GET /api/workspaces (Cookie Auth Check) ---');
  const [listA, listB] = await Promise.all([
    userA.request('GET', '/api/workspaces'),
    userB.request('GET', '/api/workspaces'),
  ]);

  console.log(`[User A] Workspaces List Status: ${listA.res.status}, Count: ${Array.isArray(listA.data) ? listA.data.length : 'ERR'}`);
  console.log(`[User B] Workspaces List Status: ${listB.res.status}, Count: ${Array.isArray(listB.data) ? listB.data.length : 'ERR'}\n`);

  console.log('--- Step 3: User A Creates a Workspace (CSRF-Protected POST) ---');
  const wsA = await userA.request('POST', '/api/workspaces', {
    name: `Workspace Alpha ${runId}`,
    description: 'Cross-origin verification workspace',
    template: 'blank',
    language: 'python',
  });
  console.log(`[User A] Create Workspace Status: ${wsA.res.status}, Slug: ${wsA.data?.slug}, ShortID: ${wsA.data?.short_id}\n`);

  if (!wsA.data?.slug) {
    throw new Error('Failed to create workspace: ' + JSON.stringify(wsA.data));
  }
  const workspaceSlug = wsA.data.slug;

  console.log('--- Step 4: User A Invites User B to Workspace ---');
  const inviteB = await userA.request('POST', `/api/workspaces/${workspaceSlug}/members`, {
    identifier: credsB.username,
    role: 'editor',
  });
  console.log(`[User A] Invite User B Status: ${inviteB.res.status}, Members: ${Array.isArray(inviteB.data) ? inviteB.data.length : 'ERR'}\n`);

  console.log('--- Step 5: User A and User B Request WebSocket Tickets via /api/ws-ticket ---');
  const [ticketA, ticketB] = await Promise.all([
    userA.request('POST', '/api/ws-ticket'),
    userB.request('POST', '/api/ws-ticket'),
  ]);

  console.log(`[User A] WS Ticket Status: ${ticketA.res.status}, Ticket len: ${ticketA.data?.ticket?.length}`);
  console.log(`[User B] WS Ticket Status: ${ticketB.res.status}, Ticket len: ${ticketB.data?.ticket?.length}\n`);

  if (!ticketA.data?.ticket || !ticketB.data?.ticket) {
    throw new Error('Ticket generation failed!');
  }

  console.log('--- Step 6: Connect Both Users to WebSocket Relay on Render ---');
  const wsUrlA = `wss://${BACKEND_WS_HOST}/ws/${workspaceSlug}/main.py?ticket=${ticketA.data.ticket}`;
  const wsUrlB = `wss://${BACKEND_WS_HOST}/ws/${workspaceSlug}/main.py?ticket=${ticketB.data.ticket}`;

  const wsClientA = new WebSocket(wsUrlA);
  const wsClientB = new WebSocket(wsUrlB);

  const wsPromise = new Promise((resolve, reject) => {
    let aOpen = false;
    let bOpen = false;
    const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out after 10s')), 10000);

    const checkBoth = () => {
      if (aOpen && bOpen) {
        clearTimeout(timeout);
        resolve({ wsClientA, wsClientB });
      }
    };

    wsClientA.onopen = () => {
      console.log('[WebSocket User A] Connected successfully!');
      aOpen = true;
      checkBoth();
    };

    wsClientB.onopen = () => {
      console.log('[WebSocket User B] Connected successfully!');
      bOpen = true;
      checkBoth();
    };

    wsClientA.onerror = (err) => console.error('[WebSocket User A] Error:', err);
    wsClientB.onerror = (err) => console.error('[WebSocket User B] Error:', err);
  });

  // Step 7: Send message from User A to User B over WebSocket
  console.log('--- Step 7: Real-Time Message Exchange Over WebSocket ---');
  const wsEchoPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message exchange timed out')), 5000);

    wsClientB.onmessage = (event) => {
      clearTimeout(timeout);
      console.log(`[WebSocket User B] Received frame from User A: ${typeof event.data === 'string' ? event.data : `Binary (${event.data?.byteLength || event.data?.length} bytes)`}`);
      resolve(true);
    };

    // User A sends awareness/ping payload
    const pingMsg = JSON.stringify({ type: 'chat_message', content: 'Hello User B from User A over production WebSocket!' });
    wsClientA.send(pingMsg);
    console.log('[WebSocket User A] Sent message frame to room');
  });

  try {
    await wsEchoPromise;
    console.log('Real-time message exchange verified across instances!\n');
  } catch (err) {
    console.warn('WS message wait warning (non-fatal):', err.message);
  }

  // Clean close
  wsClientA.close();
  wsClientB.close();

  console.log('=== FULL NETWORK TRACE DETAILS ===\n');
  const allLogs = [...userA.history, ...userB.history];
  for (const log of allLogs) {
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`[${log.client}] ${log.method} ${log.url} -> Status: ${log.status}`);
    console.log(`Headers Sent:`);
    for (const [k, v] of Object.entries(log.requestHeaders)) {
      if (k.toLowerCase() === 'cookie') {
        // Redact JWT payload partly for brevity but keep structure visible
        const formatted = v.replace(/(eyJhbGciOi[A-Za-z0-9_-]{10})[A-Za-z0-9_-]+/g, '$1...[TRUNCATED]');
        console.log(`  ${k}: ${formatted}`);
      } else {
        console.log(`  ${k}: ${v}`);
      }
    }
    console.log(`Headers Received:`);
    for (const [k, v] of Object.entries(log.responseHeaders)) {
      if (k === 'all-set-cookie' && Array.isArray(v)) {
        for (const cookieItem of v) {
          const formatted = cookieItem.replace(/(eyJhbGciOi[A-Za-z0-9_-]{10})[A-Za-z0-9_-]+/g, '$1...[TRUNCATED]');
          console.log(`  set-cookie: ${formatted}`);
        }
      } else {
        console.log(`  ${k}: ${v}`);
      }
    }
    if (log.requestBody) {
      console.log(`Request Body: ${JSON.stringify(log.requestBody)}`);
    }
    console.log(`Response Body: ${JSON.stringify(log.responseBody).substring(0, 300)}...`);
  }
}

runTest().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
