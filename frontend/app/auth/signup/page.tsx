'use client';

import { useState, FormEvent } from 'react';
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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await authAPI.signup(username, email, password);
      setAuth(response.data.user);
      router.push('/dashboard');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Signup failed. Please try again.');
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
      <div style={{ width: '100%', maxWidth: '380px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-10)' }}>
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

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 'var(--space-5)' }}>
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

            <div style={{ marginBottom: 'var(--space-5)' }}>
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

            <div style={{ marginBottom: 'var(--space-6)' }}>
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

            <button
              type="submit"
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
