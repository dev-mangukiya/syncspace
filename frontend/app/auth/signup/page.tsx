'use client';

import { useState, useEffect, useRef, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { authAPI } from '@/app/lib/api';
import { useAuthStore } from '@/app/lib/store';
import { Logo } from '@/app/components/ui/logo';

export default function SignupPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetId = useRef<string | null>(null);

  // Load Cloudflare Turnstile script and render widget
  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

    // Extend window interface for Turnstile
    const win = window as unknown as {
      turnstile?: {
        render: (container: HTMLElement, options: Record<string, unknown>) => string;
        reset: (widgetId: string) => void;
      };
      onloadTurnstileCallback?: () => void;
    };

    function renderWidget() {
      if (win.turnstile && turnstileContainerRef.current && !turnstileWidgetId.current) {
        try {
          const id = win.turnstile.render(turnstileContainerRef.current, {
            sitekey: siteKey,
            theme: 'dark',
            callback: (token: string) => {
              setTurnstileToken(token);
              setError('');
            },
            'error-callback': () => {
              setError('Security check failed. Please refresh or try again.');
            },
            'expired-callback': () => {
              setTurnstileToken('');
            },
          });
          turnstileWidgetId.current = id;
        } catch {
          // Widget already rendered or container unavailable
        }
      }
    }

    if (win.turnstile) {
      renderWidget();
    } else {
      win.onloadTurnstileCallback = renderWidget;
      const existingScript = document.getElementById('cf-turnstile-script');
      if (!existingScript) {
        const script = document.createElement('script');
        script.id = 'cf-turnstile-script';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    }

    return () => {
      // Clean up widget on unmount
      if (win.turnstile && turnstileWidgetId.current) {
        try {
          win.turnstile.reset(turnstileWidgetId.current);
        } catch {
          // ignore
        }
        turnstileWidgetId.current = null;
      }
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!termsAccepted) {
      setError('You must agree to the Terms of Service and Privacy Policy.');
      return;
    }

    if (!turnstileToken) {
      setError('Please complete the Cloudflare security verification.');
      return;
    }

    setLoading(true);

    try {
      const response = await authAPI.signup(username, email, password, turnstileToken, termsAccepted);
      setAuth(response.data.user);
      router.push('/dashboard');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { error?: string; message?: string } } };
        setError(axiosErr.response?.data?.message || axiosErr.response?.data?.error || 'Signup failed. Please try again.');
      } else {
        setError('Signup failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <div style={{ width: '100%', maxWidth: '400px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-8)' }}>
          <Link href="/" style={{ textDecoration: 'none', display: 'inline-block' }}>
            <Logo size="lg" />
          </Link>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>
            Create your account to start collaborating
          </p>
        </div>

        {/* Form card */}
        <div className="card" style={{ padding: 'var(--space-8)' }}>
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 'var(--space-5)' }}>
              <AlertTriangle size={16} />
              {error}
            </div>
          )}

          {/* Google OAuth Button */}
          <a
            href="/api/auth/google"
            id="google-signup-btn"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--space-3)',
              width: '100%',
              padding: 'var(--space-3) var(--space-4)',
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text)',
              fontSize: 'var(--text-sm)',
              fontWeight: 500,
              textDecoration: 'none',
              cursor: 'pointer',
              transition: 'background-color 0.15s ease, border-color 0.15s ease',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            Continue with Google
          </a>

          {/* Divider */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              margin: 'var(--space-5) 0',
              color: 'var(--color-text-faint)',
              fontSize: 'var(--text-xs)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--color-border-subtle)' }} />
            <span style={{ padding: '0 var(--space-3)' }}>or with email</span>
            <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--color-border-subtle)' }} />
          </div>

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <label className="input-label" htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                className="input"
                placeholder="your-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                autoFocus
                pattern="[a-zA-Z0-9_-]{3,32}"
                title="3-32 characters: letters, numbers, hyphens, underscores"
              />
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)', marginTop: 'var(--space-1)' }}>
                3-32 characters. Letters, numbers, hyphens, underscores.
              </p>
            </div>

            <div style={{ marginBottom: 'var(--space-4)' }}>
              <label className="input-label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div style={{ marginBottom: 'var(--space-5)' }}>
              <label className="input-label" htmlFor="password">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className="input"
                  style={{ paddingRight: 'var(--space-10)' }}
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  minLength={8}
                />
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  style={{
                    position: 'absolute',
                    right: '4px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: '28px',
                    height: '28px',
                  }}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Cloudflare Turnstile CAPTCHA container */}
            <div style={{ marginBottom: 'var(--space-5)', display: 'flex', justifyContent: 'center' }}>
              <div ref={turnstileContainerRef} id="turnstile-container" />
            </div>

            {/* Terms and Privacy Agreement Checkbox */}
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--space-2)',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-text-muted)',
                  cursor: 'pointer',
                  lineHeight: 1.5,
                }}
              >
                <input
                  id="terms-checkbox"
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  required
                  style={{
                    marginTop: '2px',
                    accentColor: 'var(--color-accent-solid)',
                    cursor: 'pointer',
                  }}
                />
                <span>
                  I agree to the{' '}
                  <Link href="/terms" target="_blank" style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}>
                    Terms of Service
                  </Link>{' '}
                  and{' '}
                  <Link href="/privacy" target="_blank" style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}>
                    Privacy Policy
                  </Link>
                  .
                </span>
              </label>
            </div>

            <button
              type="submit"
              id="signup-submit-btn"
              className="btn btn-primary"
              disabled={loading}
              style={{ width: '100%', padding: 'var(--space-3) var(--space-4)' }}
            >
              {loading ? (
                <>
                  <span className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px' }} />
                  Creating account...
                </>
              ) : (
                'Create account'
              )}
            </button>
          </form>
        </div>

        <p style={{
          textAlign: 'center',
          marginTop: 'var(--space-6)',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--text-sm)',
        }}>
          Already have an account?{' '}
          <Link href="/auth/login" style={{ fontWeight: 500 }}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
