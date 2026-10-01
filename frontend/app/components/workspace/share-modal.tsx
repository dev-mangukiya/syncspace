'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, Users, UserPlus, Trash2, Shield, Loader2, Check } from 'lucide-react';
import { workspaceAPI, Member } from '@/app/lib/api';

const COLOR_SLOT_PALETTE = [
  '#3B82F6', // Blue
  '#10B981', // Green
  '#F59E0B', // Amber
  '#EC4899', // Pink
  '#8B5CF6', // Purple
  '#06B6D4', // Cyan
  '#F97316', // Orange
  '#6366F1', // Indigo
];

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  slug: string;
  currentUserId?: string;
}

export function ShareModal({ isOpen, onClose, slug, currentUserId }: ShareModalProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteIdentifier, setInviteIdentifier] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadMembers = useCallback(async () => {
    if (!slug) return;
    try {
      setLoading(true);
      const res = await workspaceAPI.listMembers(slug);
      setMembers(res.data);
      setError('');
    } catch (err: unknown) {
      setError('Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    if (isOpen) {
      loadMembers();
      setInviteIdentifier('');
      setError('');
      setSuccess('');
    }
  }, [isOpen, loadMembers]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteIdentifier.trim()) return;
    setInviting(true);
    setError('');
    setSuccess('');
    try {
      const res = await workspaceAPI.inviteMember(slug, inviteIdentifier.trim(), inviteRole);
      setMembers(res.data);
      setSuccess(`Added ${inviteIdentifier.trim()} as ${inviteRole}`);
      setInviteIdentifier('');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || 'Failed to add member';
      setError(msg);
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (userId: string, username: string) => {
    if (!confirm(`Remove ${username} from this workspace?`)) return;
    try {
      await workspaceAPI.removeMember(slug, userId);
      setMembers(prev => prev.filter(m => m.user_id !== userId));
      setSuccess(`Removed ${username}`);
    } catch (err: any) {
      setError('Failed to remove member');
    }
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      await workspaceAPI.updateMemberRole(slug, userId, newRole);
      setMembers(prev => prev.map(m => m.user_id === userId ? { ...m, role: newRole as Member['role'] } : m));
    } catch (err: any) {
      setError('Failed to update role');
    }
  };

  if (!isOpen) return null;

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
      {/* Modal */}
      <div style={{
        position: 'fixed', top: '20%', left: '50%', transform: 'translateX(-50%)',
        width: '480px', maxHeight: '80vh',
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        display: 'flex', flexDirection: 'column',
        zIndex: 9999, overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Users size={18} style={{ color: 'var(--color-accent)' }} />
            <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--color-text)' }}>
              Workspace Members
            </h3>
          </div>
          <button onClick={onClose} className="btn-icon" aria-label="Close modal">
            <X size={16} />
          </button>
        </div>

        {/* Invite Form */}
        <form onSubmit={handleInvite} style={{
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex', gap: 'var(--space-2)',
        }}>
          <input
            value={inviteIdentifier}
            onChange={e => setInviteIdentifier(e.target.value)}
            placeholder="Username or email..."
            className="input"
            style={{ flex: 1, fontSize: 'var(--text-sm)', height: '32px' }}
            disabled={inviting}
          />
          <select
            value={inviteRole}
            onChange={e => setInviteRole(e.target.value as 'editor' | 'viewer')}
            className="input"
            style={{ width: '90px', fontSize: 'var(--text-sm)', height: '32px' }}
            disabled={inviting}
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            type="submit"
            disabled={!inviteIdentifier.trim() || inviting}
            className="btn btn-primary btn-sm"
            style={{ height: '32px', display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            {inviting ? <Loader2 size={14} className="spin-icon" /> : <UserPlus size={14} />}
            Invite
          </button>
        </form>

        {/* Feedback Messages */}
        {error && (
          <div style={{
            padding: 'var(--space-2) var(--space-4)',
            fontSize: 'var(--text-xs)', color: 'var(--color-danger)',
            background: 'rgba(239, 68, 68, 0.1)',
          }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{
            padding: 'var(--space-2) var(--space-4)',
            fontSize: 'var(--text-xs)', color: 'var(--color-success)',
            background: 'rgba(16, 185, 129, 0.1)',
            display: 'flex', alignItems: 'center', gap: '4px',
          }}>
            <Check size={12} /> {success}
          </div>
        )}

        {/* Members List */}
        <div style={{ flex: 1, overflow: 'auto', maxHeight: '300px', padding: 'var(--space-2) 0' }}>
          {loading ? (
            <div style={{ padding: 'var(--space-4)', textAlign: 'center', color: 'var(--color-text-faint)' }}>
              <Loader2 size={20} className="spin-icon" style={{ margin: '0 auto 8px' }} />
              Loading members...
            </div>
          ) : members.length === 0 ? (
            <div style={{ padding: 'var(--space-4)', textAlign: 'center', color: 'var(--color-text-faint)' }}>
              No members found
            </div>
          ) : (
            members.map(member => {
              const isMe = member.user_id === currentUserId;
              const slot = typeof member.color_slot === 'number' ? member.color_slot : 0;
              const slotColor = COLOR_SLOT_PALETTE[slot % COLOR_SLOT_PALETTE.length];

              return (
                <div
                  key={member.user_id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: 'var(--space-2) var(--space-4)',
                    borderBottom: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    {/* User avatar with colorSlot border */}
                    <div style={{
                      width: '28px', height: '28px', borderRadius: '50%',
                      background: 'var(--color-bg-raised)',
                      border: `2px solid ${slotColor}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '12px', fontWeight: 600, color: 'var(--color-text)',
                    }}>
                      {(member.username || member.email || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>{member.username || member.email}</span>
                        {isMe && (
                          <span style={{
                            fontSize: '10px', padding: '1px 5px', borderRadius: '4px',
                            background: 'var(--color-accent-subtle)', color: 'var(--color-accent)',
                          }}>you</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--color-text-faint)' }}>
                        Color Slot {slot}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    {member.role === 'owner' ? (
                      <span style={{
                        display: 'flex', alignItems: 'center', gap: '4px',
                        fontSize: '11px', fontWeight: 600, color: 'var(--color-warning)',
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(245, 158, 11, 0.1)',
                      }}>
                        <Shield size={12} /> Owner
                      </span>
                    ) : (
                      <>
                        <select
                          value={member.role}
                          onChange={e => handleRoleChange(member.user_id, e.target.value)}
                          className="input"
                          style={{ fontSize: '11px', padding: '2px 6px', height: '26px' }}
                          disabled={isMe}
                        >
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                        {!isMe && (
                          <button
                            onClick={() => handleRemove(member.user_id, member.username || member.email)}
                            className="btn-icon"
                            style={{ width: '26px', height: '26px', color: 'var(--color-danger)' }}
                            title="Remove member"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
