import Link from 'next/link';
import { Logo } from '@/app/components/ui/logo';
import { ArrowLeft, ShieldAlert, FileText, Cpu, AlertTriangle, Users } from 'lucide-react';

export const metadata = {
  title: 'Terms of Service — SyncSpace',
  description: 'Terms of service and usage policies for the SyncSpace collaborative IDE beta.',
};

export default function TermsPage() {
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
            Terms of Service
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>
            Effective Date: October 2026 • SyncSpace Public Beta
          </p>
        </div>

        {/* Notice Banner */}
        <div
          className="alert"
          style={{
            backgroundColor: 'rgba(194, 154, 75, 0.12)',
            borderColor: 'var(--color-warning)',
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 'var(--space-8)',
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={20} color="var(--color-warning)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong style={{ color: 'var(--color-warning)', display: 'block', marginBottom: 'var(--space-1)' }}>
              Public Beta Disclaimer — No Uptime Guarantee
            </strong>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
              SyncSpace is provided as an experimental public beta on a zero-cost infrastructure tier. We do not offer any service level agreements (SLAs) or uptime guarantees. Containers, WebSocket relays, and compute sessions may restart or be evicted without advance notice.
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
              <FileText size={18} color="var(--color-accent)" /> 1. Overview & Acceptance
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              By registering an account or accessing the SyncSpace collaborative IDE, you agree to comply with and be bound by these Terms of Service. If you do not agree to these terms, do not access or use SyncSpace.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Users size={18} color="var(--color-accent)" /> 2. Information We Collect
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              To deliver real-time collaboration and cloud code execution, SyncSpace collects and processes the following information:
            </p>
            <ul style={{ paddingLeft: 'var(--space-6)', marginTop: 'var(--space-2)', color: 'var(--color-text-muted)' }}>
              <li><strong>Account Credentials:</strong> Email address, hashed password, username, and OAuth profile identifiers (when using Google Sign-In).</li>
              <li><strong>Workspace & Code Content:</strong> Source code files, file hierarchies, metadata, and version history snapshots created in your workspaces.</li>
              <li><strong>Real-Time Communications:</strong> In-workspace team chat messages and ephemeral collaboration signals (cursor positions, presence).</li>
              <li><strong>Execution Telemetry:</strong> Code run timestamps, runtime languages, and standard output/error logs generated in the sandbox.</li>
            </ul>
          </section>

          <section style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-5)', backgroundColor: 'var(--color-bg-surface)' }}>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <ShieldAlert size={18} color="var(--color-danger)" /> 3. Real-Time Collaboration & Known Offline-Sync Limitation
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              SyncSpace coordinates simultaneous edits using Conflict-Free Replicated Data Types (CRDTs via Yjs) over persistent WebSockets. 
            </p>
            <div style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3) var(--space-4)', backgroundColor: 'rgba(194, 91, 86, 0.08)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--color-danger)' }}>
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
                <strong>Offline-Sync Limitation (BLOCKER-001):</strong> If your client loses internet connectivity, closes its WebSocket connection, or background tab throttling occurs for more than a few seconds while other collaborators edit the file, changes made locally during the disconnect may conflict or be superseded upon reconnection. While SyncSpace features a reconnection disclaimer banner and automatic snapshot creation, you are advised to inspect <strong>Version History</strong> immediately after any connection drop before resuming heavy editing.
              </p>
            </div>
          </section>

          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Cpu size={18} color="var(--color-accent)" /> 4. Sandboxed Code Execution & Prohibited Activities
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              SyncSpace provides containerized code execution for debugging and demonstration purposes. Code execution is gated behind verified email accounts and rate-limited. You agree NOT to use the execution environment for:
            </p>
            <ul style={{ paddingLeft: 'var(--space-6)', marginTop: 'var(--space-2)', color: 'var(--color-text-muted)' }}>
              <li>Cryptocurrency mining or unauthorized distributed compute workloads.</li>
              <li>Network scanning, denial-of-service (DoS) attempts, or outbound attacks.</li>
              <li>Malware dissemination, exploitation attempts, or host sandbox escapes.</li>
              <li>Automated bot traffic circumventing Turnstile CAPTCHA or rate limits.</li>
            </ul>
          </section>

          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)' }}>
              5. Ownership of Code
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              You retain all intellectual property rights and full ownership of the code, files, and assets you author within SyncSpace. SyncSpace does not claim any ownership rights over your work.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--color-text)' }}>
              6. Account Termination
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              We reserve the right to suspend or terminate access to any user or workspace found in violation of these terms or abusing shared compute resources, without prior liability.
            </p>
          </section>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-faint)', fontSize: 'var(--text-xs)' }}>
          <p>© 2026 SyncSpace. Read our <Link href="/privacy" style={{ color: 'var(--color-accent)' }}>Privacy Policy</Link>.</p>
        </div>
      </div>
    </div>
  );
}
