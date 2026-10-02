'use client';

import React from 'react';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}

const sizes = {
  sm: { icon: 20, text: 14, gap: 6 },
  md: { icon: 24, text: 17, gap: 8 },
  lg: { icon: 32, text: 22, gap: 10 },
};

/**
 * SyncSpace Logo — Option A: "Converging Brackets"
 * Two angled brackets that overlap to form an S-like interlock.
 * Monochrome, no gradients, scales cleanly at 16-48px.
 */
export function Logo({ size = 'md', showWordmark = true, className }: LogoProps) {
  const s = sizes[size];

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${s.gap}px`,
      }}
    >
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Left bracket — upper half */}
        <path
          d="M8 6L16 16L8 26"
          stroke="var(--color-text)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Right bracket — offset to interlock */}
        <path
          d="M24 6L16 16L24 26"
          stroke="var(--color-text)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontSize: `${s.text}px`,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--color-text)',
            lineHeight: 1,
          }}
        >
          SyncSpace
        </span>
      )}
    </span>
  );
}

/**
 * Logo Option B: "Merge Node"
 * Two lines converging into a single point — represents sync/merge.
 */
export function LogoMerge({ size = 'md', showWordmark = true, className }: LogoProps) {
  const s = sizes[size];

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${s.gap}px`,
      }}
    >
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Top branch */}
        <path
          d="M6 8L16 16L26 8"
          stroke="var(--color-text)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Bottom branch — converging */}
        <path
          d="M6 24L16 16L26 24"
          stroke="var(--color-accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Center dot */}
        <circle cx="16" cy="16" r="2.5" fill="var(--color-accent)" />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontSize: `${s.text}px`,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--color-text)',
            lineHeight: 1,
          }}
        >
          SyncSpace
        </span>
      )}
    </span>
  );
}

/**
 * Logo Option C: "Cursor Pair"
 * Two text cursors at different positions — represents two people editing.
 */
export function LogoCursors({ size = 'md', showWordmark = true, className }: LogoProps) {
  const s = sizes[size];

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${s.gap}px`,
      }}
    >
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* First cursor */}
        <rect x="9" y="6" width="2.5" height="20" rx="1.25" fill="var(--color-text)" />
        {/* Second cursor — offset and tinted */}
        <rect x="20" y="10" width="2.5" height="16" rx="1.25" fill="var(--color-accent)" />
        {/* Baseline / code lines */}
        <line x1="5" y1="28" x2="27" y2="28" stroke="var(--color-border)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontSize: `${s.text}px`,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--color-text)',
            lineHeight: 1,
          }}
        >
          SyncSpace
        </span>
      )}
    </span>
  );
}
