'use client';

import React, { useState } from 'react';
import { ThemeToggle } from '@/app/components/ui/theme-toggle';
import { Logo } from '@/app/components/ui/logo';
import Link from 'next/link';
import {
  ArrowLeft, Plus, Trash2, Settings, Search, Play, Save, Download,
  ChevronRight, ChevronDown, File, Folder, X, Check, AlertTriangle,
  Info, Copy, ExternalLink, MoreHorizontal, Eye, Edit3, Users, Lock
} from 'lucide-react';

export default function DesignSystemPage() {
  const [inputValue, setInputValue] = useState('');
  const [checkboxChecked, setCheckboxChecked] = useState(true);

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
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Design System</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main style={{ maxWidth: '960px', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}>
        <h1 style={{ marginBottom: 'var(--space-2)' }}>Component Library</h1>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-md)', marginBottom: 'var(--space-12)' }}>
          Every interactive element in every state. Toggle the theme to verify both modes.
        </p>

        {/* ─── Buttons ─── */}
        <Section title="Buttons">
          <Row label="Primary">
            <button className="btn btn-primary">Create</button>
            <button className="btn btn-primary" disabled>Disabled</button>
            <button className="btn btn-primary btn-sm">Small</button>
            <button className="btn btn-primary btn-lg">Large</button>
          </Row>
          <Row label="Secondary">
            <button className="btn btn-secondary">Cancel</button>
            <button className="btn btn-secondary" disabled>Disabled</button>
            <button className="btn btn-secondary btn-sm">Small</button>
          </Row>
          <Row label="Ghost">
            <button className="btn btn-ghost">Action</button>
            <button className="btn btn-ghost" disabled>Disabled</button>
            <button className="btn btn-ghost btn-sm">
              <Settings size={14} /> Settings
            </button>
          </Row>
          <Row label="Danger">
            <button className="btn btn-danger">Delete</button>
            <button className="btn btn-danger" disabled>Disabled</button>
            <button className="btn btn-danger btn-sm">
              <Trash2 size={14} /> Remove
            </button>
          </Row>
          <Row label="Run">
            <button className="btn btn-run">
              <Play size={14} /> Run
            </button>
            <button className="btn btn-run" disabled>
              <Play size={14} /> Running...
            </button>
          </Row>
          <Row label="Icon buttons">
            <button className="btn-icon"><Plus size={16} /></button>
            <button className="btn-icon"><Search size={16} /></button>
            <button className="btn-icon"><Settings size={16} /></button>
            <button className="btn-icon"><MoreHorizontal size={16} /></button>
            <button className="btn-icon"><X size={16} /></button>
          </Row>
          <Row label="With icons">
            <button className="btn btn-primary">
              <Plus size={14} /> New workspace
            </button>
            <button className="btn btn-secondary">
              <Download size={14} /> Export
            </button>
            <button className="btn btn-ghost">
              <Copy size={14} /> Copy link
            </button>
          </Row>
        </Section>

        {/* ─── Inputs ─── */}
        <Section title="Inputs">
          <Row label="Text input">
            <div style={{ width: '280px' }}>
              <label className="input-label" htmlFor="ds-name">Workspace name</label>
              <input
                id="ds-name"
                className="input"
                placeholder="my-project"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
              />
            </div>
          </Row>
          <Row label="Disabled">
            <div style={{ width: '280px' }}>
              <label className="input-label">Email (disabled)</label>
              <input className="input" value="user@example.com" disabled style={{ opacity: 0.5 }} />
            </div>
          </Row>
          <Row label="Select">
            <div style={{ width: '200px' }}>
              <label className="input-label" htmlFor="ds-lang">Language</label>
              <select id="ds-lang" className="input" style={{ cursor: 'pointer' }}>
                <option>JavaScript</option>
                <option>Python</option>
                <option>Go</option>
                <option>Ruby</option>
              </select>
            </div>
          </Row>
        </Section>

        {/* ─── Cards ─── */}
        <Section title="Cards">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 'var(--space-4)' }}>
            <div className="card">
              <h4 style={{ marginBottom: 'var(--space-2)' }}>Static card</h4>
              <p className="text-sm text-muted">Non-interactive container for content.</p>
            </div>
            <div className="card card-interactive">
              <h4 style={{ marginBottom: 'var(--space-2)' }}>Interactive card</h4>
              <p className="text-sm text-muted">Hover to see border change.</p>
            </div>
            <div className="card" style={{ padding: 'var(--space-4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <div style={{
                  width: '36px', height: '36px',
                  background: 'var(--color-bg-hover)',
                  borderRadius: 'var(--radius-control)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <File size={16} style={{ color: 'var(--color-text-faint)' }} />
                </div>
                <div>
                  <p className="font-medium" style={{ fontSize: 'var(--text-sm)' }}>api-server</p>
                  <p className="text-xs text-faint">/api-server</p>
                </div>
              </div>
            </div>
          </div>
        </Section>

        {/* ─── Badges ─── */}
        <Section title="Badges">
          <Row label="Default">
            <span className="badge">JavaScript</span>
            <span className="badge badge-success">Healthy</span>
            <span className="badge badge-warning">Degraded</span>
            <span className="badge badge-danger">Error</span>
          </Row>
          <Row label="Roles">
            <span className="badge">Owner</span>
            <span className="badge">Editor</span>
            <span className="badge">Viewer</span>
          </Row>
        </Section>

        {/* ─── Kbd ─── */}
        <Section title="Keyboard Shortcuts">
          <Row label="Keys">
            <span className="kbd">⌘</span>
            <span className="kbd">S</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>Save file</span>
          </Row>
          <Row label="Combo">
            <span className="kbd">⌘</span>
            <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-xs)' }}>+</span>
            <span className="kbd">Enter</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>Run code</span>
          </Row>
          <Row label="Toggle">
            <span className="kbd">⌘</span>
            <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-xs)' }}>+</span>
            <span className="kbd">K</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>AI assistant</span>
          </Row>
        </Section>

        {/* ─── Alerts ─── */}
        <Section title="Alerts">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxWidth: '480px' }}>
            <div className="alert alert-error">
              <AlertTriangle size={16} />
              Failed to save file. Check your connection.
            </div>
            <div className="alert alert-success">
              <Check size={16} />
              Workspace created successfully.
            </div>
            <div className="alert alert-warning">
              <AlertTriangle size={16} />
              Execution timed out after 10 seconds.
            </div>
          </div>
        </Section>

        {/* ─── Empty State ─── */}
        <Section title="Empty State">
          <div className="card" style={{ maxWidth: '480px' }}>
            <div className="empty-state" style={{ padding: 'var(--space-10)' }}>
              <Folder size={48} className="empty-state-icon" />
              <p className="empty-state-title">No workspaces yet</p>
              <p className="empty-state-description">
                Create your first workspace to start coding collaboratively.
              </p>
              <button className="btn btn-primary" style={{ marginTop: 'var(--space-4)' }}>
                <Plus size={14} /> New workspace
              </button>
            </div>
          </div>
        </Section>

        {/* ─── Skeleton ─── */}
        <Section title="Skeleton Loading">
          <div className="card" style={{ padding: 'var(--space-4)', maxWidth: '320px' }}>
            <div className="skeleton" style={{ height: '16px', width: '60%', marginBottom: 'var(--space-3)' }} />
            <div className="skeleton" style={{ height: '12px', width: '40%', marginBottom: 'var(--space-4)' }} />
            <div className="skeleton" style={{ height: '12px', width: '80%' }} />
          </div>
        </Section>

        {/* ─── Spinner ─── */}
        <Section title="Spinner">
          <Row label="Sizes">
            <div className="spinner" style={{ width: '16px', height: '16px' }} />
            <div className="spinner" />
            <div className="spinner" style={{ width: '32px', height: '32px' }} />
          </Row>
        </Section>

        {/* ─── Table ─── */}
        <Section title="Table">
          <div style={{ maxWidth: '600px', overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Language</th>
                  <th>Updated</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-medium">api-server</td>
                  <td><span className="badge">Go</span></td>
                  <td className="text-faint">2m ago</td>
                  <td><span className="badge">Owner</span></td>
                </tr>
                <tr>
                  <td className="font-medium">frontend-app</td>
                  <td><span className="badge">TypeScript</span></td>
                  <td className="text-faint">1h ago</td>
                  <td><span className="badge">Editor</span></td>
                </tr>
                <tr>
                  <td className="font-medium">ml-pipeline</td>
                  <td><span className="badge">Python</span></td>
                  <td className="text-faint">3d ago</td>
                  <td><span className="badge">Viewer</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>

        {/* ─── Icons ─── */}
        <Section title="Icon Set (Lucide, 16px)">
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-4)',
            color: 'var(--color-text-muted)',
          }}>
            {[
              { icon: <File size={16} />, label: 'File' },
              { icon: <Folder size={16} />, label: 'Folder' },
              { icon: <Play size={16} />, label: 'Play' },
              { icon: <Save size={16} />, label: 'Save' },
              { icon: <Search size={16} />, label: 'Search' },
              { icon: <Settings size={16} />, label: 'Settings' },
              { icon: <Plus size={16} />, label: 'Plus' },
              { icon: <Trash2 size={16} />, label: 'Trash' },
              { icon: <X size={16} />, label: 'Close' },
              { icon: <Check size={16} />, label: 'Check' },
              { icon: <Copy size={16} />, label: 'Copy' },
              { icon: <ExternalLink size={16} />, label: 'External' },
              { icon: <Edit3 size={16} />, label: 'Edit' },
              { icon: <Eye size={16} />, label: 'Eye' },
              { icon: <Users size={16} />, label: 'Users' },
              { icon: <Lock size={16} />, label: 'Lock' },
              { icon: <Info size={16} />, label: 'Info' },
              { icon: <AlertTriangle size={16} />, label: 'Warning' },
              { icon: <ChevronRight size={16} />, label: 'Right' },
              { icon: <ChevronDown size={16} />, label: 'Down' },
              { icon: <Download size={16} />, label: 'Download' },
              { icon: <MoreHorizontal size={16} />, label: 'More' },
              { icon: <ArrowLeft size={16} />, label: 'Back' },
            ].map(({ icon, label }) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  width: '56px',
                }}
              >
                {icon}
                <span className="text-xs text-faint">{label}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── Spacing Scale ─── */}
        <Section title="Spacing Scale (4px grid)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => (
              <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <span className="font-mono text-xs text-faint" style={{ width: '80px' }}>--space-{n}</span>
                <div
                  style={{
                    height: '12px',
                    width: `${n * 4}px`,
                    background: 'var(--color-accent)',
                    borderRadius: '2px',
                    opacity: 0.6,
                  }}
                />
                <span className="text-xs text-faint">{n * 4}px</span>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── Collaborator Colors ─── */}
        <Section title="Collaborator Cursors">
          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            {[
              { name: 'Clay', color: 'var(--collab-clay)' },
              { name: 'Sage', color: 'var(--collab-sage)' },
              { name: 'Mauve', color: 'var(--collab-mauve)' },
              { name: 'Ochre', color: 'var(--collab-ochre)' },
              { name: 'Teal', color: 'var(--collab-teal)' },
              { name: 'Rose', color: 'var(--collab-rose)' },
              { name: 'Periwinkle', color: 'var(--collab-periwinkle)' },
              { name: 'Olive', color: 'var(--collab-olive)' },
            ].map(({ name, color }) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <div style={{
                  width: '3px', height: '20px',
                  background: color,
                  borderRadius: '2px',
                }} />
                <span style={{ fontSize: '12px', fontWeight: 500, color }}>{name}</span>
              </div>
            ))}
          </div>
        </Section>
      </main>
    </div>
  );
}

/* ─── Layout helpers ─── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--space-12)' }}>
      <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-4)' }}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
      <span
        className="text-xs text-faint font-mono"
        style={{ width: '100px', flexShrink: 0 }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}
