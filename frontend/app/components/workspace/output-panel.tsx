'use client';

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import {
  X, Play, Square, Info, History, Terminal,
  CheckCircle2, XCircle, AlertTriangle, Clock, RefreshCw, ChevronLeft
} from 'lucide-react';
import { AnsiRenderer } from '@/app/lib/ansi';

export interface RunHistoryItem {
  id: string;
  run_id: string;
  workspace_id: string;
  user_id: string | null;
  username: string;
  file_path: string;
  language: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  cancelled: boolean;
  truncated: boolean;
  output: string;
  created_at: string;
}

export interface ExecLimits {
  timeout_seconds: number;
  memory_limit: string;
  cpu_limit: string;
  pids_limit: number;
  max_code_size_kb: number;
  max_output_size_kb: number;
  network: string;
  read_only_rootfs: boolean;
  user: string;
}

interface OutputPanelProps {
  slug: string;
  userRole?: string;
  outputHeight: number;
  onResizeStart: (e: React.MouseEvent) => void;
  onClose: () => void;
  isRunning: boolean;
  runningUser: string | null;
  onCancelRun: () => void;
  activeRunOutput: string;
  lastRunResult: {
    exitCode: number;
    durationMs: number;
    peakMemoryBytes?: number;
    truncated?: boolean;
    timedOut?: boolean;
    cancelled?: boolean;
  } | null;
  isEmailBlocked?: boolean;
}

