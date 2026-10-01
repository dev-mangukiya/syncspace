'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

function getResolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window === 'undefined') return 'dark';
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');

  // Read stored preference on mount
  useEffect(() => {
    const stored = localStorage.getItem('syncspace_theme') as Theme | null;
    if (stored === 'light' || stored === 'dark') {
      setThemeState(stored);
      setResolvedTheme(stored);
    } else {
      setThemeState('system');
      setResolvedTheme(getResolvedTheme('system'));
    }
  }, []);

  // Listen for system preference changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      if (theme === 'system') {
        const resolved = mq.matches ? 'light' : 'dark';
        setResolvedTheme(resolved);
        document.documentElement.setAttribute('data-theme', resolved);
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    const resolved = getResolvedTheme(newTheme);
    setResolvedTheme(resolved);
    document.documentElement.setAttribute('data-theme', resolved);

    if (newTheme === 'system') {
      localStorage.removeItem('syncspace_theme');
    } else {
      localStorage.setItem('syncspace_theme', newTheme);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }, [resolvedTheme, setTheme]);

  return { theme, resolvedTheme, setTheme, toggleTheme };
}
