const PROD_URL = 'https://syncspace-bay.vercel.app';

async function testAccountLinkingFlow() {
  console.log('=== TEST: Production Account-Linking Security Flow ===\n');

  // Step 1: Log in as unverified password user
  console.log('1. Logging in as unverified user (unverified_084033)...');
  const loginRes = await fetch(`${PROD_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'unverified_1791374084033@syncspace-test.internal',
      password: 'StrongPassword123!',
    }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed with status ${loginRes.status}`);
  }

  const loginData = await loginRes.json();
  const sessionUserId = loginData.user.id;
  console.log(`   Logged in successfully! User ID: ${sessionUserId}`);
  console.log(`   Current email_verified: ${loginData.user.email_verified}`);

  const rawSetCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
  const cookieHeader = rawSetCookies.map(c => c.split(';')[0]).join('; ');

  // Step 2: While authenticated, initiate Google OAuth
  console.log('\n2. Calling GET /api/auth/google while authenticated in session...');
  const googleRes = await fetch(`${PROD_URL}/api/auth/google?return_to=/w/3311cdf85d4b471ea6b093f4bfbf767a`, {
    headers: { 'Cookie': cookieHeader },
    redirect: 'manual',
  });

  console.log(`   HTTP Status: ${googleRes.status} (Expected 307 Temporary Redirect)`);
  const googleSetCookies = googleRes.headers.getSetCookie ? googleRes.headers.getSetCookie() : [];
  
  let linkUserCookie = null;
  let returnCookie = null;
  let stateCookie = null;

  for (const c of googleSetCookies) {
    if (c.startsWith('syncspace_oauth_link_user=')) linkUserCookie = c.split(';')[0].split('=')[1];
    if (c.startsWith('syncspace_oauth_return=')) returnCookie = c.split(';')[0].split('=')[1];
    if (c.startsWith('syncspace_oauth_state=')) stateCookie = c.split(';')[0].split('=')[1];
  }

  console.log(`   syncspace_oauth_link_user cookie: ${linkUserCookie}`);
  console.log(`   syncspace_oauth_return cookie: ${returnCookie}`);
  console.log(`   syncspace_oauth_state cookie: ${stateCookie ? stateCookie.slice(0, 16) + '...' : 'none'}`);

  if (linkUserCookie === sessionUserId) {
    console.log(`   🎉 SUCCESS: syncspace_oauth_link_user matches the exact session User ID: ${sessionUserId}!`);
  } else {
    console.error(`   FAILURE: Expected linkUserCookie to be ${sessionUserId}, got ${linkUserCookie}`);
    process.exit(1);
  }

  // Step 3: Verify unauthenticated caller does NOT get link_user cookie
  console.log('\n3. Calling GET /api/auth/google without authentication (Cold login)...');
  const coldGoogleRes = await fetch(`${PROD_URL}/api/auth/google`, {
    redirect: 'manual',
  });

  const coldCookies = coldGoogleRes.headers.getSetCookie ? coldGoogleRes.headers.getSetCookie() : [];
  let coldLinkUser = null;
  for (const c of coldCookies) {
    if (c.startsWith('syncspace_oauth_link_user=')) coldLinkUser = c;
  }
  console.log(`   Cold login link_user cookie header: ${coldLinkUser}`);
  const isColdCleared = coldLinkUser && (coldLinkUser.includes('Max-Age=0') || coldLinkUser.includes('syncspace_oauth_link_user=;'));
  if (isColdCleared || !coldLinkUser) {
    console.log(`   🎉 SUCCESS: Cold login leaves syncspace_oauth_link_user unset/cleared!`);
  } else {
    console.error(`   FAILURE: Expected linkUser to be cleared for cold login, got: ${coldLinkUser}`);
    process.exit(1);
  }

  console.log('\n=== All Live Account-Linking Flow Verification Passed! ===\n');
}

testAccountLinkingFlow().catch(err => {
  console.error('Error running test:', err);
  process.exit(1);
});
