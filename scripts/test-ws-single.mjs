const WebSocket = globalThis.WebSocket;
const FRONTEND_ORIGIN = 'https://syncspace-bay.vercel.app';
const BACKEND_WS_HOST = 'syncspace-6sr8.onrender.com';

async function testWSSingle() {
  const runId = Math.random().toString(36).substring(2, 8);
  const creds = {
    username: `ws_diag_${runId}`,
    email: `ws_diag_${runId}@example.com`,
    password: `Password_${runId}!Aa`,
  };

  const signupRes = await fetch(`${FRONTEND_ORIGIN}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds),
  });
  const signupData = await signupRes.json();
  const cookies = signupRes.headers.getSetCookie();
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
  const csrfToken = signupData.csrf_token;

  console.log('User created:', creds.username);

  const wsRes = await fetch(`${FRONTEND_ORIGIN}/api/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      name: `WS Diag ${runId}`,
      template: 'blank',
      language: 'python',
    }),
  });
  const wsData = await wsRes.json();
  console.log('Workspace slug:', wsData.slug);

  const ticketRes = await fetch(`${FRONTEND_ORIGIN}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
  });
  const ticketData = await ticketRes.json();
  console.log('Ticket received:', ticketData.ticket);

  const wsUrl = `wss://${BACKEND_WS_HOST}/ws/${wsData.slug}/main.py?ticket=${ticketData.ticket}`;
  console.log('Connecting to:', wsUrl);

  const ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    console.log('WebSocket OPENED successfully!');
    ws.close();
  };
  ws.onerror = (e) => {
    console.error('WebSocket ERROR event:', e);
  };
  ws.onclose = (e) => {
    console.log(`WebSocket CLOSED: code=${e.code}, reason="${e.reason}", wasClean=${e.wasClean}`);
  };
}

testWSSingle().catch(console.error);
