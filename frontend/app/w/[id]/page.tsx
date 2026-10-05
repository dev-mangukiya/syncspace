'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  ArrowLeft, Play, Terminal, Bot, X, Check,
  File, Send, Wrench,
  Lightbulb, Zap, TestTube2, Loader2, Plus, Trash2, Eraser,
  Users, Command, Columns2, Folder, Hash, Moon, Sun, MessageSquare,
  Wifi, WifiOff, Activity, History,
} from 'lucide-react';
import { useAuthStore } from '@/app/lib/store';
import { workspaceAPI, FileEntry, Workspace } from '@/app/lib/api';
import { Logo } from '@/app/components/ui/logo';
import { ThemeToggle } from '@/app/components/ui/theme-toggle';
import { syncspaceDark, syncspaceLight } from '@/app/lib/monaco-themes';
import { useTheme } from '@/app/lib/hooks/use-theme';
import { SyncProvider } from '@/app/lib/sync-provider';
import { createYMonacoBinding } from '@/app/lib/y-monaco-lazy';
import { useTabManager } from '@/app/lib/use-tab-manager';
import { TabBar } from '@/app/components/workspace/tab-bar';
import { CommandPalette, PaletteAction } from '@/app/components/workspace/command-palette';
import { ShareModal } from '@/app/components/workspace/share-modal';
import { WorkspaceChat } from '@/app/components/workspace/workspace-chat';
import { OutputPanel } from '@/app/components/workspace/output-panel';
import { SyncInspector } from '@/app/components/workspace/sync-inspector';
import { VersionHistory } from '@/app/components/workspace/version-history';
import axios from 'axios';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const WS_URL = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'http://localhost:8080';

// ── Helpers ──────────────────────────────────────────────

function getLanguageLabel(path: string): string {
  const lang = getLanguage(path);
  const labels: Record<string, string> = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    ruby: 'Ruby',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    json: 'JSON',
    markdown: 'Markdown',
    html: 'HTML',
    css: 'CSS',
    yaml: 'YAML',
    xml: 'XML',
    sql: 'SQL',
    shell: 'Shell',
    plaintext: 'Plain Text',
  };
  return labels[lang] || lang.charAt(0).toUpperCase() + lang.slice(1);
}

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    json: 'json', md: 'markdown', html: 'html', css: 'css',
    yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
    sh: 'shell', bash: 'shell', txt: 'plaintext',
  };
  return map[ext || ''] || 'plaintext';
}

function getFileIconColor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const colors: Record<string, string> = {
    js: '#C9A06C', jsx: '#C9A06C', ts: '#7BAFCC', tsx: '#7BAFCC',
    py: '#5B9E78', go: '#7BAFCC', rb: '#C25B56', json: '#C29A4B',
    md: '#9AA3AE', html: '#C9835F', css: '#B79AC9', yml: '#9AA3AE',
    yaml: '#9AA3AE', txt: '#7A848F',
  };
  return colors[ext || ''] || 'var(--color-text-faint)';
}

interface ExecResult {
  id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  output_capped?: boolean;
  language: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  codeBlock?: string;
  tokensUsed?: number;
  model?: string;
  timestamp: Date;
}

// ── Main Component ───────────────────────────────────────

export default function WorkspacePage() {
  const router = useRouter();
  const params = useParams();
  // Route is /w/[id] where id = opaque short_id (32-char hex)
  const slug = params.id as string;
  const { isLoading: authLoading, isAuthenticated, checkAuth, user } = useAuthStore();
  const { resolvedTheme, toggleTheme } = useTheme();
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);

  // ── Multi-tab state ─────────────────────────────────────
  // Tab manager handles multiple open files, each with its own SyncProvider.
  // Per-tab Y.Doc + WS connection persists across tab switches.
  const [colorSlot, setColorSlot] = useState(0);
  const tabManager = useTabManager({
    slug,
    userId: user?.id || '',
    username: user?.username || '',
    colorSlot,
  });

  // ── CRDT sync state for the ACTIVE tab only ─────────────
  // These refs manage the Monaco ↔ Y.Doc binding for whichever tab is visible.
  const editorRef = useRef<unknown>(null);
  const monacoRef = useRef<unknown>(null);
