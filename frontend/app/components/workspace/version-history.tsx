'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { History, Save, RotateCcw, X, GitCompare, Clock, Tag, ChevronDown, ChevronRight } from 'lucide-react';
import { workspaceAPI, FileVersion } from '@/app/lib/api';

interface VersionHistoryProps {
  slug: string;
  filePath: string;
  currentContent: string;
  onRestore: (content: string) => void;
  onClose: () => void;
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function kindBadge(kind: string) {
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    manual: { bg: 'rgba(99, 102, 241, 0.15)', color: '#6366F1', label: 'Saved' },
    auto: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B', label: 'Auto' },
    restore: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10B981', label: 'Restored' },
  };
  const s = styles[kind] || styles.auto;
  return (
    <span style={{
      fontSize: '9px', fontWeight: 700, padding: '1px 5px',
      borderRadius: '3px', background: s.bg, color: s.color,
      textTransform: 'uppercase', letterSpacing: '0.03em',
    }}>{s.label}</span>
  );
}

// Simple line-by-line diff
function computeDiff(oldText: string, newText: string): Array<{ type: 'add' | 'remove' | 'same'; line: string; lineNum: number }> {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: Array<{ type: 'add' | 'remove' | 'same'; line: string; lineNum: number }> = [];

  // Simple LCS-based diff
  const m = oldLines.length, n = newLines.length;
  // For performance, use a simplified approach for large files
  if (m + n > 2000) {
    // Fall back to a simpler comparison
    const maxLen = Math.max(m, n);
    for (let i = 0; i < maxLen; i++) {
      if (i < m && i < n && oldLines[i] === newLines[i]) {
        result.push({ type: 'same', line: newLines[i], lineNum: i + 1 });
      } else {
        if (i < m) result.push({ type: 'remove', line: oldLines[i], lineNum: i + 1 });
        if (i < n) result.push({ type: 'add', line: newLines[i], lineNum: i + 1 });
      }
    }
    return result;
  }

  // Build LCS table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to get diff
  let i = m, j = n;
  const diffLines: Array<{ type: 'add' | 'remove' | 'same'; line: string }> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.unshift({ type: 'same', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.unshift({ type: 'add', line: newLines[j - 1] });
      j--;
    } else {
      diffLines.unshift({ type: 'remove', line: oldLines[i - 1] });
      i--;
    }
  }

  let lineNum = 0;
  return diffLines.map(d => ({ ...d, lineNum: ++lineNum }));
}