export const OutputPanel: React.FC<OutputPanelProps> = ({
  slug,
  userRole,
  outputHeight,
  onResizeStart,
  onClose,
  isRunning,
  runningUser,
  onCancelRun,
  activeRunOutput,
  lastRunResult,
  isEmailBlocked,
}) => {
  const [activeTab, setActiveTab] = useState<'output' | 'history'>('output');
  const [history, setHistory] = useState<RunHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryRun, setSelectedHistoryRun] = useState<RunHistoryItem | null>(null);
  const [showLimits, setShowLimits] = useState(false);
  const [limits, setLimits] = useState<ExecLimits | null>(null);
  const [limitsLoading, setLimitsLoading] = useState(false);

  const outputContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // Fetch configured limits from server
  const fetchLimits = useCallback(async () => {
    try {
      setLimitsLoading(true);
      const res = await axios.get<ExecLimits>('/api/exec/limits');
      setLimits(res.data);
    } catch (err) {
      console.error('Failed to fetch exec limits:', err);
    } finally {
      setLimitsLoading(false);
    }
  }, []);

  // Fetch execution history (last 50 runs)
  const fetchHistory = useCallback(async () => {
    try {
      setHistoryLoading(true);
      const res = await axios.get<RunHistoryItem[]>(`/api/workspaces/${slug}/runs`, {
        withCredentials: true,
      });
      setHistory(res.data || []);
    } catch (err) {
      console.error('Failed to fetch run history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, [slug]);

  // Initial load of limits and history
  useEffect(() => {
    fetchLimits();
    fetchHistory();
  }, [fetchLimits, fetchHistory]);

  // Auto-refresh history when a run completes
  useEffect(() => {
    if (!isRunning && lastRunResult) {
      fetchHistory();
    }
  }, [isRunning, lastRunResult, fetchHistory]);

  // Auto-scroll output container unless user scrolled up
  const handleScroll = () => {
    if (!outputContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = outputContainerRef.current;
    userScrolledUpRef.current = scrollHeight - (scrollTop + clientHeight) > 40;
  };

  useEffect(() => {
    if (!userScrolledUpRef.current && outputContainerRef.current) {
      outputContainerRef.current.scrollTop = outputContainerRef.current.scrollHeight;
    }
  }, [activeRunOutput]);

  // Virtualization: when output is massive (e.g. flood test with 20k lines),
  // window to the last 1500 lines so DOM never lags or crashes
  const displayedOutputLines = useMemo(() => {
    const raw = selectedHistoryRun ? selectedHistoryRun.output : activeRunOutput;
    if (!raw) return [];
    const allLines = raw.split('\n');
    if (allLines.length > 1500) {
      return allLines.slice(-1500);
    }
    return allLines;
  }, [selectedHistoryRun, activeRunOutput]);

  const canCancel = isRunning && (userRole === 'owner' || userRole === 'editor');

  // Format peak memory: real measurement if > 0, otherwise em dash '—'
  const formatMemory = (bytes?: number) => {
    if (!bytes || bytes <= 0) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${Math.round(mb)}MB`;
    const kb = bytes / 1024;
    return `${Math.round(kb)}KB`;
  };

  return (
    <>
      {/* Resizer bar */}
      <div
        onMouseDown={onResizeStart}
        style={{
          height: '4px',
          cursor: 'row-resize',
          flexShrink: 0,
          background: 'var(--color-border-subtle)',
          transition: 'background var(--duration-fast)',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-accent)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-border-subtle)')}
      />

      <div id="output-panel" style={{
        height: `${outputHeight}px`,
        flexShrink: 0,
        background: 'var(--color-bg-app)',
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid var(--color-border-subtle)',
        position: 'relative',
      }}>
        {/* Panel Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-1) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          background: 'var(--color-bg-surface)',
          flexShrink: 0,
        }}>
          {/* Left: Tab selection & Runner status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <button
              onClick={() => {
                setActiveTab('output');
                setSelectedHistoryRun(null);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: '4px 8px',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: activeTab === 'output' ? 'var(--color-bg-app)' : 'transparent',
                color: activeTab === 'output' ? 'var(--color-text)' : 'var(--color-text-muted)',
                fontWeight: activeTab === 'output' ? 600 : 400,
                fontSize: 'var(--text-xs)',
                cursor: 'pointer',
              }}
            >
              <Terminal size={13} />
              Output
            </button>

            <button
              onClick={() => {
                setActiveTab('history');
                fetchHistory();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: '4px 8px',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: activeTab === 'history' ? 'var(--color-bg-app)' : 'transparent',
                color: activeTab === 'history' ? 'var(--color-text)' : 'var(--color-text-muted)',
                fontWeight: activeTab === 'history' ? 600 : 400,
                fontSize: 'var(--text-xs)',
                cursor: 'pointer',
              }}
            >
              <History size={13} />
              History {history.length > 0 && `(${history.length})`}
            </button>

            {/* Exit status badge */}
            {lastRunResult && !isRunning && (
              <span className={`badge badge-status ${lastRunResult.exitCode === 0 ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: '11px', marginLeft: 'var(--space-2)' }}>
                {lastRunResult.cancelled ? 'Cancelled' : lastRunResult.timedOut ? 'Timed Out' : lastRunResult.exitCode === 0 ? 'Exit 0' : `Exit ${lastRunResult.exitCode}`}
              </span>
            )}

            {/* Live runner notice */}
            {isRunning && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                marginLeft: 'var(--space-2)',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                background: 'rgba(234, 179, 8, 0.15)',
                color: '#eab308',
                fontSize: 'var(--text-xs)',
              }}>
                <span className="spinner" style={{ width: '10px', height: '10px' }} />
                <span><strong>{runningUser || 'Someone'}</strong> is running...</span>
              </div>
            )}

            {/* Cancel button if running */}
            {canCancel && (
              <button
                onClick={onCancelRun}
                className="btn btn-danger btn-sm"
                style={{
                  height: '22px',
                  padding: '0 8px',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Square size={10} fill="currentColor" />
                Cancel
              </button>
            )}

            {/* If viewing a historical run, show back button */}
            {selectedHistoryRun && (
              <button
                onClick={() => setSelectedHistoryRun(null)}
                className="btn btn-ghost btn-sm"
                style={{
                  height: '22px',
                  padding: '0 6px',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '2px',
                }}
              >
                <ChevronLeft size={12} />
                Back to live
              </button>
            )}
          </div>

          {/* Right: Limits popover trigger & Close button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowLimits(!showLimits)}
                className="btn-icon"
                title="Sandbox Limits & Configuration"
                style={{
                  width: '24px',
                  height: '24px',
                  color: showLimits ? 'var(--color-accent)' : 'var(--color-text-muted)',
                }}
              >
                <Info size={14} />
              </button>

              {/* Limits Popover */}
              {showLimits && (
                <div style={{
                  position: 'absolute',
                  right: 0,
                  bottom: '30px',
                  width: '260px',
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-lg)',
                  padding: 'var(--space-3)',
                  zIndex: 100,
                  fontSize: 'var(--text-xs)',
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 'var(--space-2)',
                    fontWeight: 600,
                    color: 'var(--color-text)',
                  }}>
                    <span>Sandbox Limits</span>
                    <button
                      onClick={() => setShowLimits(false)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }}
                    >
                      <X size={12} />
                    </button>
                  </div>

                  {limitsLoading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-2)' }}>
                      <span className="spinner" style={{ width: '14px', height: '14px' }} />
                    </div>
                  ) : limits ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>Wall Time:</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{limits.timeout_seconds}s</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>Memory Limit:</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{limits.memory_limit}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>CPU Limit:</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{limits.cpu_limit} CPU</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>PIDs Limit:</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{limits.pids_limit}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>Max Code Size:</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{limits.max_code_size_kb}KB</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>Max Output:</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{limits.max_output_size_kb}KB</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>Network:</span>
                        <span style={{ color: 'var(--color-danger)', fontWeight: 500 }}>blocked ({limits.network})</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>Root FS:</span>
                        <span>Read-only</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>Sandbox User:</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{limits.user}</span>
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--color-text-muted)' }}>Failed to load limits</div>
                  )}
                </div>
              )}
            </div>

            <button onClick={onClose} className="btn-icon" style={{ width: '24px', height: '24px' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Panel Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {activeTab === 'output' ? (
            <div
              ref={outputContainerRef}
              onScroll={handleScroll}
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 'var(--space-3)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-sm)',
                lineHeight: 1.6,
                background: 'var(--color-bg-app)',
              }}
            >
              {isEmailBlocked && (
                <div
                  id="email-blocked-banner"
                  style={{
                    marginBottom: 'var(--space-3)',
                    padding: 'var(--space-4)',
                    background: 'rgba(234, 179, 8, 0.08)',
                    border: '1px solid rgba(234, 179, 8, 0.3)',
                    borderRadius: 'var(--radius-md)',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
                    <AlertTriangle size={18} color="#eab308" style={{ flexShrink: 0, marginTop: '2px' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: 'var(--color-text)', fontSize: 'var(--text-sm)' }}>
                        Email verification required to run code
                      </div>
                      <p style={{ margin: '4px 0 10px 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                        Email verification isn't available for this account yet. Sign in with Google to unlock Run instantly.
                      </p>
                      <a
                        id="google-unlock-run-btn"
                        href={`/api/auth/google?return_to=${encodeURIComponent(`/w/${slug}`)}`}
                        className="btn btn-primary btn-sm"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          textDecoration: 'none',
                          fontSize: 'var(--text-xs)',
                          padding: '6px 12px',
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                        </svg>
                        Sign in with Google to unlock Run
                      </a>
                    </div>
                  </div>
                </div>
              )}
              {displayedOutputLines.length > 0 ? (
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {displayedOutputLines.map((line, idx) => (
                    <div key={idx}>
                      <AnsiRenderer text={line} />
                    </div>
                  ))}
                </div>
              ) : isRunning ? (
                <div style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                  Streaming output...
                </div>
              ) : (
                <div style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-xs)' }}>
                  <p>Press <span className="kbd">Run</span> to execute code in the hardened Docker sandbox.</p>
                  <p style={{ marginTop: 'var(--space-2)', opacity: 0.7 }}>
                    Isolation: network none, read-only rootfs, 128MB RAM, 0.5 CPU, 64 PIDs, cap-drop ALL.
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* History Tab */
            <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-2)' }}>
              {historyLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <span className="spinner" style={{ width: '16px', height: '16px' }} />
                </div>
              ) : history.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-4)', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                  No execution history yet. Runs in this workspace will be recorded here.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px' }}>Status</th>
                      <th style={{ padding: '6px 8px' }}>File</th>
                      <th style={{ padding: '6px 8px' }}>Duration</th>
                      <th style={{ padding: '6px 8px' }}>User</th>
                      <th style={{ padding: '6px 8px' }}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(item => (
                      <tr
                        key={item.id}
                        onClick={() => {
                          setSelectedHistoryRun(item);
                          setActiveTab('output');
                        }}
                        style={{
                          borderBottom: '1px solid var(--color-border-subtle)',
                          cursor: 'pointer',
                          transition: 'background var(--duration-fast)',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-bg-surface)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ padding: '6px 8px' }}>
                          <span className={`badge badge-status ${item.exit_code === 0 ? 'badge-success' : 'badge-danger'}`}>
                            {item.cancelled ? 'Cancelled' : item.timed_out ? 'Timed Out' : `Exit ${item.exit_code}`}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>{item.file_path}</td>
                        <td style={{ padding: '6px 8px' }}>{item.duration_ms}ms</td>
                        <td style={{ padding: '6px 8px' }}>{item.username}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--color-text-muted)' }}>
                          {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Footer (Real Measurements) */}
        {/* Format: "exit 0 · 412ms · 18MB · network: blocked" */}
        <div style={{
          padding: '4px var(--space-3)',
          borderTop: '1px solid var(--color-border-subtle)',
          background: 'var(--color-bg-surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '11px',
          color: 'var(--color-text-muted)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {selectedHistoryRun ? (
              <span>
                exit {selectedHistoryRun.exit_code} · {selectedHistoryRun.duration_ms}ms · network: blocked (historical run {selectedHistoryRun.run_id})
              </span>
            ) : lastRunResult ? (
              <span>
                exit {lastRunResult.exitCode} · {lastRunResult.durationMs}ms · network: blocked
                {lastRunResult.truncated && ' · (output truncated)'}
                {lastRunResult.timedOut && ' · (timed out)'}
                {lastRunResult.cancelled && ' · (cancelled)'}
              </span>
            ) : (
              <span>sandbox ready · network: blocked</span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span style={{ opacity: 0.6 }}>SyncSpace Sandbox</span>
          </div>
        </div>
      </div>
    </>
  );
};