interface ActivePeer {
  clientID: number;
  name: string;
  color: string;
  isBot?: boolean;
}

  const yMonacoBindingRef = useRef<unknown>(null);
  const [syncStatus, setSyncStatus] = useState<'disconnected' | 'connecting' | 'synced'>('disconnected');
  const [peerCount, setPeerCount] = useState(0);
  const [activePeers, setActivePeers] = useState<ActivePeer[]>([]);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  // activeFile is derived from tab state for backward compatibility with AI/exec
  const activeFile = tabManager.tabState.openTabs.find(t => t.path === tabManager.tabState.activeTabPath)?.file || null;
  const [editorContent, setEditorContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Simulate-offline state (dev/demo toggle)
  const [simulatedOffline, setSimulatedOffline] = useState(false);
  const [offlineEditCount, setOfflineEditCount] = useState(0);
  const [mergeToast, setMergeToast] = useState<{ edits: number; timestamp: number } | null>(null);

  // Inspector panel state (dev/demo-only)
  const [showInspector, setShowInspector] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  // Execution state (Phase D)
  const [isRunning, setIsRunning] = useState(false);
  const [runningUser, setRunningUser] = useState<string | null>(null);
  const [activeRunOutput, setActiveRunOutput] = useState('');
  const [lastRunResult, setLastRunResult] = useState<{
    exitCode: number;
    durationMs: number;
    peakMemoryBytes?: number;
    truncated?: boolean;
    timedOut?: boolean;
    cancelled?: boolean;
  } | null>(null);
  const executing = isRunning;
  const [showOutput, setShowOutput] = useState(false);
  const [outputHeight, setOutputHeight] = useState(220);

  // AI Chat state
  const [showAI, setShowAI] = useState(false);
  const [aiInfo, setAiInfo] = useState<{ configured: boolean; available: boolean; model: string; status_msg?: string } | null>(null);
  const [aiMessages, setAIMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: 'SyncSpace AI ready. Select a file and ask me to **fix**, **explain**, or **optimize** your code.',
      timestamp: new Date(),
    }
  ]);
  const [aiInput, setAIInput] = useState('');
  const [aiLoading, setAILoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Workspace Team Chat state
  const [showChat, setShowChat] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);

  useEffect(() => {
    const handleChatEvent = (e: CustomEvent) => {
      const msg = e.detail;
      if (!msg) return;
      if (!showChat && msg.user_id !== user?.id) {
        setUnreadChatCount((prev) => prev + 1);
      }
    };
    window.addEventListener('syncspace:chat', handleChatEvent as EventListener);
    return () => {
      window.removeEventListener('syncspace:chat', handleChatEvent as EventListener);
    };
  }, [showChat, user?.id]);

  // Resizable panel
  const resizing = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // File management state
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [creatingFile, setCreatingFile] = useState(false);

  // ── Auth & Data Loading ────────────────────────────────

  useEffect(() => { checkAuth(); }, [checkAuth]);
  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push('/auth/login');
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (!isAuthenticated || !slug) return;
    const load = async () => {
      setError('');
      try {
        const [wsRes, filesRes] = await Promise.all([
          workspaceAPI.get(slug),
          workspaceAPI.listFiles(slug),
        ]);
        setWorkspace(wsRes.data);
        setFiles(filesRes.data);
        if (filesRes.data.length > 0) {
          const firstFile = filesRes.data[0];
          tabManager.openTab(firstFile);
          setEditorContent(firstFile.content);
        }
        // Fetch members to determine this user's colorSlot (by join order)
        try {
          const membersRes = await axios.get(`/api/workspaces/${slug}/members`, { withCredentials: true });
          if (Array.isArray(membersRes.data)) {
            const me = membersRes.data.find((m: { user_id: string }) => m.user_id === user?.id);
            if (me && typeof me.color_slot === 'number') {
              setColorSlot(me.color_slot);
            }
          }
        } catch { /* non-fatal — default to slot 0 */ }

        // Fetch AI status & active model
        try {
          const aiRes = await axios.get('/api/ai/info', { withCredentials: true });
          setAiInfo(aiRes.data);
          if (!aiRes.data.configured) {
            setAIMessages([{
              role: 'assistant',
              content: "AI isn't configured on this server.\n\nSet the `GROQ_API_KEY` environment variable to enable SyncSpace AI.",
              timestamp: new Date(),
            }]);
          } else if (!aiRes.data.available) {
            setAIMessages([{
              role: 'assistant',
              content: `AI is currently unavailable: ${aiRes.data.status_msg || 'Model not found'}.`,
              timestamp: new Date(),
            }]);
          }
        } catch { /* non-fatal */ }
      } catch {
        setError('Failed to load workspace');
        setTimeout(() => setError(''), 4000);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isAuthenticated, slug, user]);

  // ── Tab-aware Monaco binding ────────────────────────────
  // When active tab changes, rebind Monaco to that tab's SyncProvider.
  // The provider itself persists — only the Monaco ↔ Y.Doc binding changes.

  const bindYMonaco = useCallback((provider: SyncProvider) => {
    if (!editorRef.current || !monacoRef.current) return;
    // Destroy previous binding
    if (yMonacoBindingRef.current) {
      (yMonacoBindingRef.current as { destroy: () => void }).destroy();
      yMonacoBindingRef.current = null;
    }
    const editor = editorRef.current as import('monaco-editor').editor.IStandaloneCodeEditor;
    const model = editor.getModel();
    if (!model) return;
    const binding = createYMonacoBinding(
      monacoRef.current,
      provider.getText(),
      model,
      new Set([editor]),
      provider.awareness,
    );
    yMonacoBindingRef.current = binding;
  }, []);

  // Rebind Monaco when active tab changes
  useEffect(() => {
    const activePath = tabManager.tabState.activeTabPath;
    if (!activePath) {
      setSyncStatus('disconnected');
      setPeerCount(0);
      setActivePeers([]);
      return;
    }

    const provider = tabManager.getProvider(activePath);
    if (!provider) return;

    // Update sync status from this tab's provider
    provider.onStatus = ({ connected }) => {
      setSyncStatus(connected ? 'connecting' : 'disconnected');
    };
    provider.onSynced = () => {
      setSyncStatus('synced');
      const ytext = provider.getText();
      const tab = tabManager.tabState.openTabs.find(t => t.path === activePath);
      if (provider.canSeed() && ytext.length === 0 && tab?.file.content && tab.file.content.length > 0) {
        provider.seedContent(tab.file.content);
      }
      setEditorContent(ytext.toString());
    };

    // Track awareness for peer count & bot badge
    const awarenessHandler = () => {
      const states = provider.awareness.getStates();
      setPeerCount(Math.max(0, states.size - 1));
      const peers: ActivePeer[] = [];
      states.forEach((state, clientID) => {
        if (clientID !== provider.doc.clientID && state.user) {
          peers.push({
            clientID,
            name: state.user.name || 'Anonymous',
            color: state.user.color || '#9AA3AE',
            isBot: !!state.user.isBot,
          });
        }
      });
      setActivePeers(peers);
    };
    provider.awareness.on('change', awarenessHandler);
    awarenessHandler(); // Run once immediately

    // Track content for AI/exec
    const updateHandler = () => {
      setEditorContent(provider.getText().toString());
    };
    provider.doc.on('update', updateHandler);

    // File tree events (handled by tab manager for tab lifecycle)
    provider.onFileTreeEvent = (event) => {
      tabManager.handleFileTreeEvent(event);
      switch (event.type) {
        case 'file_created':
          workspaceAPI.listFiles(slug).then(res => setFiles(res.data)).catch(() => {});
          break;
        case 'file_deleted':
          setFiles(prev => prev.filter(f => f.path !== event.path));
          break;
        case 'file_renamed':
          workspaceAPI.listFiles(slug).then(res => setFiles(res.data)).catch(() => {});
          break;
      }
    };

    // Simulate-offline callbacks
    provider.onSimulateOfflineChange = (info) => {
      setSimulatedOffline(info.offline);
      setOfflineEditCount(info.editCount);
    };
    provider.onMergeComplete = (info) => {
      setMergeToast({ edits: info.offlineEdits, timestamp: info.mergedAt });
      // Auto-dismiss after 5 seconds
      setTimeout(() => setMergeToast(null), 5000);
    };

    // Bind to Monaco if editor already mounted
    if (editorRef.current && monacoRef.current) {
      bindYMonaco(provider);
    }

    // Set initial sync status
    if (provider.isSynced()) {
      setSyncStatus('synced');
      setEditorContent(provider.getText().toString());
    } else {
      setSyncStatus('connecting');
    }

    return () => {
      provider.awareness.off('change', awarenessHandler);
      provider.doc.off('update', updateHandler);
      if (yMonacoBindingRef.current) {
        (yMonacoBindingRef.current as { destroy: () => void }).destroy();
        yMonacoBindingRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabManager.tabState.activeTabPath, slug, bindYMonaco]);

  // Persist content helper (for keyboard shortcut / exec)
  const persistContent = useCallback(async (filePath: string, content: string) => {
    try {
      await workspaceAPI.updateFile(slug, filePath, content);
    } catch (err) {
      console.error('[Persist] Failed to save:', err);
    }
  }, [slug]);

  // Cleanup on unmount — destroy all tab providers
  useEffect(() => {
    return () => {
      tabManager.destroyAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush Y.Doc content on hard tab close via navigator.sendBeacon.
  useEffect(() => {
    const handleUnload = () => {
      if (!activeFile) return;
      const provider = tabManager.getProvider(activeFile.path);
      let content = '';
      if (provider) {
        content = provider.getText().toString();
      }
      if (!content && editorRef.current) {
        const editor = editorRef.current as { getModel?: () => { getValue?: () => string } | null };
        content = editor.getModel?.()?.getValue?.() || '';
      }
      if (!content) return;

      const url = `/api/workspaces/${slug}/beacon-persist`;
      const body = JSON.stringify({ path: activeFile.path, content });
      const csrfCookie = document.cookie.match(/(^| )syncspace_csrf=([^;]+)/);
      const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie[2]) : '';
      try {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          credentials: 'include', body, keepalive: true,
        });
      } catch { /* best-effort */ }
    };

    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, [activeFile, slug, tabManager]);

  // ── File selection from sidebar ────────────────────────
  const selectFile = (file: FileEntry) => {
    tabManager.openTab(file);
    setEditorContent(file.content);
  };

  // ── File create / delete ───────────────────────────────

  const createNewFile = useCallback(async () => {
    const path = newFilePath.trim();
    if (!path || creatingFile) return;
    setCreatingFile(true);
    try {
      const res = await workspaceAPI.createFile(slug, path);
      setFiles(prev => [...prev, res.data].sort((a, b) => a.path.localeCompare(b.path)));
      tabManager.openTab(res.data);
      setEditorContent(res.data.content);
      setShowNewFile(false);
      setNewFilePath('');
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error || err.message : 'Failed to create file';
      setError(msg);
      setTimeout(() => setError(''), 3000);
    } finally {
      setCreatingFile(false);
    }
  }, [newFilePath, creatingFile, slug, tabManager]);

  const deleteExistingFile = useCallback(async (file: FileEntry) => {
    if (!confirm(`Delete ${file.path}?`)) return;
    try {
      await workspaceAPI.deleteFile(slug, file.path);
      setFiles(prev => prev.filter(f => f.id !== file.id));
      // Close the tab if it was open
      tabManager.closeTab(file.path);
    } catch {
      setError('Failed to delete file');
      setTimeout(() => setError(''), 3000);
    }
  }, [slug, tabManager]);

  // ── Code execution (Phase D) ───────────────────────────

  useEffect(() => {
    const handleRunEvent = (e: Event) => {
      const customEvent = e as CustomEvent;
      const detail = customEvent.detail;
      if (!detail) return;

      if (detail.type === 'run_started') {
        setIsRunning(true);
        setRunningUser(detail.user || 'Someone');
        setActiveRunOutput('');
        setShowOutput(true);
      } else if (detail.type === 'run_output') {
        if (detail.chunk) {
          setActiveRunOutput(prev => prev + detail.chunk);
        }
      } else if (detail.type === 'run_finished') {
        setIsRunning(false);
        setRunningUser(null);
        setLastRunResult({
          exitCode: detail.exitCode,
          durationMs: detail.durationMs,
          peakMemoryBytes: detail.peakMemoryBytes,
          truncated: detail.truncated,
          timedOut: detail.timedOut,
          cancelled: detail.cancelled,
        });
      }
    };

    window.addEventListener('syncspace:run', handleRunEvent);
    return () => {
      window.removeEventListener('syncspace:run', handleRunEvent);
    };
  }, []);

  const runCode = useCallback(async () => {
    if (!activeFile || isRunning) return;
    if (workspace?.role === 'viewer') {
      setError('Viewers are not permitted to run code');
      setTimeout(() => setError(''), 3000);
      return;
    }

    // Save current Y.Doc content before executing
    const provider = activeFile ? tabManager.getProvider(activeFile.path) : null;
    const currentContent = provider
      ? provider.getText().toString()
      : editorContent;
    if (provider) {
      await persistContent(activeFile.path, currentContent);
    }

    setIsRunning(true);
    setRunningUser(user?.username || 'You');
    setActiveRunOutput('');
    setShowOutput(true);

    try {
      const lang = getLanguage(activeFile.path);
      const csrfCookie = document.cookie.match(/(^| )syncspace_csrf=([^;]+)/);
      const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie[2]) : '';

      const res = await axios.post(`/api/workspaces/${slug}/run`, {
        file_path: activeFile.path,
        code: currentContent,
        language: lang,
      }, {
        withCredentials: true,
        headers: { 'X-CSRF-Token': csrfToken },
        timeout: 40000,
      });

      if (res.data) {
        setLastRunResult({
          exitCode: res.data.exit_code,
          durationMs: res.data.duration_ms,
          peakMemoryBytes: res.data.peak_memory_bytes,
          truncated: res.data.truncated,
          timedOut: res.data.timed_out,
          cancelled: res.data.cancelled,
        });
        if (res.data.output) {
          setActiveRunOutput(res.data.output);
        }
      }
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const errorMsg = err.response?.data?.error || err.message;
        setError(errorMsg);
        setTimeout(() => setError(''), 4000);
        setActiveRunOutput(prev => prev ? prev + `\n[Error: ${errorMsg}]\n` : `[Error: ${errorMsg}]\n`);
        setLastRunResult({
          exitCode: -1,
          durationMs: 0,
        });
      }
    } finally {
      setIsRunning(false);
      setRunningUser(null);
    }
  }, [activeFile, editorContent, isRunning, persistContent, slug, tabManager, user, workspace?.role]);

  const cancelRun = useCallback(async () => {
    try {
      const csrfCookie = document.cookie.match(/(^| )syncspace_csrf=([^;]+)/);
      const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie[2]) : '';
      await axios.post(`/api/workspaces/${slug}/run/cancel`, {}, {
        withCredentials: true,
        headers: { 'X-CSRF-Token': csrfToken },
      });
    } catch (err) {
      console.error('Failed to cancel run:', err);
    }
  }, [slug]);

  // ── AI Chat ────────────────────────────────────────────

  const sendAIMessage = useCallback(async (message: string) => {
    if (!message.trim() || aiLoading) return;
    const userMsg: ChatMessage = { role: 'user', content: message, timestamp: new Date() };
    setAIMessages(prev => [...prev, userMsg]);
    setAIInput('');
    setAILoading(true);

    try {
      // Build conversation history (last 6 turns, exclude system messages)
      const history = [...aiMessages, userMsg]
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-6)
        .map(m => ({ role: m.role, content: m.content }));

      // Read CSRF token from cookie for the mutation
      const csrfCookie = document.cookie.match(/(^| )syncspace_csrf=([^;]+)/);
      const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie[2]) : '';

      const res = await axios.post(`/api/ai/chat`, {
        message,
        code: editorContent || '',
        language: activeFile ? getLanguage(activeFile.path) : '',
        file_path: activeFile?.path || '',
        history,
      }, {
        withCredentials: true,
        headers: { 'X-CSRF-Token': csrfToken },
        timeout: 35000, // 35s client timeout (server has 30s)
      });

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: res.data.reply,
        codeBlock: res.data.code_block || undefined,
        tokensUsed: res.data.tokens_used,
        model: res.data.model,
        timestamp: new Date(),
      };
      setAIMessages(prev => [...prev, assistantMsg]);
    } catch (err: unknown) {
      const errorMessage = axios.isAxiosError(err)
        ? err.response?.data?.error || (err.code === 'ECONNABORTED' ? 'Request timed out' : err.message)
        : 'AI request failed';
      setAIMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${errorMessage}`,
        timestamp: new Date(),
      }]);
    } finally {
      setAILoading(false);
    }
  }, [activeFile, editorContent, aiLoading, aiMessages]);

  const applyCode = useCallback((code: string) => {
    // Apply AI-suggested code via Y.Doc (CRDT-safe)
    const provider = activeFile ? tabManager.getProvider(activeFile.path) : null;
    if (provider) {
      const ytext = provider.getText();
      provider.doc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, code);
      }, 'ai-apply');
    }
    setEditorContent(code);
  }, [activeFile, tabManager]);

  const clearChat = useCallback(() => {
    setAIMessages([{
      role: 'assistant',
      content: 'Chat cleared. Select a file and ask me anything.',
      timestamp: new Date(),
    }]);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages, aiLoading]);

  // ── Keyboard shortcuts ─────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        // Force-persist the current Y.Doc content
        if (activeFile) {
          const provider = tabManager.getProvider(activeFile.path);
          if (provider) {
            persistContent(activeFile.path, provider.getText().toString());
          }
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runCode(); }
      // ⌘K: Command palette toggle
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        setShowCommandPalette(prev => !prev);
      }
      // ⌘I: AI panel toggle (⌘K reserved for command palette)
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); setShowAI(prev => !prev); }
      // Alt+W: close active tab (⌘W is browser-owned and can't be reliably intercepted)
      if (e.altKey && e.key === 'w') {
        e.preventDefault();
        if (tabManager.tabState.activeTabPath) {
          tabManager.closeTab(tabManager.tabState.activeTabPath);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [activeFile, persistContent, runCode, tabManager]);

  // ── Command Palette: Go to Line listener ────────────────
  useEffect(() => {
    const handleGoToLine = (e: Event) => {
      const line = (e as CustomEvent<number>).detail;
      if (typeof line === 'number' && !isNaN(line) && editorRef.current) {
        const editor = editorRef.current as import('monaco-editor').editor.IStandaloneCodeEditor;
        if (editor?.revealLineInCenter && editor?.setPosition) {
          editor.revealLineInCenter(line);
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.focus();
          setCursorPos({ line, col: 1 });
        }
      }
    };
    window.addEventListener('palette:goto-line', handleGoToLine);
    return () => window.removeEventListener('palette:goto-line', handleGoToLine);
  }, []);

  // ── Output panel resize ────────────────────────────────

  const onResizeStart = (e: React.MouseEvent) => {
    resizing.current = true;
    startY.current = e.clientY;
    startHeight.current = outputHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = startY.current - ev.clientY;
      setOutputHeight(Math.max(100, Math.min(500, startHeight.current + delta)));
    };
    const onUp = () => {
      resizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ── Monaco theme registration ──────────────────────────

  const handleEditorMount = useCallback((editor: unknown, monaco: { editor: { defineTheme: (name: string, data: unknown) => void; setTheme: (name: string) => void } }) => {
    monaco.editor.defineTheme('syncspace-dark', syncspaceDark);
    monaco.editor.defineTheme('syncspace-light', syncspaceLight);
    monaco.editor.setTheme(resolvedTheme === 'dark' ? 'syncspace-dark' : 'syncspace-light');

    // Store refs for y-monaco binding
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Track cursor position
    const monacoEditor = editor as import('monaco-editor').editor.IStandaloneCodeEditor;
    if (monacoEditor?.onDidChangeCursorPosition) {
      const pos = monacoEditor.getPosition();
      if (pos) {
        setCursorPos({ line: pos.lineNumber, col: pos.column });
      }
      monacoEditor.onDidChangeCursorPosition((e) => {
        setCursorPos({ line: e.position.lineNumber, col: e.position.column });
      });
    }

    // Register ⌘K action within Monaco editor
    const monacoAny = monaco as any;
    if (monacoEditor?.addAction && monacoAny?.KeyMod && monacoAny?.KeyCode) {
      monacoEditor.addAction({
        id: 'syncspace-command-palette',
        label: 'SyncSpace: Command Palette',
        keybindings: [monacoAny.KeyMod.CtrlCmd | monacoAny.KeyCode.KeyK],
        run: () => {
          setShowCommandPalette(true);
        },
      });
    }

    // If SyncProvider is already connected, bind now
    const provider = tabManager.tabState.activeTabPath ? tabManager.getProvider(tabManager.tabState.activeTabPath) : null;
    if (provider) {
      bindYMonaco(provider);
    }
  }, [resolvedTheme, bindYMonaco, tabManager]);

  // Update Monaco theme when system theme changes
  useEffect(() => {
    // Monaco might not be loaded yet; this is a best-effort approach
    try {
      const monaco = (window as unknown as { monaco?: { editor: { setTheme: (name: string) => void } } }).monaco;
      if (monaco) {
        monaco.editor.setTheme(resolvedTheme === 'dark' ? 'syncspace-dark' : 'syncspace-light');
      }
    } catch {
      // Monaco not available yet, skip
    }
  }, [resolvedTheme]);

  // ── Command Palette Actions ─────────────────────────────
  const paletteActions: PaletteAction[] = useMemo(() => {
    const actions: PaletteAction[] = [];

    // 1. Files in workspace
    for (const f of files) {
      const fileName = f.path.split('/').pop() || f.path;
      actions.push({
        id: `file-${f.path}`,
        label: fileName,
        filePath: f.path,
        category: 'file',
        icon: <File size={14} style={{ color: getFileIconColor(f.path) }} />,
        onSelect: () => {
          tabManager.openTab(f);
        },
      });
    }

    // 2. Navigation
    actions.push({
      id: 'cmd-goto-line',
      label: 'Go to Line... (:line)',
      category: 'navigation',
      icon: <Hash size={14} />,
      shortcut: ':line',
      onSelect: () => {},
    });

    // 3. Commands
    actions.push({
      id: 'cmd-run',
      label: 'Run Code',
      category: 'command',
      icon: <Play size={14} />,
      shortcut: '⌘Enter',
      onSelect: () => {
        runCode();
      },
    });

    actions.push({
      id: 'cmd-share',
      label: 'Share Workspace & Manage Members',
      category: 'command',
      icon: <Users size={14} />,
      onSelect: () => {
        setShowShareModal(true);
      },
    });

    actions.push({
      id: 'cmd-toggle-sidebar',
      label: showSidebar ? 'Hide Sidebar (File Explorer)' : 'Show Sidebar (File Explorer)',
      category: 'command',
      icon: <Folder size={14} />,
      onSelect: () => {
        setShowSidebar(prev => !prev);
      },
    });

    actions.push({
      id: 'cmd-toggle-output',
      label: showOutput ? 'Hide Output Panel' : 'Show Output Panel',
      category: 'command',
      icon: <Terminal size={14} />,
      onSelect: () => {
        setShowOutput(prev => !prev);
      },
    });

    actions.push({
      id: 'cmd-toggle-ai',
      label: showAI ? 'Hide AI Assistant' : 'Show AI Assistant',
      category: 'command',
      icon: <Bot size={14} />,
      shortcut: '⌘I',
      onSelect: () => {
        setShowAI(prev => !prev);
      },
    });

    actions.push({
      id: 'cmd-toggle-chat',
      label: showChat ? 'Hide Workspace Chat' : 'Show Workspace Chat',
      category: 'command',
      icon: <MessageSquare size={14} />,
      onSelect: () => {
        setShowChat(prev => {
          if (!prev) setUnreadChatCount(0);
          return !prev;
        });
      },
    });

    actions.push({
      id: 'cmd-toggle-split',
      label: tabManager.tabState.splitViewActive ? 'Close Split View' : 'Split Editor Right',
      category: 'command',
      icon: <Columns2 size={14} />,
      onSelect: () => {
        tabManager.toggleSplitView();
      },
    });

    actions.push({
      id: 'cmd-toggle-theme',
      label: `Switch to ${resolvedTheme === 'dark' ? 'Light' : 'Dark'} Mode`,
      category: 'command',
      icon: resolvedTheme === 'dark' ? <Sun size={14} /> : <Moon size={14} />,
      onSelect: () => {
        toggleTheme();
      },
    });

    return actions;
  }, [files, runCode, showSidebar, showOutput, showAI, showChat, tabManager, resolvedTheme, toggleTheme]);

  // ── Loading / Error states ─────────────────────────────

  if (authLoading || loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg-app)' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="spinner" style={{ width: '32px', height: '32px', margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-sm)' }}>Loading workspace...</p>
        </div>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg-app)' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-md)', marginBottom: 'var(--space-4)' }}>{error}</p>
          <Link href="/dashboard" className="btn btn-secondary">Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  const canRun = activeFile && ['python', 'javascript', 'typescript', 'go', 'ruby'].includes(getLanguage(activeFile.path)) && workspace?.role !== 'viewer';

  // ── Render ─────────────────────────────────────────────

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-app)' }}>
      {/* Error toast */}
      {error && workspace && <div className="error-toast">{error}</div>}
      {/* ─── Top Toolbar ─── */}
      <header style={{
        height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 var(--space-3)', borderBottom: '1px solid var(--color-border-subtle)',
        background: 'var(--color-bg-surface)', flexShrink: 0,
      }}>
        {/* Left: nav + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Link href="/dashboard" className="btn-icon" aria-label="Back to dashboard">
            <ArrowLeft size={16} />
          </Link>
          <div style={{ width: '1px', height: '16px', background: 'var(--color-border)' }} />
          <Logo size="sm" showWordmark={false} />
          <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-sm)' }}>/</span>
          <span style={{ color: 'var(--color-text)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
            {workspace?.name}
          </span>
        </div>

        {/* Center: Action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          {/* Sync status */}
          <span style={{
            fontSize: '11px', color: syncStatus === 'synced' ? 'var(--color-success)' : 'var(--color-text-faint)',
            display: 'flex', alignItems: 'center', gap: '4px',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: syncStatus === 'synced' ? 'var(--color-success)' : syncStatus === 'connecting' ? 'var(--color-warning)' : 'var(--color-danger)',
              display: 'inline-block',
            }} />
            {syncStatus === 'synced' ? 'Synced' : syncStatus === 'connecting' ? 'Connecting' : 'Offline'}
          </span>

          {/* Run */}
          <button
            onClick={runCode}
            disabled={!canRun || isRunning}
            className="btn btn-run btn-sm"
            title={workspace?.role === 'viewer' ? 'Viewers cannot run code' : undefined}
          >
            {isRunning ? <Loader2 size={14} className="spin-icon" /> : <Play size={14} />}
            {isRunning ? (runningUser ? `${runningUser} running...` : 'Running') : 'Run'}
            <span className="kbd" style={{ background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.2)' }}>
              Enter
            </span>
          </button>

          <div style={{ width: '1px', height: '16px', background: 'var(--color-border)' }} />

          {/* Output toggle */}
          <button
            onClick={() => setShowOutput(!showOutput)}
            className="btn btn-ghost btn-sm"
            style={{ background: showOutput ? 'var(--color-bg-hover)' : undefined }}
          >
            <Terminal size={14} /> Output
          </button>

          {/* AI toggle */}
          <button
            onClick={() => setShowAI(!showAI)}
            className="btn btn-ghost btn-sm"
            style={{
              background: showAI ? 'var(--color-accent-subtle)' : undefined,
              color: showAI ? 'var(--color-accent)' : undefined,
            }}
          >
            <Bot size={14} /> AI
            <span className="kbd">I</span>
          </button>

          {/* Workspace Chat toggle */}
          <button
            id="chat-toggle-btn"
            onClick={() => {
              setShowChat(!showChat);
              if (!showChat) setUnreadChatCount(0);
            }}
            className="btn btn-ghost btn-sm"
            style={{
              position: 'relative',
              background: showChat ? 'var(--color-accent-subtle)' : undefined,
              color: showChat ? 'var(--color-accent)' : undefined,
            }}
            title="Workspace Chat"
          >
            <MessageSquare size={14} /> Chat
            {unreadChatCount > 0 && !showChat && (
              <span
                id="chat-unread-badge"
                style={{
                  position: 'absolute',
                  top: '-4px',
                  right: '-4px',
                  background: 'var(--color-accent-solid)',
                  color: '#FFFFFF',
                  fontSize: '9px',
                  fontWeight: 700,
                  minWidth: '16px',
                  height: '16px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 3px',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                {unreadChatCount > 9 ? '9+' : unreadChatCount}
              </span>
            )}
          </button>

          {/* Version History toggle — available to ALL users (real feature, not dev-only) */}
          {activeFile && (
            <button
              id="version-history-toggle"
              onClick={() => setShowVersionHistory(!showVersionHistory)}
              className="btn btn-ghost btn-sm"
              style={{
                background: showVersionHistory ? 'var(--color-accent-subtle)' : undefined,
                color: showVersionHistory ? 'var(--color-accent)' : undefined,
              }}
              title="Version History — save, compare, and restore file snapshots"
            >
              <History size={14} /> History
            </button>
          )}

          <div style={{ width: '1px', height: '16px', background: 'var(--color-border)' }} />

          {/* Command Palette button */}
          <button
            onClick={() => setShowCommandPalette(true)}
            className="btn btn-ghost btn-sm"
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            title="Command Palette (⌘K)"
          >
            <Command size={13} />
            <span style={{ fontSize: '12px' }}>Search</span>
            <kbd className="kbd" style={{ fontSize: '9px', padding: '1px 4px' }}>⌘K</kbd>
          </button>
        </div>

        {/* Right: presence avatars + user + theme */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {/* Bot presence badge if demo bot is connected */}
          {activePeers.some(p => p.isBot) && (
            <div
              id="bot-presence-badge"
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '2px 8px', borderRadius: '12px',
                background: 'rgba(139, 92, 246, 0.15)',
                border: '1px solid #8B5CF6',
                color: '#A78BFA', fontSize: '11px', fontWeight: 600,
              }}
              title="Demo Bot (Ghost Collaborator) is active in this workspace"
            >
              <Bot size={13} style={{ color: '#8B5CF6' }} />
              <span>Demo Bot</span>
              <span style={{
                fontSize: '9px', padding: '1px 4px', borderRadius: '4px',
                background: '#8B5CF6', color: 'white', textTransform: 'uppercase',
                letterSpacing: '0.05em', fontWeight: 700,
              }}>
                BOT
              </span>
            </div>
          )}

          {/* Active human peer avatars */}
          {activePeers.filter(p => !p.isBot).map(p => (
            <div
              key={p.clientID}
              title={`${p.name} (online)`}
              style={{
                width: '22px', height: '22px', borderRadius: '50%',
                background: p.color, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: '10px', fontWeight: 600,
                color: 'white', border: '1px solid var(--color-bg-surface)',
              }}
            >
              {p.name.charAt(0).toUpperCase()}
            </div>
          ))}

          {/* Peer count */}
          {peerCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginRight: 'var(--space-1)' }}>
              <Users size={14} style={{ color: 'var(--color-text-faint)' }} />
              <span style={{ fontSize: '11px', color: 'var(--color-text-faint)' }}>
                {peerCount} peer{peerCount !== 1 ? 's' : ''}
              </span>
            </div>
          )}
          {/* Share button */}
          <button
            onClick={() => setShowShareModal(true)}
            className="btn btn-ghost btn-sm"
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            title="Share Workspace & Manage Members"
          >
            <Users size={14} />
            <span>Share</span>
          </button>
          <div style={{ width: '1px', height: '16px', background: 'var(--color-border)' }} />
          <ThemeToggle mode="toggle" />
          <div style={{
            width: '24px', height: '24px', borderRadius: '50%',
            background: 'var(--color-accent-solid)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '11px', fontWeight: 600, color: 'white',
          }}>
            {user?.username?.charAt(0).toUpperCase()}
          </div>
        </div>
      </header>

      {/* ─── Main Content ─── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* ─── File Sidebar ─── */}
        {showSidebar && (
          <aside style={{
            width: '200px', borderRight: '1px solid var(--color-border-subtle)',
            background: 'var(--color-bg-surface)', display: 'flex', flexDirection: 'column', flexShrink: 0,
          }}>
          <div style={{
            padding: 'var(--space-2) var(--space-3)',
            fontSize: 'var(--text-xs)', fontWeight: 500,
            color: 'var(--color-text-faint)', textTransform: 'uppercase',
            letterSpacing: '0.04em', borderBottom: '1px solid var(--color-border-subtle)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>Explorer</span>
            <button
              onClick={() => setShowNewFile(true)}
              className="btn-icon"
              style={{ width: '20px', height: '20px' }}
              aria-label="New file"
            >
              <Plus size={14} />
            </button>
          </div>

          {/* New file input */}
          {showNewFile && (
            <div style={{
              padding: 'var(--space-1) var(--space-2)',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex', gap: '4px',
            }}>
              <input
                autoFocus
                value={newFilePath}
                onChange={e => setNewFilePath(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') createNewFile();
                  if (e.key === 'Escape') { setShowNewFile(false); setNewFilePath(''); }
                }}
                placeholder="filename.ext"
                className="input"
                style={{ flex: 1, fontSize: '12px', padding: '4px 8px', height: '28px', fontFamily: 'var(--font-mono)' }}
              />
              <button onClick={createNewFile} disabled={!newFilePath.trim() || creatingFile} className="btn-icon" style={{ width: '24px', height: '24px' }}>
                {creatingFile ? <Loader2 size={12} className="spin-icon" /> : <Check size={14} />}
              </button>
              <button onClick={() => { setShowNewFile(false); setNewFilePath(''); }} className="btn-icon" style={{ width: '24px', height: '24px' }}>
                <X size={14} />
              </button>
            </div>
          )}

          <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-1) 0' }}>
            {files.map(file => (
              <div
                key={file.id}
                style={{
                  display: 'flex', alignItems: 'center',
                  background: activeFile?.path === file.path ? 'var(--color-bg-hover)' : 'transparent',
                  borderLeft: activeFile?.path === file.path
                    ? '2px solid var(--color-accent)' : '2px solid transparent',
                  transition: 'all var(--duration-fast) var(--easing)',
                }}
                className="file-row"
              >
                <button
                  onClick={() => selectFile(file)}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    padding: 'var(--space-1) var(--space-3)',
                    border: 'none', background: 'transparent',
                    color: activeFile?.path === file.path ? 'var(--color-text)' : 'var(--color-text-muted)',
                    fontSize: 'var(--text-sm)', cursor: 'pointer', textAlign: 'left',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <File size={14} style={{ color: getFileIconColor(file.path), flexShrink: 0 }} />
                  <span className="truncate">{file.path}</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteExistingFile(file); }}
                  className="btn-icon file-delete-btn"
                  style={{ width: '20px', height: '20px', marginRight: '4px', opacity: 0 }}
                  aria-label={`Delete ${file.path}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <div style={{
            padding: 'var(--space-2) var(--space-3)',
            borderTop: '1px solid var(--color-border-subtle)',
          }}>
            <span className="badge" style={{ fontSize: '11px' }}>
              {workspace?.language || workspace?.template}
            </span>
          </div>
        </aside>
      )}

        {/* ─── Editor + Output ─── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Multi-tab bar */}
          <TabBar
            tabs={tabManager.tabState.openTabs}
            activeTabPath={tabManager.tabState.activeTabPath}
            splitTabPath={tabManager.tabState.splitTabPath}
            splitViewActive={tabManager.tabState.splitViewActive}
            onSwitch={tabManager.switchTab}
            onClose={tabManager.closeTab}
            onReorder={tabManager.reorderTabs}
            onToggleSplit={tabManager.toggleSplitView}
          />

          {/* Editor panes — single or split */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {/* Primary editor pane */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {activeFile ? (
                <Editor
                  key={`editor-${activeFile.path}`}
                  height="100%"
                  language={getLanguage(activeFile.path)}
                  defaultValue={editorContent}
                  theme={resolvedTheme === 'dark' ? 'syncspace-dark' : 'syncspace-light'}
                  onMount={handleEditorMount}
                  options={{
                    fontSize: 14,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    fontLigatures: false,
                    lineNumbers: 'on',
                    minimap: { enabled: true, scale: 1 },
                    scrollBeyondLastLine: false,
                    padding: { top: 12, bottom: 12 },
                    renderLineHighlight: 'all',
                    smoothScrolling: true,
                    cursorBlinking: 'smooth',
                    cursorSmoothCaretAnimation: 'on',
                    bracketPairColorization: { enabled: true },
                    tabSize: 2,
                    automaticLayout: true,
                    suggest: { showMethods: true, showFunctions: true },
                  }}
                />
              ) : (
                <div className="empty-state" style={{ height: '100%' }}>
                  <File size={48} className="empty-state-icon" />
                  <p className="empty-state-title">Select a file to start editing</p>
                </div>
              )}
            </div>

            {/* Split pane (when active) */}
            {tabManager.tabState.splitViewActive && tabManager.tabState.splitTabPath && (() => {
              const splitFile = tabManager.tabState.openTabs.find(t => t.path === tabManager.tabState.splitTabPath);
              if (!splitFile) return null;
              return (
                <>
                  <div style={{
                    width: '3px', cursor: 'col-resize', flexShrink: 0,
                    background: 'var(--color-border-subtle)',
                  }} />
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <Editor
                      key={`split-${splitFile.path}`}
                      height="100%"
                      language={getLanguage(splitFile.path)}
                      defaultValue={splitFile.file.content}
                      theme={resolvedTheme === 'dark' ? 'syncspace-dark' : 'syncspace-light'}
                      onMount={(editor, monaco) => {
                        // Bind split editor to its own SyncProvider
                        monaco.editor.defineTheme('syncspace-dark', syncspaceDark);
                        monaco.editor.defineTheme('syncspace-light', syncspaceLight);
                        monaco.editor.setTheme(resolvedTheme === 'dark' ? 'syncspace-dark' : 'syncspace-light');
                        const provider = tabManager.getProvider(splitFile.path);
                        if (provider) {
                          const model = editor.getModel();
                          if (model) {
                            createYMonacoBinding(
                              monaco, provider.getText(), model,
                              new Set([editor]), provider.awareness,
                            );
                          }
                        }
                      }}
                      options={{
                        fontSize: 14,
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontLigatures: false,
                        lineNumbers: 'on',
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        padding: { top: 12, bottom: 12 },
                        renderLineHighlight: 'all',
                        smoothScrolling: true,
                        cursorBlinking: 'smooth',
                        cursorSmoothCaretAnimation: 'on',
                        bracketPairColorization: { enabled: true },
                        tabSize: 2,
                        automaticLayout: true,
                      }}
                    />
                  </div>
                </>
              );
            })()}
          </div>

          {/* ─── Output Panel ─── */}
          {showOutput && (
            <OutputPanel
              slug={slug}
              userRole={workspace?.role}
              outputHeight={outputHeight}
              onResizeStart={onResizeStart}
              onClose={() => setShowOutput(false)}
              isRunning={isRunning}
              runningUser={runningUser}
              onCancelRun={cancelRun}
              activeRunOutput={activeRunOutput}
              lastRunResult={lastRunResult}
            />
          )}
        </div>

        {/* ─── AI Chat Panel ─── */}
        {showAI && (
          <aside style={{
            width: '360px', borderLeft: '1px solid var(--color-border-subtle)',
            background: 'var(--color-bg-surface)', display: 'flex', flexDirection: 'column', flexShrink: 0,
          }}>
            {/* Header */}
            <div style={{
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Bot size={16} style={{ color: 'var(--color-accent)' }} />
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>SyncSpace AI</span>
                {aiInfo?.model && (
                  <span
                    id="ai-model-badge"
                    style={{
                      fontSize: '10px',
                      padding: '1px 6px',
                      borderRadius: 'var(--radius-control)',
                      background: 'var(--color-bg-hover)',
                      color: 'var(--color-text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {aiInfo.model.replace('openai/', '')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                <button
                  onClick={clearChat}
                  className="btn-icon"
                  style={{ width: '24px', height: '24px' }}
                  title="Clear chat"
                >
                  <Eraser size={14} />
                </button>
                <button onClick={() => setShowAI(false)} className="btn-icon" style={{ width: '24px', height: '24px' }}>
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Quick Actions */}
            <div style={{
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-border-subtle)',
              display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap',
            }}>
              {[
                { icon: <Wrench size={12} />, label: 'Fix', prompt: 'Find and fix all bugs in this code. Show the corrected version.' },
                { icon: <Lightbulb size={12} />, label: 'Explain', prompt: 'Explain what this code does, step by step.' },
                { icon: <Zap size={12} />, label: 'Optimize', prompt: 'Optimize this code for better performance and readability.' },
                { icon: <TestTube2 size={12} />, label: 'Tests', prompt: 'Write unit tests for this code.' },
              ].map(action => (
                <button
                  key={action.label}
                  onClick={() => sendAIMessage(action.prompt)}
                  disabled={aiLoading || !activeFile || (aiInfo !== null && (!aiInfo.configured || !aiInfo.available))}
                  className="btn btn-ghost btn-sm"
                  style={{ gap: '4px' }}
                >
                  {action.icon} {action.label}
                </button>
              ))}
            </div>

            {/* Chat Messages */}
            <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {aiMessages.map((msg, i) => (
                <div key={i} style={{
                  display: 'flex', flexDirection: 'column', gap: 'var(--space-1)',
                  alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}>
                  <div style={{
                    maxWidth: '95%', padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-panel)',
                    fontSize: 'var(--text-sm)', lineHeight: 1.55,
                    background: msg.role === 'user' ? 'var(--color-accent-solid)' : 'var(--color-bg-raised)',
                    color: msg.role === 'user' ? 'white' : 'var(--color-text)',
                    whiteSpace: 'normal', wordBreak: 'break-word',
                  }}>
                    <MessageContent content={msg.content} />
                  </div>
                  {msg.role === 'assistant' && (msg.codeBlock || msg.tokensUsed) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      {msg.codeBlock && (
                        <button
                          onClick={() => applyCode(msg.codeBlock!)}
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--color-success)' }}
                        >
                          <Check size={12} /> Apply to Editor
                        </button>
                      )}
                      {msg.tokensUsed && (
                        <span style={{ fontSize: '10px', color: 'var(--color-text-faint)' }}>
                          {msg.tokensUsed} tokens{msg.model ? ` · ${msg.model}` : ''}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {aiLoading && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-3)',
                  background: 'var(--color-bg-raised)', borderRadius: 'var(--radius-panel)',
                }}>
                  <div className="spinner" style={{ width: '14px', height: '14px' }} />
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)' }}>Thinking...</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div style={{
              padding: 'var(--space-2) var(--space-3)',
              borderTop: '1px solid var(--color-border-subtle)',
              display: 'flex', gap: 'var(--space-2)',
            }}>
              <input
                value={aiInput}
                onChange={e => setAIInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(aiInput); } }}
                placeholder={
                  aiInfo && !aiInfo.configured
                    ? "AI isn't configured on this server"
                    : aiInfo && !aiInfo.available
                    ? "AI unavailable"
                    : activeFile
                    ? `Ask about ${activeFile.path}...`
                    : 'Select a file first...'
                }
                disabled={aiLoading || !activeFile || (aiInfo !== null && (!aiInfo.configured || !aiInfo.available))}
                className="input"
                style={{ flex: 1, fontSize: 'var(--text-sm)' }}
              />
              <button
                onClick={() => sendAIMessage(aiInput)}
                disabled={!aiInput.trim() || aiLoading || !activeFile || (aiInfo !== null && (!aiInfo.configured || !aiInfo.available))}
                className="btn btn-primary btn-sm"
                style={{ padding: 'var(--space-2)' }}
              >
                <Send size={14} />
              </button>
            </div>
          </aside>
        )}

        {/* ─── Workspace Chat Panel ─── */}
        <WorkspaceChat
          slug={slug}
          isOpen={showChat}
          currentUserId={user?.id}
          currentUsername={user?.username}
          onClose={() => setShowChat(false)}
        />

        {/* ─── Version History Panel ─── */}
        {showVersionHistory && activeFile && (
          <div style={{
            width: '340px', flexShrink: 0, height: '100%',
            borderLeft: '1px solid var(--color-border)',
            overflow: 'hidden',
          }}>
            <VersionHistory
              slug={slug}
              filePath={activeFile.path}
              currentContent={(() => {
                // FIX 2 (SAVE VERSION SOURCE): Read live Y.Doc state directly,
                // not stale Postgres content. This ensures "Save Version" before
                // debounce flush captures the actual editor content.
                const provider = tabManager.getProvider(activeFile.path);
                if (provider) return provider.getText().toString();
                // Fallback: read from Monaco if no provider
                if (typeof window !== 'undefined' && (window as any).monaco) {
                  const models = (window as any).monaco.editor.getModels();
                  if (models?.[0]) return models[0].getValue();
                }
                return activeFile.content;
              })()}
              onRestore={(content) => {
                // FIX 1 (RESTORE VS LIVE Y.DOC): Inject restored content as a
                // real CRDT operation into the live Y.Doc. This ensures:
                // - The local Monaco editor updates immediately via the Y.Doc binding
                // - All other connected clients receive the change via normal sync
                // - The debounce flush will persist the restored content (not revert it)
                const provider = tabManager.getProvider(activeFile.path);
                if (provider) {
                  const ytext = provider.getText();
                  provider.doc.transact(() => {
                    ytext.delete(0, ytext.length);
                    ytext.insert(0, content);
                  }, 'restore');
                } else {
                  // Fallback: set Monaco model directly (won't sync to other clients)
                  if (typeof window !== 'undefined' && (window as any).monaco) {
                    const model = (window as any).monaco.editor.getModels()[0];
                    if (model) model.setValue(content);
                  }
                }
              }}
              onClose={() => setShowVersionHistory(false)}
            />
          </div>
        )}
      </div>

      {/* ─── Status Bar ─── */}
      <footer id="workspace-status-bar" style={{
        height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 var(--space-3)', background: 'var(--color-bg-surface)',
        borderTop: '1px solid var(--color-border-subtle)',
        color: 'var(--color-text-faint)', fontSize: '11px', flexShrink: 0,
        userSelect: 'none',
      }}>
        {/* Left: Sync Status, Peers, Language, Open Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title={`Sync Status: ${syncStatus}`}>
            <span style={{
              width: '7px', height: '7px', borderRadius: '50%',
              background: syncStatus === 'synced' ? 'var(--color-success)' : syncStatus === 'connecting' ? 'var(--color-warning)' : 'var(--color-danger)',
              display: 'inline-block',
            }} />
            <span style={{ fontWeight: 500, color: syncStatus === 'synced' ? 'var(--color-success)' : undefined }}>
              {syncStatus === 'synced' ? 'Synced' : syncStatus === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
          </span>

          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Connected peers in workspace">
            <Users size={12} />
            <span>
              {peerCount > 0
                ? `${peerCount + 1} online (${activePeers.some(p => p.isBot) ? 'Demo Bot + ' : ''}${activePeers.filter(p => !p.isBot).length} peer${activePeers.filter(p => !p.isBot).length !== 1 ? 's' : ''})`
                : '1 online'}
            </span>
          </span>

          {activeFile && (
            <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
              {getLanguageLabel(activeFile.path)}
            </span>
          )}

          {tabManager.tabState.openTabs.length > 0 && (
            <span>
              {tabManager.tabState.openTabs.length} tab{tabManager.tabState.openTabs.length > 1 ? 's' : ''} open
            </span>
          )}

          {/* Simulate Offline toggle — dev/demo-only, never visible in production regular workspaces */}
          {activeFile && (process.env.NODE_ENV !== 'production' || workspace?.is_demo) && (
            <button
              id="simulate-offline-toggle"
              onClick={() => {
                const activePath = tabManager.tabState.activeTabPath;
                if (!activePath) return;
                const provider = tabManager.getProvider(activePath);
                if (!provider) return;
                if (provider.isSimulatedOffline()) {
                  provider.simulateReconnect();
                } else {
                  provider.simulateDisconnect();
                }
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                background: simulatedOffline ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.1)',
                border: `1px solid ${simulatedOffline ? '#EF4444' : 'transparent'}`,
                borderRadius: '4px', padding: '1px 6px',
                color: simulatedOffline ? '#EF4444' : 'var(--color-text-faint)',
                fontSize: '10px', fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
              title={simulatedOffline
                ? `Simulated Offline Mode — ${offlineEditCount} local edit(s) pending. Click to reconnect and merge.`
                : 'Click to simulate going offline (WebSocket disconnects, local edits continue, reconnect merges via CRDT)'
              }
            >
              {simulatedOffline ? <WifiOff size={11} /> : <Wifi size={11} />}
              <span>{simulatedOffline ? `Offline (${offlineEditCount} edits)` : 'Online'}</span>
            </button>
          )}

          {/* Sync Inspector toggle — dev/demo-only, same gating as simulate-offline */}
          {activeFile && (process.env.NODE_ENV !== 'production' || workspace?.is_demo) && (
            <button
              id="sync-inspector-toggle"
              onClick={() => setShowInspector(prev => !prev)}
              style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                background: showInspector ? 'rgba(107, 91, 149, 0.15)' : 'transparent',
                border: `1px solid ${showInspector ? 'rgba(107, 91, 149, 0.4)' : 'transparent'}`,
                borderRadius: '4px', padding: '1px 6px',
                color: showInspector ? '#6B5B95' : 'var(--color-text-faint)',
                fontSize: '10px', fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
              title="Toggle Sync Inspector — shows real-time peer count, Y.Doc state, and WS message counters"
            >
              <Activity size={11} />
              <span>Inspector</span>
            </button>
          )}
        </div>

        {/* Right: Line/Col, Indent, Encoding, Line Endings, File Path, Palette Trigger */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          {activeFile && (
            <button
              onClick={() => setShowCommandPalette(true)}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--color-text-muted)', fontSize: '11px',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
              }}
              title="Click to jump to line (⌘K :line)"
            >
              <Hash size={11} style={{ opacity: 0.7 }} />
              <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
            </button>
          )}

          <span>Spaces: 2</span>
          <span>UTF-8</span>
          <span>LF</span>

          {activeFile && (
            <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
              {activeFile.path}
            </span>
          )}

          {tabManager.tabState.splitViewActive && (
            <span style={{
              color: 'var(--color-success)', fontWeight: 500,
              padding: '0 4px', borderRadius: '3px', background: 'rgba(16, 185, 129, 0.1)',
            }}>
              Split
            </span>
          )}

          <button
            onClick={() => setShowCommandPalette(true)}
            style={{
              background: 'none', border: 'none', padding: '0 4px',
              color: 'var(--color-text-faint)', fontSize: '10px',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px',
              borderRadius: '3px',
            }}
            title="Open Command Palette (⌘K)"
          >
            <Command size={10} />
            <span>⌘K</span>
          </button>
        </div>
      </footer>

      {/* ─── Merge Notification Toast ─── */}
      {mergeToast && (
        <div
          id="merge-toast"
          style={{
            position: 'fixed', bottom: '40px', right: '20px', zIndex: 9999,
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '10px 16px', borderRadius: '8px',
            background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.95), rgba(5, 150, 105, 0.95))',
            color: 'white', fontSize: '13px', fontWeight: 500,
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            animation: 'slideInRight 0.3s ease',
          }}
        >
          <Check size={16} style={{ flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700 }}>CRDT Merge Complete</div>
            <div style={{ fontSize: '11px', opacity: 0.9 }}>
              {mergeToast.edits} offline edit{mergeToast.edits !== 1 ? 's' : ''} merged successfully with server state.
              Both sides now hold identical content.
            </div>
          </div>
          <button
            onClick={() => setMergeToast(null)}
            style={{
              background: 'none', border: 'none', color: 'white',
              cursor: 'pointer', padding: '2px', opacity: 0.7,
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ─── Command Palette Modal ─── */}
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        actions={paletteActions}
      />

      {/* ─── Share / Members Modal ─── */}
      <ShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        slug={slug}
        currentUserId={user?.id}
      />

      {/* ─── Sync Inspector Panel ─── */}
      {showInspector && (process.env.NODE_ENV !== 'production' || workspace?.is_demo) && (
        <SyncInspector
          provider={tabManager.tabState.activeTabPath ? tabManager.getProvider(tabManager.tabState.activeTabPath) : null}
          onClose={() => setShowInspector(false)}
        />
      )}
    </div>
  );
}

// ── Markdown Message Renderer ────────────────────────────

function MessageContent({ content }: { content: string }) {
  // Split into code blocks and text segments
  const segments: { type: 'text' | 'code'; content: string; lang?: string }[] = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', content: match[2], lang: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) });
  }

  return (
    <>
      {segments.map((seg, si) => {
        if (seg.type === 'code') {
          return (
            <pre key={si} style={{
              margin: 'var(--space-2) 0', padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-control)',
              background: 'var(--color-bg-app)', fontSize: 'var(--text-xs)', overflow: 'auto',
              fontFamily: 'var(--font-mono)', lineHeight: 1.5,
              color: 'var(--color-text)', border: '1px solid var(--color-border-subtle)',
              whiteSpace: 'pre-wrap',
            }}>{seg.content.trim()}</pre>
          );
        }

        const lines = seg.content.split('\n');
        return (
          <span key={si}>
            {lines.map((line, li) => {
              const trimmed = line.trim();
              if (trimmed.startsWith('### ')) return <div key={li} style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>{renderInline(trimmed.slice(4))}</div>;
              if (trimmed.startsWith('## ')) return <div key={li} style={{ fontWeight: 600, fontSize: 'var(--text-base)', marginTop: 'var(--space-3)' }}>{renderInline(trimmed.slice(3))}</div>;
              if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
                return <div key={li} style={{ paddingLeft: 'var(--space-3)', position: 'relative', marginTop: '2px' }}><span style={{ position: 'absolute', left: 0 }}>-</span> {renderInline(trimmed.slice(2))}</div>;
              }
              if (trimmed === '') return <div key={li} style={{ height: '4px' }} />;
              return <div key={li} style={{ marginTop: li > 0 ? '2px' : 0 }}>{renderInline(trimmed)}</div>;
            })}
          </span>
        );
      })}
    </>
  );
}

// Render inline markdown: **bold**, `code`, *italic*
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const inlineRegex = /(\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*)/g;
  let lastIdx = 0;
  let m;
  let key = 0;

  while ((m = inlineRegex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(<span key={key++}>{text.slice(lastIdx, m.index)}</span>);
    if (m[2]) parts.push(<strong key={key++} style={{ fontWeight: 600 }}>{m[2]}</strong>);
    else if (m[3]) parts.push(
      <code key={key++} style={{
        padding: '1px 5px', borderRadius: '4px', fontSize: '12px',
        background: 'var(--color-accent-subtle)', color: 'var(--color-accent)',
        fontFamily: 'var(--font-mono)',
      }}>{m[3]}</code>
    );
    else if (m[4]) parts.push(<em key={key++}>{m[4]}</em>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  return parts;
}
