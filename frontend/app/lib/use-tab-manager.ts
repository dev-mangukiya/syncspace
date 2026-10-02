'use client';

import { useCallback, useRef, useState } from 'react';
import { SyncProvider } from '@/app/lib/sync-provider';
import { FileEntry, workspaceAPI } from '@/app/lib/api';

export interface Tab {
  path: string;
  file: FileEntry;
  dirty: boolean;         // Unsaved changes
}

export interface TabState {
  openTabs: Tab[];
  activeTabPath: string | null;
  splitTabPath: string | null;    // Second pane in split view
  splitViewActive: boolean;
}

interface UseTabManagerOpts {
  slug: string;
  userId: string;
  username: string;
  colorSlot: number;
}

/**
 * useTabManager: manages multiple open file tabs, each with its own SyncProvider.
 * 
 * Key invariant: each open tab has exactly ONE SyncProvider + Y.Doc. Opening a tab
 * creates the provider, closing it destroys it. Switching tabs doesn't destroy providers —
 * they stay connected so remote edits keep arriving even when the tab isn't visible.
 */
export function useTabManager(opts: UseTabManagerOpts) {
  const [tabState, setTabState] = useState<TabState>({
    openTabs: [],
    activeTabPath: null,
    splitTabPath: null,
    splitViewActive: false,
  });

  // Provider map: path → SyncProvider (persists across tab switches)
  const providersRef = useRef<Map<string, SyncProvider>>(new Map());
  // Save timers: path → timeout (debounced persist per tab)
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Open a file in a new tab (or focus existing tab) ──
  const openTab = useCallback((file: FileEntry) => {
    setTabState(prev => {
      // Already open? Just focus it
      if (prev.openTabs.find(t => t.path === file.path)) {
        return { ...prev, activeTabPath: file.path };
      }
      // Add new tab
      const newTab: Tab = { path: file.path, file, dirty: false };
      return {
        ...prev,
        openTabs: [...prev.openTabs, newTab],
        activeTabPath: file.path,
      };
    });

    // Create SyncProvider if not already exists
    if (!providersRef.current.has(file.path)) {
      const provider = new SyncProvider({
        slug: opts.slug,
        filePath: file.path,
        userId: opts.userId,
        username: opts.username,
        colorSlot: opts.colorSlot,
      });

      provider.onSeedGrant = () => {
        const ytext = provider.getText();
        if (ytext.length === 0 && file.content && file.content.length > 0) {
          provider.seedContent(file.content);
        }
      };

      provider.onSynced = () => {
        // If Y.Doc is empty and this client holds the seed grant, seed from DB content
        if (provider.canSeed()) {
          const ytext = provider.getText();
          if (ytext.length === 0 && file.content && file.content.length > 0) {
            provider.seedContent(file.content);
          }
        }
      };

      // Track dirty state via Y.Doc updates
      provider.doc.on('update', () => {
        setTabState(prev => ({
          ...prev,
          openTabs: prev.openTabs.map(t =>
            t.path === file.path ? { ...t, dirty: true } : t
          ),
        }));

        // Debounced persist — 3 seconds of inactivity
        const existing = saveTimersRef.current.get(file.path);
        if (existing) clearTimeout(existing);
        saveTimersRef.current.set(file.path, setTimeout(() => {
          const text = provider.getText().toString();
          workspaceAPI.updateFile(opts.slug, file.path, text)
            .then(() => {
              setTabState(prev => ({
                ...prev,
                openTabs: prev.openTabs.map(t =>
                  t.path === file.path ? { ...t, dirty: false } : t
                ),
              }));
            })
            .catch(err => console.error('[Tab] Persist failed:', err));
        }, 3000));
      });

      providersRef.current.set(file.path, provider);
    }
  }, [opts.slug, opts.userId, opts.username, opts.colorSlot]);

  // ── Close a tab ──
  const closeTab = useCallback((path: string) => {
    // Destroy the provider for this tab
    const provider = providersRef.current.get(path);
    if (provider) {
      // Persist before destroying
      const content = provider.getText().toString();
      workspaceAPI.updateFile(opts.slug, path, content).catch(() => {});
      provider.destroy();
      providersRef.current.delete(path);
    }

    // Clear any pending save timer
    const timer = saveTimersRef.current.get(path);
    if (timer) {
      clearTimeout(timer);
      saveTimersRef.current.delete(path);
    }

    setTabState(prev => {
      const remaining = prev.openTabs.filter(t => t.path !== path);
      let newActive = prev.activeTabPath;
      let newSplit = prev.splitTabPath;

      // If we closed the active tab, activate the nearest neighbor
      if (prev.activeTabPath === path) {
        const closedIdx = prev.openTabs.findIndex(t => t.path === path);
        if (remaining.length > 0) {
          newActive = remaining[Math.min(closedIdx, remaining.length - 1)].path;
        } else {
          newActive = null;
        }
      }

      // If we closed the split tab, turn off split view
      if (prev.splitTabPath === path) {
        newSplit = null;
      }

      return {
        ...prev,
        openTabs: remaining,
        activeTabPath: newActive,
        splitTabPath: newSplit,
        splitViewActive: prev.splitViewActive && newSplit !== null,
      };
    });
  }, [opts.slug]);

  // ── Switch active tab (without creating/destroying providers) ──
  const switchTab = useCallback((path: string) => {
    setTabState(prev => ({ ...prev, activeTabPath: path }));
  }, []);

  // ── Reorder tabs (drag-and-drop) ──
  const reorderTabs = useCallback((fromIdx: number, toIdx: number) => {
    setTabState(prev => {
      const tabs = [...prev.openTabs];
      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);
      return { ...prev, openTabs: tabs };
    });
  }, []);

  // ── Split view toggle ──
  const toggleSplitView = useCallback(() => {
    setTabState(prev => {
      if (prev.splitViewActive) {
        return { ...prev, splitViewActive: false, splitTabPath: null };
      }
      // Open split with the second tab if available, else same as active
      const otherTab = prev.openTabs.find(t => t.path !== prev.activeTabPath);
      return {
        ...prev,
        splitViewActive: true,
        splitTabPath: otherTab?.path || prev.activeTabPath,
      };
    });
  }, []);

  // ── Set split pane to a specific tab ──
  const setSplitTab = useCallback((path: string) => {
    setTabState(prev => ({ ...prev, splitTabPath: path }));
  }, []);

  // ── Get provider for a specific tab ──
  const getProvider = useCallback((path: string): SyncProvider | null => {
    return providersRef.current.get(path) || null;
  }, []);

  // ── Get all active provider count (for cleanup proof) ──
  const getProviderCount = useCallback((): number => {
    return providersRef.current.size;
  }, []);

  // ── Force save a specific tab ──
  const saveTab = useCallback(async (path: string) => {
    const provider = providersRef.current.get(path);
    if (provider) {
      const content = provider.getText().toString();
      await workspaceAPI.updateFile(opts.slug, path, content);
      setTabState(prev => ({
        ...prev,
        openTabs: prev.openTabs.map(t =>
          t.path === path ? { ...t, dirty: false } : t
        ),
      }));
    }
  }, [opts.slug]);

  // ── Destroy all providers (unmount cleanup) ──
  const destroyAll = useCallback(() => {
    for (const [path, provider] of providersRef.current) {
      const content = provider.getText().toString();
      workspaceAPI.updateFile(opts.slug, path, content).catch(() => {});
      provider.destroy();
    }
    providersRef.current.clear();
    for (const timer of saveTimersRef.current.values()) {
      clearTimeout(timer);
    }
    saveTimersRef.current.clear();
  }, [opts.slug]);

  // ── Handle file tree events (update tab references if file renamed/deleted) ──
  const handleFileTreeEvent = useCallback((event: { type: string; path: string; new_path?: string }) => {
    if (event.type === 'file_deleted') {
      // If the deleted file has an open tab, close it
      if (providersRef.current.has(event.path)) {
        closeTab(event.path);
      }
    } else if (event.type === 'file_renamed' && event.new_path) {
      // If the renamed file has an open tab, we need to close old + re-open new
      // For now, just close the old tab — the user can re-open
      if (providersRef.current.has(event.path)) {
        closeTab(event.path);
      }
    }
  }, [closeTab]);

  return {
    tabState,
    openTab,
    closeTab,
    switchTab,
    reorderTabs,
    toggleSplitView,
    setSplitTab,
    getProvider,
    getProviderCount,
    saveTab,
    destroyAll,
    handleFileTreeEvent,
    providersRef,
  };
}
