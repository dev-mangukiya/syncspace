const FRONTEND_ORIGIN = 'https://syncspace-bay.vercel.app';

async function testRun() {
  // 1. Sign up a fresh user
  const runId = Math.random().toString(36).substring(2, 8);
  const creds = {
    username: `runuser_${runId}`,
    email: `runuser_${runId}@example.com`,
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

  // 2. Create workspace
  const wsRes = await fetch(`${FRONTEND_ORIGIN}/api/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      name: `Exec Workspace ${runId}`,
      template: 'blank',
      language: 'python',
    }),
  });
  const wsData = await wsRes.json();
  console.log('Workspace created:', wsData.slug);

  // 3. Create a python file
  const fileRes = await fetch(`${FRONTEND_ORIGIN}/api/workspaces/${wsData.slug}/file`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      path: 'main.py',
      content: 'print(f"Executing inside Azure VM via Cloudflare Tunnel! 7 * 6 = {7*6}")',
    }),
  });
  console.log('File created status:', fileRes.status);

  // 4. Trigger Run
  console.log('Triggering run...');
  const runRes = await fetch(`${FRONTEND_ORIGIN}/api/workspaces/${wsData.slug}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      file_path: 'main.py',
      code: 'print(f"Executing inside Azure VM via Cloudflare Tunnel! 7 * 6 = {7*6}")',
      language: 'python',
    }),
  });
  console.log('Run response status:', runRes.status);
  const runData = await runRes.text();
  console.log('Run response data:', runData);
}

testRun().catch(console.error);
