'use client';

import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, Trash2, Folder, X, LogOut } from 'lucide-react';
import { useAuthStore } from '@/app/lib/store';
import { workspaceAPI, Workspace } from '@/app/lib/api';
import { Logo } from '@/app/components/ui/logo';
import { ThemeToggle } from '@/app/components/ui/theme-toggle';

export default function DashboardPage() {
  const router = useRouter();
  const { user, isLoading: authLoading, isAuthenticated, checkAuth, logout } = useAuthStore();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createTemplate, setCreateTemplate] = useState('javascript');
  const [createLoading, setCreateLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { checkAuth(); }, [checkAuth]);
  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push('/auth/login');
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (isAuthenticated) loadWorkspaces();
  }, [isAuthenticated]);

  const loadWorkspaces = async () => {
    try {
      const response = await workspaceAPI.list();
      setWorkspaces(response.data);
    } catch {
      setError('Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreateLoading(true);
    setError('');

    try {
      const response = await workspaceAPI.create({
        name: createName,
        template: createTemplate,
        language: createTemplate,
      });
      setWorkspaces([response.data, ...workspaces]);
      setShowCreate(false);
      setCreateName('');
    } catch {
      setError('Failed to create workspace');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleDelete = async (slug: string) => {
    if (!confirm('Delete this workspace? This cannot be undone.')) return;
    try {
      await workspaceAPI.delete(slug);
      setWorkspaces(workspaces.filter((w) => w.slug !== slug));
    } catch {
      setError('Failed to delete workspace');
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const languageLabels: Record<string, string> = {
    javascript: 'JS',
    python: 'Python',
    blank: 'Blank',
    go: 'Go',
    ruby: 'Ruby',
  };

  if (authLoading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  if (!isAuthenticated) return null;

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
            maxWidth: '1080px',
            margin: '0 auto',
            padding: '0 var(--space-6)',
            height: '52px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Logo size="sm" />

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <ThemeToggle />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: 'var(--space-1) var(--space-3)',
                borderRadius: 'var(--radius-control)',
              }}
            >
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: 'var(--color-accent-solid)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'white',
                }}
              >
                {user?.username?.charAt(0).toUpperCase()}
              </div>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                {user?.username}
              </span>
            </div>
            <button
              onClick={logout}
              className="btn-icon"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main style={{ maxWidth: '1080px', margin: '0 auto', padding: 'var(--space-10) var(--space-6)' }}>
        {/* Welcome section */}
        <div style={{ marginBottom: 'var(--space-8)' }}>
          <h2 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
            Welcome back, {user?.display_name || user?.username}
          </h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-base)' }}>
            Your collaborative workspaces
          </p>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 'var(--space-6)' }}>
            {error}
          </div>
        )}

        {/* Actions bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--space-6)',
          }}
        >
          <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-sm)' }}>
            {workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''}
          </p>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="btn btn-primary"
          >
            <Plus size={14} />
            New workspace
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="card animate-slide-up" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-6)' }}>
            <form onSubmit={handleCreate}>
              <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: '1', minWidth: '200px' }}>
                  <label className="input-label" htmlFor="ws-name">Workspace name</label>
                  <input
                    id="ws-name"
                    type="text"
                    className="input"
                    placeholder="my-project"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    required
                    autoFocus
                    minLength={3}
                    maxLength={48}
                  />
                </div>
                <div style={{ minWidth: '160px' }}>
                  <label className="input-label" htmlFor="ws-template">Template</label>
                  <select
                    id="ws-template"
                    className="input"
                    value={createTemplate}
                    onChange={(e) => setCreateTemplate(e.target.value)}
                    style={{ cursor: 'pointer' }}
                  >
                    <option value="javascript">JavaScript</option>
                    <option value="python">Python</option>
                    <option value="blank">Blank</option>
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <button type="submit" className="btn btn-primary" disabled={createLoading}>
                    {createLoading ? (
                      <span className="spinner" style={{ width: '14px', height: '14px' }} />
                    ) : (
                      'Create'
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setShowCreate(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {/* Workspace grid */}
        {loading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 'var(--space-4)',
          }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="card" style={{ padding: 'var(--space-6)' }}>
                <div className="skeleton" style={{ height: '16px', width: '60%', marginBottom: 'var(--space-3)' }} />
                <div className="skeleton" style={{ height: '12px', width: '40%', marginBottom: 'var(--space-5)' }} />
                <div className="skeleton" style={{ height: '12px', width: '80%' }} />
              </div>
            ))}
          </div>
        ) : workspaces.length === 0 ? (
          <div className="empty-state">
            <Folder size={48} className="empty-state-icon" />
            <p className="empty-state-title">No workspaces yet</p>
            <p className="empty-state-description">
              Create your first workspace to start coding collaboratively.
            </p>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 'var(--space-4)',
          }}>
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="card card-interactive"
                style={{ padding: 'var(--space-5)', position: 'relative' }}
                onClick={() => router.push(`/w/${ws.short_id}`)}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  marginBottom: 'var(--space-3)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--color-bg-hover)',
                        borderRadius: 'var(--radius-control)',
                        color: 'var(--color-text-faint)',
                      }}
                    >
                      <Folder size={16} />
                    </div>
                    <div>
                      <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{ws.name}</h3>
                      <p
                        className="font-mono"
                        style={{
                          fontSize: '11px',
                          color: 'var(--color-text-faint)',
                        }}
                      >
                        /{ws.slug}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(ws.slug);
                    }}
                    className="btn-icon"
                    style={{ width: '24px', height: '24px', opacity: 0, transition: 'opacity 0.15s' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0'; }}
                    aria-label={`Delete workspace ${ws.name}`}
                  >
                    <X size={14} />
                  </button>
                </div>

                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  marginTop: 'var(--space-3)',
                }}>
                  <span className="badge">
                    {languageLabels[ws.template] || ws.template}
                  </span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)' }}>
                    {formatDate(ws.updated_at)}
                  </span>
                  {ws.role && (
                    <span className="badge" style={{ marginLeft: 'auto' }}>
                      {ws.role}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
