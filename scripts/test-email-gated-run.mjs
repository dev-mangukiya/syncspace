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

  // 4. Retrieve verification link/token and verify the account
  console.log('\n4. Verifying account via verification token...');
  let verifyLink = signupData.verification_link;

  if (!verifyLink) {
    // If not in signup response, request via resend-verification endpoint
    console.log('   Requesting fresh verification link via POST /api/auth/resend-verification...');
    const resendRes = await fetch(`${PROD_URL}/api/auth/resend-verification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieHeader,
        'X-CSRF-Token': csrfToken,
      },
    });
    const resendData = await resendRes.json();
    console.log('   Resend response:', resendData);
    verifyLink = resendData.verification_link;
  }

  if (!verifyLink) {
    console.error('   FAILURE: Could not retrieve verification link.');
    process.exit(1);
  }

  console.log(`   Verification Link: ${verifyLink}`);
  const verifyUrlObj = new URL(verifyLink);
  const verifyToken = verifyUrlObj.searchParams.get('token');
  console.log(`   Extracted Token: ${verifyToken}`);

  // Call the verification endpoint
  const verifyRes = await fetch(`${PROD_URL}/api/auth/verify-email?token=${verifyToken}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  const verifyData = await verifyRes.json();
  console.log(`   Verify HTTP Status: ${verifyRes.status} ${verifyRes.statusText}`);
  console.log('   Verify Response Body:', JSON.stringify(verifyData, null, 2));

  if (verifyRes.status !== 200 || !verifyData.email_verified) {
    console.error('   FAILURE: Email verification did not succeed.');
    process.exit(1);
  }
  console.log('   SUCCESS: Email is now verified in database!');

  // 5. Check /api/auth/me to confirm session sees email_verified: true
  console.log('\n5. Checking GET /api/auth/me to confirm session state...');
  const meRes = await fetch(`${PROD_URL}/api/auth/me`, {
    headers: { 'Cookie': cookieHeader },
  });
  const meData = await meRes.json();
  console.log(`   /api/auth/me HTTP Status: ${meRes.status}`);
  console.log(`   user.email_verified: ${meData.email_verified}`);
  if (!meData.email_verified) {
    console.error('   FAILURE: /api/auth/me does not report email_verified: true');
    process.exit(1);
  }
  console.log('   SUCCESS: User session confirms email_verified is true!');

  // 6. Re-attempt POST .../run with the NOW VERIFIED account!
  console.log(`\n6. Calling POST ${PROD_URL}/api/workspaces/${wsSlug}/run with NOW VERIFIED account...`);
  const rerunRes = await fetch(`${PROD_URL}/api/workspaces/${wsSlug}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      file_path: 'main.py',
      code: 'print("SyncSpace Verification End-to-End Success! Run unblocked.")',
      language: 'python',
    }),
  });

  const rerunData = await rerunRes.json();
  console.log(`   Re-run HTTP Status: ${rerunRes.status} ${rerunRes.statusText}`);
  console.log('   Re-run Response Body:', JSON.stringify(rerunData, null, 2));

  if (rerunRes.status === 200 && (rerunData.stdout?.includes('SyncSpace Verification End-to-End Success') || rerunData.exit_code === 0)) {
    console.log('\n🎉 SUCCESS: Code executed successfully and exit code is 0! Run is completely UNBLOCKED post-verification!');
  } else {
    console.error('\nFAILURE: Execution failed after verification. Details:', rerunData);
    process.exit(1);
  }

  console.log('\n=== Full End-to-End Email Verification & Run Unblock Passed! ===');
}

testEmailGatedRun().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
