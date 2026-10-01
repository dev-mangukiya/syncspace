'use client';

import React from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, Theme } from '@/app/lib/hooks/use-theme';

interface ThemeToggleProps {
  /** 'cycle' rotates dark→light→system; 'toggle' flips dark↔light */
  mode?: 'cycle' | 'toggle';
}

const themeOrder: Theme[] = ['dark', 'light', 'system'];

export function ThemeToggle({ mode = 'cycle' }: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();

  if (mode === 'toggle') {
    return (
      <button
        className="btn-icon"
        onClick={toggleTheme}
        aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
        title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    );
  }

  const handleCycle = () => {
    const idx = themeOrder.indexOf(theme);
    const next = themeOrder[(idx + 1) % themeOrder.length];
    setTheme(next);
  };

  const icon = theme === 'system'
    ? <Monitor size={16} />
    : resolvedTheme === 'dark'
      ? <Moon size={16} />
      : <Sun size={16} />;

  const label = theme === 'system'
    ? 'System theme'
    : `${resolvedTheme.charAt(0).toUpperCase() + resolvedTheme.slice(1)} theme`;

  return (
    <button
      className="btn-icon"
      onClick={handleCycle}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}
