'use client';

import React from 'react';
import { Logo, LogoMerge, LogoCursors } from '@/app/components/ui/logo';
import { ThemeToggle } from '@/app/components/ui/theme-toggle';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function BrandPage() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-app)' }}>
      {/* Header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          borderBottom: '1px solid var(--color-border-subtle)',
          background: 'var(--color-bg-app)',
        }}
      >
        <div
          style={{
            maxWidth: '960px',
            margin: '0 auto',
            padding: '0 var(--space-6)',
            height: '52px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
            <Link href="/dashboard" className="btn-icon" aria-label="Back to dashboard">
              <ArrowLeft size={16} />
            </Link>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Brand</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main style={{ maxWidth: '960px', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}>
        <h1 style={{ marginBottom: 'var(--space-2)' }}>Brand Guidelines</h1>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-md)', marginBottom: 'var(--space-12)' }}>
          Three logo concepts for review. Each scales from 20px to 32px, works in both themes, and uses no gradients.
        </p>

        {/* Logo Option A — Selected Primary Identity */}
        <LogoSection
          title="Option A — Converging Brackets (Primary Brand Identity)"
          description="Selected primary brand mark. Two angled chevrons meeting at center, symbolizing code syntax and real-time collaboration convergence. Verified legible from 16px to 512px."
        >
          <Logo size="sm" />
          <Logo size="md" />
          <Logo size="lg" />
          <Logo size="lg" showWordmark={false} />
        </LogoSection>

        {/* Brand Usage Rules: Minimum Size & Clear Space */}
        <section style={{ marginBottom: 'var(--space-12)', background: 'var(--color-bg-surface)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-panel)', padding: 'var(--space-6)' }}>
          <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-4)' }}>Usage & Construction Guidelines</h2>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-6)' }}>
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-control)', padding: 'var(--space-4)', background: 'var(--color-bg-app)' }}>
              <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-accent)', marginBottom: 'var(--space-2)' }}>
                Minimum Size
              </h3>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
                <strong>Stand-alone Icon Mark:</strong> 16px × 16px minimum (used in browser favicons, status bars, and compact tree badges). Counter-spaces remain open down to 16px.<br/>
                <strong>Icon + Wordmark:</strong> 20px icon height minimum. The wordmark text must never be rendered below 13px font size.
              </p>
            </div>

            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-control)', padding: 'var(--space-4)', background: 'var(--color-bg-app)' }}>
              <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-accent)', marginBottom: 'var(--space-2)' }}>
                Clear Space
              </h3>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
                Always maintain a minimum clear space zone equal to <strong>50% of the icon width (0.5X)</strong> around all four sides. No text, icons, buttons, or border rules should enter this exclusion boundary.
              </p>
            </div>

            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-control)', padding: 'var(--space-4)', background: 'var(--color-bg-app)' }}>
              <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-accent)', marginBottom: 'var(--space-2)' }}>
                Scale & Color Variations
              </h3>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
                <strong>Dark theme:</strong> Primary chevron in #F6F7F8, secondary in #3B82F6.<br/>
                <strong>Light theme:</strong> Primary chevron in #0F172A, secondary in #2563EB.<br/>
                <strong>Monochrome:</strong> Flat white or ink for single-color production.<br/>
                <strong>Reversed:</strong> Accent lead with neutral follower for badge accents.
              </p>
            </div>
          </div>
        </section>

        {/* Logo Option B */}
        <LogoSection
          title="Option B — Merge Node"
          description="Two branches converging to a single point. Represents git merge, sync, and unification."
        >
          <LogoMerge size="sm" />
          <LogoMerge size="md" />
          <LogoMerge size="lg" />
          <LogoMerge size="lg" showWordmark={false} />
        </LogoSection>

        {/* Logo Option C */}
        <LogoSection
          title="Option C — Cursor Pair"
          description="Two text cursors at different positions. Directly represents multi-user editing."
        >
          <LogoCursors size="sm" />
          <LogoCursors size="md" />
          <LogoCursors size="lg" />
          <LogoCursors size="lg" showWordmark={false} />
        </LogoSection>

        {/* Color Palette */}
        <section style={{ marginTop: 'var(--space-16)' }}>
          <h2 style={{ marginBottom: 'var(--space-6)' }}>Color Palette</h2>

          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
            Surfaces
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
            <Swatch name="bg-app" variable="--color-bg-app" />
            <Swatch name="bg-surface" variable="--color-bg-surface" />
            <Swatch name="bg-raised" variable="--color-bg-raised" />
            <Swatch name="bg-hover" variable="--color-bg-hover" />
            <Swatch name="bg-active" variable="--color-bg-active" />
          </div>

          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
            Borders
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
            <Swatch name="border-subtle" variable="--color-border-subtle" />
            <Swatch name="border" variable="--color-border" />
            <Swatch name="border-strong" variable="--color-border-strong" />
          </div>

          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
            Text
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
            <Swatch name="text" variable="--color-text" />
            <Swatch name="text-muted" variable="--color-text-muted" />
            <Swatch name="text-faint" variable="--color-text-faint" />
          </div>

          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
            Semantic
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
            <Swatch name="accent" variable="--color-accent" />
            <Swatch name="accent-solid" variable="--color-accent-solid" />
            <Swatch name="success" variable="--color-success" />
            <Swatch name="warning" variable="--color-warning" />
            <Swatch name="danger" variable="--color-danger" />
          </div>

          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
            Collaborator Colors
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
            <Swatch name="clay" variable="--collab-clay" />
            <Swatch name="sage" variable="--collab-sage" />
            <Swatch name="mauve" variable="--collab-mauve" />
            <Swatch name="ochre" variable="--collab-ochre" />
            <Swatch name="teal" variable="--collab-teal" />
            <Swatch name="rose" variable="--collab-rose" />
            <Swatch name="periwinkle" variable="--collab-periwinkle" />
            <Swatch name="olive" variable="--collab-olive" />
          </div>
        </section>

        {/* Typography */}
        <section style={{ marginTop: 'var(--space-16)' }}>
          <h2 style={{ marginBottom: 'var(--space-6)' }}>Typography</h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <div>
              <p className="text-sm text-muted" style={{ marginBottom: 'var(--space-2)' }}>
                IBM Plex Sans — 400 / 500 / 600
              </p>
              <h1>The quick brown fox jumps over the lazy dog</h1>
              <h2 style={{ marginTop: 'var(--space-2)' }}>The quick brown fox jumps over the lazy dog</h2>
              <h3 style={{ marginTop: 'var(--space-2)' }}>The quick brown fox jumps over the lazy dog</h3>
              <p style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-base)' }}>
                Body text at 14px. The quick brown fox jumps over the lazy dog. This is the default reading size.
              </p>
              <p style={{ marginTop: 'var(--space-1)', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                Small text at 13px, muted. Used for secondary labels, metadata, and captions.
              </p>
              <p style={{ marginTop: 'var(--space-1)', fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)' }}>
                Extra-small text at 12px, faint. Used for timestamps, version numbers, and tertiary info.
              </p>
            </div>

            <div>
              <p className="text-sm text-muted" style={{ marginBottom: 'var(--space-2)' }}>
                JetBrains Mono — 400 / 500
              </p>
              <code style={{ fontSize: 'var(--text-base)', display: 'block' }}>
                const editor = monaco.create(el, &#123; theme: &apos;syncspace-dark&apos; &#125;);
              </code>
              <code style={{ fontSize: 'var(--text-sm)', display: 'block', marginTop: 'var(--space-1)', color: 'var(--color-text-muted)' }}>
                func (s *Service) ValidateToken(token string) (*Claims, error)
              </code>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

/* ─── Sub-components ─── */

function LogoSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--space-12)' }}>
      <h3 style={{ fontSize: 'var(--text-md)', marginBottom: 'var(--space-1)' }}>{title}</h3>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-6)' }}>{description}</p>

      {/* Light bg */}
      <div
        style={{
          background: '#F6F7F8',
          border: '1px solid #E8EAED',
          borderRadius: 'var(--radius-panel)',
          padding: 'var(--space-8) var(--space-6)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-10)',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-3)',
        }}
      >
        <div data-theme="light" style={{ display: 'contents' }}>
          {children}
        </div>
      </div>

      {/* Dark bg */}
      <div
        style={{
          background: '#0D0F12',
          border: '1px solid #1E2329',
          borderRadius: 'var(--radius-panel)',
          padding: 'var(--space-8) var(--space-6)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-10)',
          flexWrap: 'wrap',
        }}
      >
        <div data-theme="dark" style={{ display: 'contents' }}>
          {children}
        </div>
      </div>
    </section>
  );
}

function Swatch({ name, variable }: { name: string; variable: string }) {
  return (
    <div>
      <div
        style={{
          width: '100%',
          height: '48px',
          background: `var(${variable})`,
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-control)',
          marginBottom: 'var(--space-1)',
        }}
      />
      <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text)' }}>{name}</p>
      <p style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-faint)' }}>{variable}</p>
    </div>
  );
}
