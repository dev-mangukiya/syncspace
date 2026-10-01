'use client';

import Link from 'next/link';
import { ArrowRight, Code2, Shield, Cpu, Users, Terminal, Bot } from 'lucide-react';
import { Logo } from '@/app/components/ui/logo';
import { ThemeToggle } from '@/app/components/ui/theme-toggle';

export default function LandingPage() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-app)' }}>
      {/* Navigation */}
      <nav style={{
        padding: 'var(--space-4) var(--space-8)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        maxWidth: '1080px', margin: '0 auto',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}>
        <Logo size="md" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <ThemeToggle mode="toggle" />
          <Link href="/auth/login" className="btn btn-ghost">Sign in</Link>
          <Link href="/auth/signup" className="btn btn-primary">
            Get started <ArrowRight size={14} />
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{
        maxWidth: '1080px', margin: '0 auto',
        padding: 'var(--space-16) var(--space-8)',
        textAlign: 'center',
      }}>
        <h1 style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 600,
          letterSpacing: '-0.03em',
          lineHeight: 1.15,
          marginBottom: 'var(--space-4)',
          maxWidth: '720px',
          margin: '0 auto var(--space-4)',
        }}>
          Code together,<br />
          ship faster.
        </h1>

        <p style={{
          fontSize: 'var(--text-md)',
          color: 'var(--color-text-muted)',
          maxWidth: '520px',
          margin: '0 auto var(--space-8)',
          lineHeight: 1.6,
        }}>
          A collaborative code editor with real-time sync, sandboxed
          execution, and AI assistance. Built for teams that write code together.
        </p>

        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center', marginBottom: 'var(--space-16)' }}>
          <Link href="/auth/signup" className="btn btn-primary btn-lg">
            Start building <ArrowRight size={16} />
          </Link>
          <Link href="/auth/login" className="btn btn-secondary btn-lg">
            Sign in
          </Link>
        </div>

        {/* Code preview block */}
        <div style={{
          maxWidth: '640px',
          margin: '0 auto',
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-panel)',
          overflow: 'hidden',
          textAlign: 'left',
        }}>
          {/* Window chrome */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            borderBottom: '1px solid var(--color-border-subtle)',
            background: 'var(--color-bg-raised)',
          }}>
            <div style={{ display: 'flex', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-danger)', opacity: 0.7 }} />
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-warning)', opacity: 0.7 }} />
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-success)', opacity: 0.7 }} />
            </div>
            <span style={{ fontSize: '11px', color: 'var(--color-text-faint)', fontFamily: 'var(--font-mono)' }}>
              server.go
            </span>
          </div>
          <pre style={{
            padding: 'var(--space-4) var(--space-5)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.7,
            color: 'var(--color-text)',
            margin: 0,
            overflow: 'auto',
          }}>
{`func main() {
    r := chi.NewRouter()
    r.Use(middleware.RateLimiter(10, 60*time.Second))
    r.Use(middleware.SecurityHeaders)

    r.Post("/api/exec/run", handler.Execute)
    
    log.Println("SyncSpace listening on :8080")
    http.ListenAndServe(":8080", r)
}`}
          </pre>
        </div>
      </section>

      {/* Features */}
      <section style={{
        maxWidth: '1080px', margin: '0 auto',
        padding: '0 var(--space-8) var(--space-16)',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 'var(--space-6)',
        }}>
          <FeatureCard
            icon={<Terminal size={20} />}
            title="Sandboxed Execution"
            description="Run code in isolated Docker containers. Network disabled, read-only filesystem, memory-capped. Results in milliseconds."
          />
          <FeatureCard
            icon={<Bot size={20} />}
            title="AI Assistant"
            description="Ask AI to fix bugs, explain logic, optimize performance, or write tests. Context-aware with your active file."
          />
          <FeatureCard
            icon={<Shield size={20} />}
            title="Security First"
            description="Rate limiting, RBAC, capability-dropped containers, non-root execution, and security headers on every response."
          />
          <FeatureCard
            icon={<Code2 size={20} />}
            title="Monaco Editor"
            description="VS Code's editor engine with custom themes, bracket matching, autocomplete, and smooth animations."
          />
          <FeatureCard
            icon={<Users size={20} />}
            title="Workspace Collaboration"
            description="Shared workspaces with role-based access: Owner, Editor, Viewer. File explorer, auto-save, and keyboard shortcuts."
          />
          <FeatureCard
            icon={<Cpu size={20} />}
            title="Multi-Language"
            description="Python, JavaScript, Go, Ruby, and TypeScript. Each runs in its own Alpine-based container with the right runtime."
          />
        </div>
      </section>

      {/* Footer */}
      <footer style={{
        borderTop: '1px solid var(--color-border-subtle)',
        padding: 'var(--space-6) var(--space-8)',
        maxWidth: '1080px', margin: '0 auto',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)' }}>
          SyncSpace — Built with Go, Next.js, and Docker
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
          <Link href="/brand" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)' }}>Brand</Link>
          <Link href="/design-system" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)' }}>Design System</Link>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="card" style={{ padding: 'var(--space-6)' }}>
      <div style={{
        width: '36px', height: '36px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--color-accent-subtle)',
        borderRadius: 'var(--radius-control)',
        color: 'var(--color-accent)',
        marginBottom: 'var(--space-4)',
      }}>
        {icon}
      </div>
      <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
        {title}
      </h3>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
        {description}
      </p>
    </div>
  );
}
