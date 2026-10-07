import Link from 'next/link';
import { Logo } from '@/app/components/ui/logo';
import { ArrowLeft, Lock, Database, Eye, ShieldCheck, AlertTriangle } from 'lucide-react';

export const metadata = {
  title: 'Privacy Policy — SyncSpace',
  description: 'Privacy policy and data protection practices for the SyncSpace collaborative IDE.',
};

export default function PrivacyPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-bg-app)',
        color: 'var(--color-text)',
        padding: 'var(--space-8) var(--space-4)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <div style={{ width: '100%', maxWidth: '800px' }}>
        {/* Navigation / Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-8)' }}>
          <Link href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <Logo size="md" />
          </Link>
          <Link
            href="/auth/signup"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              color: 'var(--color-accent)',
              fontSize: 'var(--text-sm)',
              textDecoration: 'none',
            }}
          >
            <ArrowLeft size={16} /> Back to Sign Up
          </Link>
        </div>

        {/* Title */}
        <div style={{ marginBottom: 'var(--space-8)' }}>
          <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>
            Privacy Policy
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>
            Effective Date: October 2026 • SyncSpace Public Beta
          </p>
        </div>

        {/* Beta Notice Banner */}
        <div
          className="alert"
          style={{
            backgroundColor: 'rgba(123, 163, 204, 0.08)',
            borderColor: 'var(--color-accent)',
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 'var(--space-8)',
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'flex-start',
          }}
        >
          <ShieldCheck size={20} color="var(--color-accent)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong style={{ color: 'var(--color-accent)', display: 'block', marginBottom: 'var(--space-1)' }}>
              Our Commitment to Transparency
            </strong>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
              SyncSpace values user privacy. We do not sell your personal data, code, or workspace content to third parties, and we do not use your proprietary code to train machine learning models.
            </span>
          </div>
        </div>

        {/* Content Card */}
        <div
          className="card"
          style={{
            padding: 'var(--space-8)',
            lineHeight: 1.7,
            fontSize: 'var(--text-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-6)',
          }}
        >
          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Eye size={18} color="var(--color-accent)" /> 1. Data We Collect
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              We collect information strictly necessary to provide the real-time code editor and related development tools:
            </p>
            <ul style={{ paddingLeft: 'var(--space-6)', marginTop: 'var(--space-2)', color: 'var(--color-text-muted)' }}>
              <li><strong>Account Identifiers:</strong> Email address, username, password hash (bcrypt), and OAuth provider IDs when signing in via Google. We discard Google access tokens immediately after identity verification.</li>
              <li><strong>Source Code & Project Files:</strong> All code, files, file trees, and configuration files you create, edit, or upload.</li>
              <li><strong>Chat Messages:</strong> Communication messages sent through the in-workspace team chat interface.</li>
              <li><strong>Execution Output:</strong> Terminal logs, standard output, and standard error produced when running your scripts.</li>
              <li><strong>Telemetry & Security:</strong> IP addresses and timestamps used for rate limiting, abuse prevention, and Cloudflare Turnstile bot detection.</li>
            </ul>
          </section>

          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Database size={18} color="var(--color-accent)" /> 2. Infrastructure & Data Processors
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              SyncSpace operates on the following managed cloud services:
            </p>
            <ul style={{ paddingLeft: 'var(--space-6)', marginTop: 'var(--space-2)', color: 'var(--color-text-muted)' }}>
              <li><strong>Neon (PostgreSQL):</strong> Relational database storing user records, workspace metadata, persistent files, and chat logs.</li>
              <li><strong>Upstash (Redis):</strong> In-memory data store managing ephemeral WebSocket session coordination and publish/subscribe routing.</li>
              <li><strong>Cloudflare (Turnstile & Edge Routing):</strong> Bot detection CAPTCHA on signup and network tunneling.</li>
              <li><strong>Vercel:</strong> Hosting provider for the Next.js frontend application.</li>
              <li><strong>Render:</strong> Hosting provider for the core Go API and WebSocket server.</li>
            </ul>
          </section>

          <section style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-5)', backgroundColor: 'var(--color-bg-surface)' }}>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <AlertTriangle size={18} color="var(--color-warning)" /> 3. Offline-Synchronization & Version Retention Notice
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              SyncSpace is a real-time collaborative platform. While your changes are automatically synchronized to our database, working offline or across sustained network drops is subject to known technical limitations:
            </p>
            <p style={{ color: 'var(--color-text)', marginTop: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
              If your client is disconnected from our WebSocket relays for more than a few seconds while other members edit the workspace, your local state may conflict or be rewritten upon reconnection. SyncSpace stores automatic version history snapshots so you can review and restore earlier revisions at any time.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Lock size={18} color="var(--color-accent)" /> 4. Cookies & Authentication
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              SyncSpace uses secure, httpOnly, SameSite=Lax cookies to maintain your login session (<code>syncspace_access</code> and <code>syncspace_refresh</code>) and protect against Cross-Site Request Forgery (CSRF). We do not use third-party advertising or cross-site tracking cookies.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)' }}>
              5. Data Retention & Deletion
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              You may delete any workspace, file, or chat history at any time through the workspace settings. Deleting a workspace removes the associated file contents and history from our database.
            </p>
          </section>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-faint)', fontSize: 'var(--text-xs)' }}>
          <p>© 2026 SyncSpace. Read our <Link href="/terms" style={{ color: 'var(--color-accent)' }}>Terms of Service</Link>.</p>
        </div>
      </div>
    </div>
  );
}
