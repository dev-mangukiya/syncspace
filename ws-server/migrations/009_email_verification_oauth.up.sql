-- Migration 009: Email verification, OAuth provider, and terms acceptance
-- Supports: Turnstile CAPTCHA (no DB change), email-gated Run button,
-- Google OAuth login, and terms-of-use acceptance tracking.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token VARCHAR(128);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(32);  -- 'google', null = password
ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider_id VARCHAR(256); -- Google sub ID
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_email_verify_token ON users(email_verify_token) WHERE email_verify_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_provider_id) WHERE oauth_provider IS NOT NULL;
