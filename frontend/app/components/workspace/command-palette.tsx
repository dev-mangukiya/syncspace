'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, File, Play, Users, Moon, Sun, Terminal, Bot,
  Columns2, ArrowRight, Hash, Command,
} from 'lucide-react';

export interface PaletteAction {
  id: string;
  label: string;
  category: 'file' | 'command' | 'navigation';
  icon?: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
  /** For file actions — the file path for fuzzy matching */
  filePath?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

function fuzzyMatch(query: string, text: string): { match: boolean; score: number; indices: number[] } {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let prevIdx = -1;

  for (let ti = 0; ti < lowerText.length && qi < lowerQuery.length; ti++) {
    if (lowerText[ti] === lowerQuery[qi]) {
      indices.push(ti);
      // Consecutive matches score higher
      if (prevIdx === ti - 1) score += 10;
      // Start-of-word matches score higher
      if (ti === 0 || lowerText[ti - 1] === '/' || lowerText[ti - 1] === '.' || lowerText[ti - 1] === ' ') score += 5;
      score += 1;
      prevIdx = ti;
      qi++;
    }
  }

  return { match: qi === lowerQuery.length, score, indices };
}

function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
  const indexSet = new Set(indices);
  return (
    <span>
      {text.split('').map((char, i) => (
        indexSet.has(i) ? (
          <span key={i} style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{char}</span>
        ) : (
          <span key={i}>{char}</span>
        )
      ))}
    </span>
  );
}