export function VersionHistory({ slug, filePath, currentContent, onRestore, onClose }: VersionHistoryProps) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveLabel, setSaveLabel] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [diffView, setDiffView] = useState<{ old: FileVersion; new: FileVersion } | null>(null);
  const [diffContent, setDiffContent] = useState<{ oldContent: string; newContent: string } | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);

  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true);
      const res = await workspaceAPI.listVersions(slug, filePath);
      setVersions(res.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [slug, filePath]);

  useEffect(() => { fetchVersions(); }, [fetchVersions]);

  const handleSave = async () => {
    if (saving) return;
    try {
      setSaving(true);
      await workspaceAPI.createVersion(slug, filePath, currentContent, saveLabel || 'Manual snapshot', 'manual');
      setSaveLabel('');
      setShowSaveInput(false);
      await fetchVersions();
    } catch (e) {
      console.error('Save version failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (versionId: string) => {
    if (restoring) return;
    try {
      setRestoring(true);
      const res = await workspaceAPI.restoreVersion(slug, versionId);
      // Get the restored version's content
      const restored = await workspaceAPI.getVersion(slug, versionId);
      onRestore(restored.data.content);
      await fetchVersions();
    } catch (e) {
      console.error('Restore failed:', e);
    } finally {
      setRestoring(false);
    }
  };

  const handleDiff = async (v1Id: string, v2Id: string) => {
    try {
      const [r1, r2] = await Promise.all([
        workspaceAPI.getVersion(slug, v1Id),
        workspaceAPI.getVersion(slug, v2Id),
      ]);
      // Older first
      const older = new Date(r1.data.created_at) < new Date(r2.data.created_at) ? r1.data : r2.data;
      const newer = older === r1.data ? r2.data : r1.data;
      setDiffView({ old: older, new: newer });
      setDiffContent({ oldContent: older.content, newContent: newer.content });
    } catch (e) {
      console.error('Diff failed:', e);
    }
  };

  const toggleSelection = (id: string) => {
    setSelectedVersions(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2) return [prev[1], id]; // keep last selected + new
      return [...prev, id];
    });
  };

  // Diff view
  if (diffView && diffContent) {
    const diffLines = computeDiff(diffContent.oldContent, diffContent.newContent);
    const additions = diffLines.filter(d => d.type === 'add').length;
    const deletions = diffLines.filter(d => d.type === 'remove').length;

    return (
      <div id="version-history-panel" style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)',
      }}>
        {/* Diff header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface-elevated)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <GitCompare size={13} style={{ color: '#6366F1' }} />
            <span style={{ fontWeight: 700, fontSize: '12px', color: 'var(--color-text-primary)' }}>Diff View</span>
            <span style={{ fontSize: '10px', color: '#10B981' }}>+{additions}</span>
            <span style={{ fontSize: '10px', color: '#EF4444' }}>-{deletions}</span>
          </div>
          <button onClick={() => { setDiffView(null); setDiffContent(null); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '2px' }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border-subtle)' }}>
          <span style={{ color: '#EF4444' }}>─ {diffView.old.label || timeAgo(diffView.old.created_at)} ({diffView.old.author_name})</span>
          {' → '}
          <span style={{ color: '#10B981' }}>+ {diffView.new.label || timeAgo(diffView.new.created_at)} ({diffView.new.author_name})</span>
        </div>
        {/* Diff content */}
        <div id="diff-content" style={{
          flex: 1, overflow: 'auto', fontFamily: 'var(--font-mono, monospace)',
          fontSize: '12px', lineHeight: '20px',
        }}>
          {diffLines.map((d, i) => (
            <div key={i} style={{
              padding: '0 12px', whiteSpace: 'pre-wrap',
              background: d.type === 'add' ? 'rgba(16, 185, 129, 0.08)' :
                          d.type === 'remove' ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
              color: d.type === 'add' ? '#10B981' :
                     d.type === 'remove' ? '#EF4444' : 'var(--color-text-secondary)',
              borderLeft: d.type === 'add' ? '3px solid #10B981' :
                          d.type === 'remove' ? '3px solid #EF4444' : '3px solid transparent',
            }}>
              <span style={{ display: 'inline-block', width: '30px', opacity: 0.4, userSelect: 'none' }}>{d.lineNum}</span>
              <span style={{ opacity: 0.5 }}>{d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' '} </span>
              {d.line}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div id="version-history-panel" style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)',
      width: '100%',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px', borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface-elevated)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <History size={14} style={{ color: '#6366F1' }} />
          <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--color-text-primary)' }}>
            Version History
          </span>
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
            {versions.length} snapshot{versions.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '2px' }}>
          <X size={14} />
        </button>
      </div>

      {/* Save button */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-subtle)' }}>
        {showSaveInput ? (
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              value={saveLabel}
              onChange={e => setSaveLabel(e.target.value)}
              placeholder="Version label (optional)"
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              autoFocus
              style={{
                flex: 1, padding: '4px 8px', fontSize: '11px',
                background: 'var(--color-bg-app)', border: '1px solid var(--color-border)',
                borderRadius: '4px', color: 'var(--color-text-primary)',
                outline: 'none',
              }}
            />
            <button onClick={handleSave} disabled={saving}
              style={{
                padding: '4px 10px', fontSize: '11px', fontWeight: 600,
                background: '#6366F1', color: 'white', border: 'none',
                borderRadius: '4px', cursor: 'pointer', opacity: saving ? 0.6 : 1,
              }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setShowSaveInput(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '2px' }}>
              <X size={12} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => setShowSaveInput(true)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                padding: '5px', fontSize: '11px', fontWeight: 600,
                background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)', borderRadius: '4px', cursor: 'pointer',
              }}>
              <Save size={12} /> Save Version
            </button>
            {selectedVersions.length === 2 && (
              <button onClick={() => handleDiff(selectedVersions[0], selectedVersions[1])}
                style={{
                  display: 'flex', alignItems: 'center', gap: '4px',
                  padding: '5px 10px', fontSize: '11px', fontWeight: 600,
                  background: 'rgba(99, 102, 241, 0.1)', color: '#6366F1',
                  border: '1px solid rgba(99, 102, 241, 0.3)', borderRadius: '4px', cursor: 'pointer',
                }}>
                <GitCompare size={12} /> Diff
              </button>
            )}
          </div>
        )}
        {selectedVersions.length > 0 && selectedVersions.length < 2 && (
          <div style={{ fontSize: '9px', color: 'var(--color-text-muted)', marginTop: '4px', textAlign: 'center' }}>
            Select one more version to compare
          </div>
        )}
      </div>

      {/* Version list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {loading ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '12px' }}>
            Loading versions…
          </div>
        ) : versions.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '12px' }}>
            No versions yet. Save a version to start tracking history.
          </div>
        ) : (
          versions.map((v, i) => {
            const isSelected = selectedVersions.includes(v.id);
            return (
              <div
                key={v.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '8px 12px', cursor: 'pointer',
                  background: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                  borderLeft: isSelected ? '3px solid #6366F1' : '3px solid transparent',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  transition: 'background 0.15s',
                }}
                onClick={() => toggleSelection(v.id)}
              >
                <div style={{
                  width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0,
                  border: isSelected ? '2px solid #6366F1' : '2px solid var(--color-border)',
                  background: isSelected ? '#6366F1' : 'transparent',
                  marginTop: '2px', transition: 'all 0.15s',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    {kindBadge(v.kind)}
                    <span style={{
                      fontSize: '12px', fontWeight: 600, color: 'var(--color-text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {v.label || timeAgo(v.created_at)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', fontSize: '10px', color: 'var(--color-text-muted)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <Clock size={9} /> {new Date(v.created_at).toLocaleString()}
                    </span>
                    <span>by {v.author_name || 'unknown'}</span>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleRestore(v.id); }}
                  disabled={restoring}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '3px',
                    padding: '3px 8px', fontSize: '10px', fontWeight: 600,
                    background: 'rgba(16, 185, 129, 0.1)', color: '#10B981',
                    border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '4px',
                    cursor: 'pointer', flexShrink: 0, opacity: restoring ? 0.5 : 1,
                  }}
                  title="Restore this version (creates a new snapshot, doesn't delete history)"
                >
                  <RotateCcw size={10} /> Restore
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
