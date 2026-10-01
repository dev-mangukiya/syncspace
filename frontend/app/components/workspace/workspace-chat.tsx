'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  MessageSquare,
  Send,
  X,
  Loader2,
  AlertCircle,
  ArrowDown,
  Smile,
  Copy,
  Check,
} from 'lucide-react';
import { workspaceAPI, WorkspaceChatMessage } from '@/app/lib/api';

const CURSOR_COLORS = [
  '#5B8C5A', // moss
  '#8B6914', // amber
  '#6B5B95', // slate purple
  '#C4573A', // terracotta
  '#2E86AB', // steel blue
  '#A23B72', // mauve
  '#1B998B', // teal
  '#CC8400', // ochre
];

interface WorkspaceChatProps {
  slug: string;
  isOpen?: boolean;
  currentUserId?: string;
  currentUsername?: string;
  onClose: () => void;
}

function formatMessageTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatFullDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString();
  } catch {
    return '';
  }
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Formatter for message content: handles code blocks, inline code, and URLs via safe React JSX text elements (zero dangerouslySetInnerHTML) */
function FormattedMessageContent({ content }: { content: string }) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyCode = (code: string, index: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // Check for fenced code blocks ```code```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div style={{ fontSize: '13px', lineHeight: 1.5, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
      {parts.map((part, idx) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const rawCode = part.slice(3, -3).replace(/^\w+\n/, ''); // Strip language tag if any
          return (
            <div
              key={idx}
              style={{
                position: 'relative',
                background: 'var(--color-bg-app)',
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                margin: '6px 0',
                padding: '8px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                overflowX: 'auto',
              }}
            >
              <button
                onClick={() => copyCode(rawCode, idx)}
                style={{
                  position: 'absolute',
                  top: '6px',
                  right: '6px',
                  background: 'var(--color-bg-raised)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: '4px',
                  padding: '2px 6px',
                  cursor: 'pointer',
                  color: 'var(--color-text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '11px',
                }}
                title="Copy code"
              >
                {copiedIndex === idx ? <Check size={11} style={{ color: 'var(--color-success)' }} /> : <Copy size={11} />}
                {copiedIndex === idx ? 'Copied' : 'Copy'}
              </button>
              <code>{rawCode}</code>
            </div>
          );
        }

        // Inline formatting: detect inline `code` and http/https URLs (rendered as pure React text elements)
        const subParts = part.split(/(`[^`]+`|https?:\/\/[^\s]+)/g);
        return (
          <span key={idx}>
            {subParts.map((sub, sIdx) => {
              if (sub.startsWith('`') && sub.endsWith('`') && sub.length > 2) {
                return (
                  <code
                    key={sIdx}
                    style={{
                      background: 'var(--color-bg-raised)',
                      border: '1px solid var(--color-border-subtle)',
                      borderRadius: '3px',
                      padding: '1px 4px',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '12px',
                      color: 'var(--color-accent)',
                    }}
                  >
                    {sub.slice(1, -1)}
                  </code>
                );
              }
              if ((sub.startsWith('http://') || sub.startsWith('https://')) && isSafeUrl(sub)) {
                return (
                  <a
                    key={sIdx}
                    href={sub}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}
                  >
                    {sub}
                  </a>
                );
              }
              return sub;
            })}
          </span>
        );
      })}
    </div>
  );
}

export function WorkspaceChat({
  slug,
  isOpen = true,
  currentUserId,
  currentUsername,
  onClose,
}: WorkspaceChatProps) {
  const [messages, setMessages] = useState<WorkspaceChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll helper
  const scrollToBottom = useCallback((smooth = true) => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }
  }, []);

  // Scroll to bottom when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => scrollToBottom(false), 50);
    }
  }, [isOpen, scrollToBottom]);

  // Check scroll position to display "Scroll to bottom" button
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    setShowScrollBottom(distanceToBottom > 80);
  };

  // Fetch initial history (last 200 messages)
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);

    workspaceAPI.listMessages(slug)
      .then((res) => {
        if (!mounted) return;
        setMessages(res.data || []);
        setTimeout(() => scrollToBottom(false), 50);
      })
      .catch((err) => {
        if (!mounted) return;
        console.error('[Chat] Failed to load messages:', err);
        setError('Failed to load message history');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [slug, scrollToBottom]);

  // Real-time listener for incoming messages via WebSocket / Redis pub/sub
  useEffect(() => {
    const handleChatEvent = (e: CustomEvent<WorkspaceChatMessage>) => {
      const incoming = e.detail;
      if (!incoming || !incoming.id) return;

      setMessages((prev) => {
        // Prevent duplicate if message already present
        if (prev.some((m) => m.id === incoming.id)) {
          return prev;
        }
        return [...prev, incoming];
      });

      // If user is scrolled near bottom, auto-scroll to bottom
      if (scrollRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 120;
        if (isNearBottom || incoming.user_id === currentUserId) {
          setTimeout(() => scrollToBottom(true), 50);
        }
      }
    };

    window.addEventListener('syncspace:chat', handleChatEvent as EventListener);
    return () => {
      window.removeEventListener('syncspace:chat', handleChatEvent as EventListener);
    };
  }, [currentUserId, scrollToBottom]);

  // Send message handler
  const handleSend = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || sending) return;
    if (trimmed.length > 2000) {
      setError('Message exceeds 2000 character limit');
      return;
    }

    setSending(true);
    setError(null);

    try {
      const res = await workspaceAPI.sendMessage(slug, trimmed);
      const newMsg = res.data;
      if (newMsg && newMsg.id) {
        setMessages((prev) => (prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg]));
      }
      setInputText('');
      setTimeout(() => scrollToBottom(true), 50);
      textareaRef.current?.focus();
    } catch (err: any) {
      console.error('[Chat] Failed to send message:', err);
      const serverMsg = err.response?.data?.error || 'Failed to send message';
      setError(serverMsg);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <aside
      id="workspace-chat-panel"
      aria-label="Workspace Chat"
      style={{
        width: '350px',
        borderLeft: '1px solid var(--color-border-subtle)',
        background: 'var(--color-bg-surface)',
        display: isOpen ? 'flex' : 'none',
        flexDirection: 'column',
        flexShrink: 0,
        height: '100%',
        position: 'relative',
      }}
    >
      {/* ─── Header ─── */}
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: '42px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <MessageSquare size={16} style={{ color: 'var(--color-accent)' }} />
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)' }}>
            Workspace Chat
          </span>
          <span
            style={{
              fontSize: '11px',
              padding: '1px 6px',
              borderRadius: '10px',
              background: 'var(--color-bg-raised)',
              color: 'var(--color-text-muted)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            {messages.length}
          </span>
        </div>

        <button
          onClick={onClose}
          className="btn-icon"
          style={{ width: '24px', height: '24px' }}
          title="Close chat"
          id="close-chat-btn"
        >
          <X size={14} />
        </button>
      </div>

      {/* ─── Message List Container ─── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        id="chat-messages-container"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--space-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {loading ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--space-2)',
              color: 'var(--color-text-muted)',
            }}
          >
            <Loader2 size={20} className="spin-icon" />
            <span style={{ fontSize: 'var(--text-xs)' }}>Loading chat history...</span>
          </div>
        ) : messages.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-4)',
              color: 'var(--color-text-muted)',
            }}
          >
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '50%',
                background: 'var(--color-bg-raised)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-accent)',
              }}
            >
              <MessageSquare size={20} />
            </div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)' }}>
              No messages yet
            </div>
            <div style={{ fontSize: 'var(--text-xs)', maxWidth: '240px', lineHeight: 1.4 }}>
              Say hello to your collaborators! Messages are synced in real time and persisted.
            </div>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isMe = currentUserId ? msg.user_id === currentUserId : msg.username === currentUsername;
            const slotColor = CURSOR_COLORS[Math.abs(msg.color_slot) % CURSOR_COLORS.length] || '#5B8C5A';
            const userInitial = (msg.username || '?').charAt(0).toUpperCase();

            // Grouping: check if previous message was by the same author within 2 minutes
            const prevMsg = index > 0 ? messages[index - 1] : null;
            const isSameAuthor = prevMsg && prevMsg.user_id === msg.user_id;
            const timeDiff = prevMsg
              ? Math.abs(new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime())
              : Infinity;
            const isGrouped = isSameAuthor && timeDiff < 2 * 60 * 1000;

            return (
              <div
                key={msg.id || index}
                className="chat-message-item"
                data-message-id={msg.id}
                data-user-id={msg.user_id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  marginTop: isGrouped ? '-4px' : '0',
                }}
              >
                {/* Avatar column */}
                <div style={{ width: '28px', flexShrink: 0 }}>
                  {!isGrouped && (
                    <div
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        background: 'var(--color-bg-raised)',
                        border: `2px solid ${slotColor}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'var(--color-text)',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      }}
                      title={`${msg.username} (Color slot ${msg.color_slot})`}
                    >
                      {userInitial}
                    </div>
                  )}
                </div>

                {/* Content column */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {!isGrouped && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: '6px',
                        marginBottom: '2px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 'var(--text-xs)',
                          fontWeight: 600,
                          color: 'var(--color-text)',
                        }}
                      >
                        {msg.username}
                      </span>

                      {isMe && (
                        <span
                          style={{
                            fontSize: '9px',
                            fontWeight: 600,
                            padding: '1px 4px',
                            borderRadius: '3px',
                            background: 'var(--color-accent-subtle)',
                            color: 'var(--color-accent)',
                            textTransform: 'uppercase',
                          }}
                        >
                          you
                        </span>
                      )}

                      <span
                        style={{
                          fontSize: '10px',
                          color: 'var(--color-text-faint)',
                        }}
                        title={formatFullDate(msg.created_at)}
                      >
                        {formatMessageTime(msg.created_at)}
                      </span>
                    </div>
                  )}

                  {/* Bubble card */}
                  <div
                    style={{
                      background: isMe ? 'var(--color-bg-raised)' : 'var(--color-bg-surface)',
                      border: '1px solid var(--color-border-subtle)',
                      borderRadius: isGrouped ? '6px' : isMe ? '4px 10px 10px 10px' : '4px 10px 10px 10px',
                      padding: '6px 10px',
                      color: 'var(--color-text)',
                      boxShadow: 'var(--shadow-sm)',
                    }}
                  >
                    <FormattedMessageContent content={msg.content} />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ─── Scroll to bottom pill ─── */}
      {showScrollBottom && (
        <button
          onClick={() => scrollToBottom(true)}
          style={{
            position: 'absolute',
            bottom: '76px',
            right: '16px',
            background: 'var(--color-accent-solid)',
            color: '#FFFFFF',
            border: 'none',
            borderRadius: '16px',
            padding: '4px 10px',
            fontSize: '11px',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            boxShadow: 'var(--shadow-md)',
            cursor: 'pointer',
            zIndex: 10,
          }}
        >
          <ArrowDown size={12} /> Latest
        </button>
      )}

      {/* ─── Error Notification ─── */}
      {error && (
        <div
          style={{
            padding: '6px 10px',
            background: 'rgba(194, 91, 86, 0.12)',
            borderTop: '1px solid var(--color-danger)',
            color: 'var(--color-danger)',
            fontSize: 'var(--text-xs)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* ─── Input & Send Bar ─── */}
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          borderTop: '1px solid var(--color-border-subtle)',
          background: 'var(--color-bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            id="workspace-chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send)"
            disabled={sending}
            rows={1}
            style={{
              flex: 1,
              minHeight: '34px',
              maxHeight: '100px',
              resize: 'none',
              borderRadius: '6px',
              background: 'var(--color-bg-raised)',
              border: '1px solid var(--color-border)',
              padding: '6px 10px',
              fontSize: '13px',
              color: 'var(--color-text)',
              fontFamily: 'inherit',
              lineHeight: 1.4,
              outline: 'none',
            }}
          />

          <button
            id="workspace-chat-send-btn"
            onClick={handleSend}
            disabled={!inputText.trim() || sending}
            className="btn btn-primary btn-sm"
            style={{
              height: '34px',
              padding: '0 12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            title="Send message (Enter)"
          >
            {sending ? <Loader2 size={14} className="spin-icon" /> : <Send size={14} />}
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '10px',
            color: 'var(--color-text-faint)',
            padding: '0 2px',
          }}
        >
          <span>Shift+Enter for newline</span>
          {inputText.length > 0 && (
            <span style={{ color: inputText.length > 1800 ? 'var(--color-warning)' : undefined }}>
              {inputText.length}/2000
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