export function CommandPalette({ isOpen, onClose, actions }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Focus input after a tick (modal animation)
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Determine if the query is a "go to line" command
  const isGoToLine = query.startsWith(':');
  const goToLineNum = isGoToLine ? parseInt(query.slice(1), 10) : NaN;

  // Filter and score actions
  const filtered = useMemo(() => {
    if (isGoToLine) return []; // No action list for :lineNum
    if (!query.trim()) return actions;
    const results: (PaletteAction & { score: number; indices: number[] })[] = [];
    for (const action of actions) {
      const matchTarget = action.filePath || action.label;
      const { match, score, indices } = fuzzyMatch(query, matchTarget);
      if (match) {
        results.push({ ...action, score, indices });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }, [query, actions, isGoToLine]);

  // Group actions by category
  const grouped: Record<string, (typeof filtered)> = useMemo(() => {
    const groups: Record<string, (typeof filtered)> = {};
    for (const item of filtered) {
      const cat = item.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }
    return groups;
  }, [filtered]);

  // Display items in the exact visual sequence rendered in the DOM
  const displayItems = useMemo(() => {
    const items: (PaletteAction & { score?: number; indices?: number[] })[] = [];
    for (const groupList of Object.values(grouped)) {
      items.push(...groupList);
    }
    return items;
  }, [grouped]);

  // Reset selectedIndex whenever query changes (new search -> select top match)
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Clamp selected index to available display items
  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, displayItems.length - 1)));
  }, [displayItems.length]);

  // Scroll selected into view
  useEffect(() => {
    if (listRef.current) {
      const items = listRef.current.querySelectorAll('[data-palette-item]');
      items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((action: PaletteAction) => {
    if (action.id === 'cmd-goto-line') {
      setQuery(':');
      inputRef.current?.focus();
      return;
    }
    action.onSelect();
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, displayItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (isGoToLine && !isNaN(goToLineNum)) {
          // Emit a custom "go to line" — the page will handle this
          onClose();
          // Dispatch a custom event the page can listen for
          window.dispatchEvent(new CustomEvent('palette:goto-line', { detail: goToLineNum }));
        } else if (displayItems[selectedIndex]) {
          handleSelect(displayItems[selectedIndex] as PaletteAction);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'Tab':
        e.preventDefault();
        // Tab cycles through results
        setSelectedIndex(prev => (prev + 1) % Math.max(1, displayItems.length));
        break;
    }
  }, [displayItems, selectedIndex, handleSelect, onClose, isGoToLine, goToLineNum]);

  if (!isOpen) return null;

  const categoryLabels: Record<string, string> = {
    file: 'Files',
    command: 'Commands',
    navigation: 'Navigation',
  };

  let globalIndex = -1;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          zIndex: 9998, backdropFilter: 'blur(2px)',
        }}
      />
      {/* Palette */}
      <div style={{
        position: 'fixed', top: '15%', left: '50%', transform: 'translateX(-50%)',
        width: '520px', maxHeight: '420px',
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.05)',
        display: 'flex', flexDirection: 'column',
        zIndex: 9999, overflow: 'hidden',
        animation: 'palette-in 0.15s ease-out',
      }}>
        {/* Search input */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}>
          <Search size={16} style={{ color: 'var(--color-text-faint)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a file name, command, or :line to jump..."
            style={{
              flex: 1, border: 'none', outline: 'none',
              background: 'transparent', color: 'var(--color-text)',
              fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)',
              padding: 'var(--space-1) 0',
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd style={{
            padding: '1px 6px', fontSize: '10px',
            borderRadius: '4px', border: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-faint)', background: 'var(--color-bg-raised)',
          }}>ESC</kbd>
        </div>

        {/* Go to line mode */}
        {isGoToLine && (
          <div
            onClick={() => {
              if (!isNaN(goToLineNum)) {
                onClose();
                window.dispatchEvent(new CustomEvent('palette:goto-line', { detail: goToLineNum }));
              }
            }}
            style={{
              padding: 'var(--space-3)',
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)',
              cursor: !isNaN(goToLineNum) ? 'pointer' : 'default',
            }}
          >
            <Hash size={16} style={{ color: 'var(--color-accent)' }} />
            <span>
              {!isNaN(goToLineNum)
                ? `Go to line ${goToLineNum} — press Enter or click here`
                : 'Type a line number after :'
              }
            </span>
          </div>
        )}

        {/* Results */}
        {!isGoToLine && (
          <div ref={listRef} style={{ overflow: 'auto', maxHeight: '340px' }}>
            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                <div style={{
                  padding: 'var(--space-1) var(--space-3)',
                  fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: '0.5px', color: 'var(--color-text-faint)',
                  background: 'var(--color-bg-raised)',
                }}>
                  {categoryLabels[cat] || cat}
                </div>
                {items.map((item) => {
                  globalIndex++;
                  const isSelected = globalIndex === selectedIndex;
                  const idx = globalIndex;
                  return (
                    <div
                      key={item.id}
                      data-palette-item
                      onClick={() => handleSelect(item)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: 'var(--space-2) var(--space-3)',
                        cursor: 'pointer',
                        background: isSelected ? 'var(--color-accent-subtle)' : 'transparent',
                        transition: 'background 0.1s ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <span style={{ color: isSelected ? 'var(--color-accent)' : 'var(--color-text-faint)', flexShrink: 0 }}>
                          {item.icon || <ArrowRight size={14} />}
                        </span>
                        <span style={{
                          fontSize: 'var(--text-sm)', color: 'var(--color-text)',
                          fontFamily: item.category === 'file' ? 'var(--font-mono)' : 'inherit',
                        }}>
                          {'indices' in item
                            ? <HighlightedText text={item.filePath || item.label} indices={(item as { indices: number[] }).indices} />
                            : (item.filePath || item.label)
                          }
                        </span>
                      </div>
                      {item.shortcut && (
                        <kbd style={{
                          padding: '1px 6px', fontSize: '10px',
                          borderRadius: '4px', border: '1px solid var(--color-border-subtle)',
                          color: 'var(--color-text-faint)', background: 'var(--color-bg-raised)',
                        }}>
                          {item.shortcut}
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {filtered.length === 0 && query.trim() && (
              <div style={{
                padding: 'var(--space-4)', textAlign: 'center',
                color: 'var(--color-text-faint)', fontSize: 'var(--text-sm)',
              }}>
                No matches for "{query}"
              </div>
            )}
          </div>
        )}
      </div>

      {/* Animation keyframes */}
      <style>{`
        @keyframes palette-in {
          from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </>
  );
}
