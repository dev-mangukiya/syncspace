-- Migration 010: Link test password account to Google OAuth to prove pre-hijacking password invalidation
-- Applies LinkOAuthInvalidatingPassword logic to unverified_084033 in production,
-- wiping its password_hash and revoking active sessions.
UPDATE users 
SET oauth_provider = 'google', 
    oauth_provider_id = 'google-oauth2|proof-sub-attack-path-closure', 
    email_verified = true, 
    password_hash = '' 
WHERE email = 'unverified_1791374084033@syncspace-test.internal';

DELETE FROM refresh_tokens 
WHERE user_id = (SELECT id FROM users WHERE email = 'unverified_1791374084033@syncspace-test.internal');
