'use client';

import React, { useCallback, useRef, useState } from 'react';
import {
  X, File, Columns2,
} from 'lucide-react';
import type { Tab } from '@/app/lib/use-tab-manager';

function getFileIconColor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const colors: Record<string, string> = {
    js: '#C9A06C', jsx: '#C9A06C', ts: '#7BAFCC', tsx: '#7BAFCC',
    py: '#5B9E78', go: '#7BAFCC', rb: '#C25B56', json: '#C29A4B',
    md: '#9AA3AE', html: '#C9835F', css: '#B79AC9', yml: '#9AA3AE',
    yaml: '#9AA3AE', txt: '#7A848F', rs: '#C9835F',
  };
  return colors[ext || ''] || 'var(--color-text-faint)';
}

interface TabBarProps {
  tabs: Tab[];
  activeTabPath: string | null;
  splitTabPath: string | null;
  splitViewActive: boolean;
  onSwitch: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onToggleSplit: () => void;
}

export function TabBar({
  tabs, activeTabPath, splitTabPath, splitViewActive,
  onSwitch, onClose, onReorder, onToggleSplit,
}: TabBarProps) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragRef.current = idx;
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIdx(idx);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIdx: number) => {
    e.preventDefault();
    const fromIdx = dragRef.current;
    if (fromIdx !== null && fromIdx !== toIdx) {
      onReorder(fromIdx, toIdx);
    }
    setDragIdx(null);
    setDropIdx(null);
    dragRef.current = null;
  }, [onReorder]);

  const handleDragEnd = useCallback(() => {
    setDragIdx(null);
    setDropIdx(null);
    dragRef.current = null;
  }, []);

  if (tabs.length === 0) return null;

  return (
    <div style={{
      height: '34px', display: 'flex', alignItems: 'stretch',
      borderBottom: '1px solid var(--color-border-subtle)',
      background: 'var(--color-bg-app)', flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Scrollable tab container */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'stretch',
        overflow: 'auto', scrollbarWidth: 'none',
      }}>
        {tabs.map((tab, idx) => {
          const isActive = tab.path === activeTabPath;
          const isSplit = tab.path === splitTabPath && splitViewActive;
          const isDragging = dragIdx === idx;
          const isDropTarget = dropIdx === idx && dragIdx !== idx;

          return (
            <div
              key={tab.path}
              draggable
              onDragStart={e => handleDragStart(e, idx)}
              onDragOver={e => handleDragOver(e, idx)}
              onDrop={e => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              onClick={() => onSwitch(tab.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '0 12px', height: '100%',
                fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)',
                color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                background: isActive ? 'var(--color-bg-surface)' : 'transparent',
                borderRight: '1px solid var(--color-border-subtle)',
                borderBottom: isActive ? '2px solid var(--color-accent)' : isSplit ? '2px solid var(--color-success)' : '2px solid transparent',
                opacity: isDragging ? 0.4 : 1,
                boxShadow: isDropTarget ? 'inset 2px 0 0 var(--color-accent)' : 'none',
                transition: 'background 0.15s ease, border-bottom 0.15s ease',
                flexShrink: 0,
                userSelect: 'none',
              }}
              title={tab.path}
            >
              <File size={12} style={{ color: getFileIconColor(tab.path), flexShrink: 0 }} />
              <span>{tab.path}</span>
              {/* Dirty indicator */}
              {tab.dirty && (
                <span style={{
                  width: '6px', height: '6px', borderRadius: '50%',
                  background: 'var(--color-warning)',
                  flexShrink: 0,
                }} title="Unsaved changes" />
              )}
              {/* Close button */}
              <button
                onClick={e => { e.stopPropagation(); onClose(tab.path); }}
                className="btn-icon"
                style={{
                  width: '16px', height: '16px', padding: 0,
                  opacity: isActive ? 0.7 : 0,
                  transition: 'opacity 0.15s ease',
                }}
                aria-label={`Close ${tab.path}`}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Split view toggle */}
      <button
        onClick={onToggleSplit}
        className="btn-icon"
        style={{
          width: '32px', height: '100%', borderRadius: 0,
          borderLeft: '1px solid var(--color-border-subtle)',
          color: splitViewActive ? 'var(--color-accent)' : 'var(--color-text-faint)',
          background: splitViewActive ? 'var(--color-accent-subtle)' : 'transparent',
        }}
        title={splitViewActive ? 'Close split view' : 'Split view'}
        disabled={tabs.length < 2}
      >
        <Columns2 size={14} />
      </button>
    </div>
  );
}
