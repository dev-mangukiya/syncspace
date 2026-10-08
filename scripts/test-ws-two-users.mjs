const WebSocket = globalThis.WebSocket;
const FRONTEND_ORIGIN = 'https://syncspace-bay.vercel.app';
const BACKEND_WS_HOST = 'syncspace-6sr8.onrender.com';

async function testTwoUsers() {
  const runId = Math.random().toString(36).substring(2, 8);
  console.log(`=== Two Parallel Users Test (${runId}) ===`);

  // 1. User A signup
  const credsA = { username: `uA_${runId}`, email: `uA_${runId}@example.com`, password: `Password_${runId}!Aa` };
  const resA = await fetch(`${FRONTEND_ORIGIN}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credsA),
  });
  const dataA = await resA.json();
  const cookiesA = resA.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  console.log(`User A created: ${credsA.username} (${resA.status})`);

  // 2. User B signup
  const credsB = { username: `uB_${runId}`, email: `uB_${runId}@example.com`, password: `Password_${runId}!Bb` };
  const resB = await fetch(`${FRONTEND_ORIGIN}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credsB),
  });
  const dataB = await resB.json();
  const cookiesB = resB.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  console.log(`User B created: ${credsB.username} (${resB.status})`);

  // 3. User A creates workspace
  const wsRes = await fetch(`${FRONTEND_ORIGIN}/api/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookiesA,
      'X-CSRF-Token': dataA.csrf_token,
    },
    body: JSON.stringify({ name: `Collab ${runId}`, template: 'blank', language: 'python' }),
  });
  const wsData = await wsRes.json();
  console.log(`Workspace created: ${wsData.slug} (${wsRes.status})`);

  // 4. User A invites User B
  const inviteRes = await fetch(`${FRONTEND_ORIGIN}/api/workspaces/${wsData.slug}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookiesA,
      'X-CSRF-Token': dataA.csrf_token,
    },
    body: JSON.stringify({ identifier: credsB.username, role: 'editor' }),
  });
  console.log(`User B invited: status=${inviteRes.status}`);

  // 5. Mint tickets for both
  const [tResA, tResB] = await Promise.all([
    fetch(`${FRONTEND_ORIGIN}/api/ws-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookiesA, 'X-CSRF-Token': dataA.csrf_token },
    }),
    fetch(`${FRONTEND_ORIGIN}/api/ws-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookiesB, 'X-CSRF-Token': dataB.csrf_token },
    }),
  ]);
  const [tDataA, tDataB] = await Promise.all([tResA.json(), tResB.json()]);
  console.log(`Ticket A: ${tDataA.ticket?.slice(0, 8)}... Ticket B: ${tDataB.ticket?.slice(0, 8)}...`);

  // 6. Connect both WebSockets simultaneously
  const wsUrlA = `wss://${BACKEND_WS_HOST}/ws/${wsData.slug}/main.py?ticket=${tDataA.ticket}`;
  const wsUrlB = `wss://${BACKEND_WS_HOST}/ws/${wsData.slug}/main.py?ticket=${tDataB.ticket}`;

  const wsA = new WebSocket(wsUrlA);
  const wsB = new WebSocket(wsUrlB);

  let aOpen = false;
  let bOpen = false;

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout. aOpen=${aOpen}, bOpen=${bOpen}`)), 8000);
    wsA.onopen = () => {
      console.log('WS A Connected!');
      aOpen = true;
      if (aOpen && bOpen) { clearTimeout(t); resolve(); }
    };
    wsB.onopen = () => {
      console.log('WS B Connected!');
      bOpen = true;
      if (aOpen && bOpen) { clearTimeout(t); resolve(); }
    };
    wsA.onerror = (e) => console.error('WS A Error:', e);
    wsB.onerror = (e) => console.error('WS B Error:', e);
    wsA.onclose = (e) => console.log('WS A Closed:', e.code, e.reason);
    wsB.onclose = (e) => console.log('WS B Closed:', e.code, e.reason);
  });

  console.log('SUCCESS: Both users connected simultaneously to the same workspace over WebSocket!');
  wsA.close();
  wsB.close();
}

testTwoUsers().catch(console.error);
