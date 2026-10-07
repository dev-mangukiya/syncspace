const PROD_URL = 'https://syncspace-bay.vercel.app';

async function testEmailGatedRun() {
  console.log('=== TEST: Email Verification Gating Run Endpoint ===\n');

  const timestamp = Date.now();
  const username = `unverified_${timestamp.toString().slice(-6)}`;
  const email = `unverified_${timestamp}@syncspace-test.internal`;
  const password = 'StrongPassword123!';

  console.log(`1. Creating fresh unverified account: ${username} (${email})...`);

  // Sign up with Turnstile testing token and accepted terms
  const signupRes = await fetch(`${PROD_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      email,
      password,
      terms_accepted: true,
      turnstile_token: '1x00000000000000000000AA', // Cloudflare testing pass token
    }),
  });

  console.log(`   Signup status: ${signupRes.status} ${signupRes.statusText}`);
  const signupData = await signupRes.json();
  if (signupRes.status !== 201) {
    console.error('   Signup failed:', signupData);
    process.exit(1);
  }

  // Extract session cookies and csrf token
  // In fetch, getSetCookie() returns all Set-Cookie headers
  const setCookies = signupRes.headers.getSetCookie ? signupRes.headers.getSetCookie() : [];
  const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
  const csrfToken = signupData.csrf_token;
  const user = signupData.user;

  console.log(`   User created: ID=${user.id}, email_verified=${user.email_verified}`);
  console.log(`   Cookies received: ${cookieHeader.slice(0, 80)}...`);
  console.log(`   CSRF Token: ${csrfToken}`);

  // 2. Confirm unverified user can browse / create workspaces
  console.log('\n2. Testing unverified user can browse and create workspace...');
  const createWsRes = await fetch(`${PROD_URL}/api/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      name: `Workspace for ${username}`,
      language: 'python',
      template: 'python',
    }),
  });

  console.log(`   Workspace creation status: ${createWsRes.status} ${createWsRes.statusText}`);
  const wsData = await createWsRes.json();
  if (createWsRes.status !== 201) {
    console.error('   Failed to create workspace:', wsData);
    process.exit(1);
  }
  const wsSlug = wsData.slug || wsData.short_id;
  console.log(`   Workspace created: slug=${wsSlug}`);

  // 3. Attempt POST .../run with the UNVERIFIED account
  console.log(`\n3. Calling POST ${PROD_URL}/api/workspaces/${wsSlug}/run with UNVERIFIED account...`);
  const runRes = await fetch(`${PROD_URL}/api/workspaces/${wsSlug}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      file_path: 'main.py',
      code: 'print("Hello from unverified")',
      language: 'python',
    }),
  });

  const runData = await runRes.json();
  console.log(`   Run HTTP Status: ${runRes.status} ${runRes.statusText}`);
  console.log(`   Run Response Body:`, JSON.stringify(runData, null, 2));

  if (runRes.status === 403 && runData.error === 'email_verification_required') {
    console.log('\n   SUCCESS: Execution was correctly rejected with 403 email_verification_required!');
  } else {
    console.error('\n   FAILURE: Expected 403 email_verification_required, got:', runRes.status, runData);
    process.exit(1);
  }

  console.log('\n=== Email Verification Gating Test Passed Successfully ===');
}

testEmailGatedRun().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
