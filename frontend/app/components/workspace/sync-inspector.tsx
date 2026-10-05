'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Activity, Users, Database, Radio, ArrowUp, ArrowDown, X, Minimize2, Maximize2 } from 'lucide-react';
import type { SyncProvider } from '@/app/lib/sync-provider';

interface InspectorState {
  connected: boolean;
  synced: boolean;
  peerCount: number;
  peers: Array<{ clientId: number; name: string; color: string; isLocal: boolean }>;
  docSizeBytes: number;
  textLength: number;
  clientId: number;
  syncMsgSent: number;
  syncMsgReceived: number;
  awarenessMsgSent: number;
  awarenessMsgReceived: number;
  totalSent: number;
  totalReceived: number;
}

interface SyncInspectorProps {
  provider: SyncProvider | null;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SyncInspector({ provider, onClose }: SyncInspectorProps) {
  const [state, setState] = useState<InspectorState | null>(null);
  const [minimized, setMinimized] = useState(false);
  const prevTotalRef = useRef({ sent: 0, received: 0 });
  const [flashSent, setFlashSent] = useState(false);
  const [flashReceived, setFlashReceived] = useState(false);

  const refresh = useCallback(() => {
    if (!provider) return;
    const s = provider.getInspectorState();
    setState(s);

    // Flash animation on counter change
    if (s.totalSent > prevTotalRef.current.sent) {
      setFlashSent(true);
      setTimeout(() => setFlashSent(false), 300);
    }
    if (s.totalReceived > prevTotalRef.current.received) {
      setFlashReceived(true);
      setTimeout(() => setFlashReceived(false), 300);
    }
    prevTotalRef.current = { sent: s.totalSent, received: s.totalReceived };
  }, [provider]);

  useEffect(() => {
    if (!provider) return;
    // Wire up the inspector callback
    provider.onInspectorUpdate = refresh;
    // Also poll every second for awareness changes (peer joins/leaves don't always fire onInspectorUpdate)
    const interval = setInterval(refresh, 1000);
    // Initial state
    refresh();
    return () => {
      provider.onInspectorUpdate = null;
      clearInterval(interval);
    };
  }, [provider, refresh]);

  if (!state) return null;

  if (minimized) {
    return (
      <div
        id="sync-inspector"
        style={{
          position: 'fixed', bottom: '32px', right: '16px', zIndex: 1000,
          background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)',
          borderRadius: '8px', padding: '6px 12px',
          display: 'flex', alignItems: 'center', gap: '8px',
          fontSize: '11px', color: 'var(--color-text-secondary)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        <Activity size={12} style={{ color: state.connected ? '#10B981' : '#EF4444' }} />
        <span>{state.peerCount}p</span>
        <span style={{ opacity: 0.5 }}>|</span>
        <ArrowUp size={10} /> <span>{state.totalSent}</span>
        <ArrowDown size={10} /> <span>{state.totalReceived}</span>
        <button
          onClick={() => setMinimized(false)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0 }}
        >
          <Maximize2 size={12} />
        </button>
      </div>
    );
  }

  return (
    <div
      id="sync-inspector"
      style={{
        position: 'fixed', bottom: '32px', right: '16px', zIndex: 1000,
        width: '320px',
        background: 'var(--color-surface-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: '12px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: '11px',
        color: 'var(--color-text-secondary)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Activity size={13} style={{ color: '#6B5B95' }} />
          <span style={{ fontWeight: 700, fontSize: '12px', color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>
            Sync Inspector
          </span>
          <span style={{
            background: state.connected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: state.connected ? '#10B981' : '#EF4444',
            fontSize: '9px', fontWeight: 700, padding: '1px 6px',
            borderRadius: '4px', textTransform: 'uppercase',
          }}>
            {state.connected ? (state.synced ? 'synced' : 'connecting') : 'disconnected'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={() => setMinimized(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '2px' }}
            title="Minimize"
          >
            <Minimize2 size={13} />
          </button>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '2px' }}
            title="Close inspector"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

        {/* Peers */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '6px', color: 'var(--color-text-muted)', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <Users size={11} />
            Peers ({state.peerCount})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {state.peers.map(p => (
              <div key={p.clientId} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 8px', borderRadius: '4px', background: 'var(--color-surface)' }}>
                <div style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: p.color, flexShrink: 0,
                  boxShadow: `0 0 6px ${p.color}44`,
                }} />
                <span style={{ fontWeight: p.isLocal ? 700 : 400, color: p.isLocal ? 'var(--color-text-primary)' : 'inherit' }}>
                  {p.name}{p.isLocal ? ' (you)' : ''}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '9px', opacity: 0.5 }}>
                  #{p.clientId.toString().slice(-4)}
                </span>
              </div>
            ))}
            {state.peers.length === 0 && (
              <span style={{ opacity: 0.5, fontStyle: 'italic' }}>No peers connected</span>
            )}
          </div>
        </section>

        {/* Document */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '6px', color: 'var(--color-text-muted)', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <Database size={11} />
            Y.Doc State
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
            <div style={{ padding: '4px 8px', borderRadius: '4px', background: 'var(--color-surface)' }}>
              <div style={{ fontSize: '9px', opacity: 0.6 }}>Binary Size</div>
              <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--color-text-primary)' }}>{formatBytes(state.docSizeBytes)}</div>
            </div>
            <div style={{ padding: '4px 8px', borderRadius: '4px', background: 'var(--color-surface)' }}>
              <div style={{ fontSize: '9px', opacity: 0.6 }}>Text Length</div>
              <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--color-text-primary)' }}>{state.textLength.toLocaleString()} chars</div>
            </div>
          </div>
        </section>

        {/* Messages */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '6px', color: 'var(--color-text-muted)', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <Radio size={11} />
            WS Messages
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
            <div style={{
              padding: '4px 8px', borderRadius: '4px',
              background: flashSent ? 'rgba(16, 185, 129, 0.12)' : 'var(--color-surface)',
              transition: 'background 0.3s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '9px', opacity: 0.6 }}>
                <ArrowUp size={9} /> Sent
              </div>
              <div id="inspector-sent-total" style={{ fontWeight: 700, fontSize: '16px', color: '#10B981' }}>
                {state.totalSent}
              </div>
              <div style={{ fontSize: '9px', opacity: 0.5 }}>
                sync: {state.syncMsgSent} · awareness: {state.awarenessMsgSent}
              </div>
            </div>
            <div style={{
              padding: '4px 8px', borderRadius: '4px',
              background: flashReceived ? 'rgba(99, 102, 241, 0.12)' : 'var(--color-surface)',
              transition: 'background 0.3s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '9px', opacity: 0.6 }}>
                <ArrowDown size={9} /> Received
              </div>
              <div id="inspector-received-total" style={{ fontWeight: 700, fontSize: '16px', color: '#6366F1' }}>
                {state.totalReceived}
              </div>
              <div style={{ fontSize: '9px', opacity: 0.5 }}>
                sync: {state.syncMsgReceived} · awareness: {state.awarenessMsgReceived}
              </div>
            </div>
          </div>
        </section>

        {/* Client ID */}
        <div style={{ fontSize: '9px', opacity: 0.4, textAlign: 'center' }}>
          Client ID: {state.clientId}
        </div>
      </div>
    </div>
  );
}
