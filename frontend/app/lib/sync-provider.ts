'use client';

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// Read a cookie by name (for CSRF token)
function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

const WS_BASE = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'http://localhost:8080';
// Ticket requests go through the same-origin Next.js proxy so httpOnly cookies are sent.
// In the browser, '' means same origin (localhost:3000 in dev).
const TICKET_API = typeof window !== 'undefined' ? '' : WS_BASE;

// Color palette for remote cursors (earth tones matching design system)
const CURSOR_COLORS = [
  { color: '#5B8C5A', light: '#5B8C5A33' }, // moss
  { color: '#8B6914', light: '#8B691433' }, // amber
  { color: '#6B5B95', light: '#6B5B9533' }, // slate purple
  { color: '#C4573A', light: '#C4573A33' }, // terracotta
  { color: '#2E86AB', light: '#2E86AB33' }, // steel blue
  { color: '#A23B72', light: '#A23B7233' }, // mauve
  { color: '#1B998B', light: '#1B998B33' }, // teal
  { color: '#CC8400', light: '#CC840033' }, // ochre
];

interface SyncProviderOptions {
  slug: string;
  filePath: string;
  // token removed — JWT is in httpOnly cookie, sent automatically with credentials:'include'
  userId: string;
  username: string;
  colorSlot: number;
}

/**
 * SyncProvider: manages a Y.Doc per file, connecting it to the Go relay server
 * via WebSocket. The Go server is a dumb binary relay — it does not parse Yjs
 * internals. All CRDT merge logic runs here on the client via Yjs.
 *
 * Identity: each client reads its own identity from its authenticated session
 * (the userId/username come from the JWT-authenticated ticket request, NOT from
 * awareness state). The server stamps connections with the ticket's identity,
 * so a client cannot spoof another user's cursor.
 */
export class SyncProvider {
  doc: Y.Doc;
  awareness: Awareness;
  private ws: WebSocket | null = null;
  private connected = false;
  private destroyed = false;
  private options: SyncProviderOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private solitarySyncTimer: ReturnType<typeof setTimeout> | null = null;
  private synced = false;
  private hasSeedGrant = false;
  private simulatedOffline = false;
  private offlineEditCount = 0;

  // ── Connection state tracking for BLOCKER-001 disclaimer ──
  private _wasEverSynced = false;
  private _disconnectedAt: number | null = null;
  private _reconnectDelay = 3500; // 3.5s default reconnect delay, naturally covering > 3s threshold

  // ── Inspector counters (real WS traffic) ──────────────────
  private _syncMsgSent = 0;
  private _syncMsgReceived = 0;
  private _awarenessMsgSent = 0;
  private _awarenessMsgReceived = 0;
  // Fires whenever inspector-relevant state changes (peer join/leave, message, etc.)
  onInspectorUpdate: (() => void) | null = null;

  /** Get inspector snapshot — all values from real runtime state */
  getInspectorState() {
    const states = this.awareness.getStates();
    const peers: Array<{ clientId: number; name: string; color: string; isLocal: boolean }> = [];
    states.forEach((state, clientId) => {
      peers.push({
        clientId,
        name: state.user?.name || 'Unknown',
        color: state.user?.color || '#888',
        isLocal: clientId === this.doc.clientID,
      });
    });
    return {
      connected: this.connected,
      synced: this.synced,
      peerCount: states.size,
      peers,
      docSizeBytes: Y.encodeStateAsUpdate(this.doc).byteLength,
      textLength: this.doc.getText('content').length,
      clientId: this.doc.clientID,
      syncMsgSent: this._syncMsgSent,
      syncMsgReceived: this._syncMsgReceived,
      awarenessMsgSent: this._awarenessMsgSent,
      awarenessMsgReceived: this._awarenessMsgReceived,
      totalSent: this._syncMsgSent + this._awarenessMsgSent,
      totalReceived: this._syncMsgReceived + this._awarenessMsgReceived,
    };
  }

  // Callbacks
  onSynced: (() => void) | null = null;
  onSeedGrant: (() => void) | null = null;
  onStatus: ((status: { connected: boolean }) => void) | null = null;
  // File tree change events broadcast by the server (create, rename, delete)
  onFileTreeEvent: ((event: { type: string; path: string; new_path?: string }) => void) | null = null;
  // Real-time chat messages broadcast by the server
  onChatMessage: ((message: any) => void) | null = null;
  // Simulate-offline state change
  onSimulateOfflineChange: ((info: { offline: boolean; editCount: number }) => void) | null = null;
  // Fired on reconnect after simulated offline, with merge stats
  onMergeComplete: ((info: { offlineEdits: number; mergedAt: number }) => void) | null = null;
  // Fired whenever provider re-syncs after being disconnected for >= 3 seconds (regardless of cause)
  onLongDisconnectReconnect: ((info: { durationMs: number }) => void) | null = null;

  canSeed(): boolean {
    return this.hasSeedGrant;
  }

  /**
   * Simulate going offline: closes WebSocket, blocks auto-reconnect.
   * Local edits continue accumulating in the Y.Doc (Yjs CRDT).
   * Call simulateReconnect() to re-establish connection and merge.
   */
  simulateDisconnect(): void {
    if (this.simulatedOffline || this.destroyed) return;
    this.simulatedOffline = true;
    this.offlineEditCount = 0;

    // Close the existing WebSocket without triggering auto-reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._markDisconnected();
    this.onSimulateOfflineChange?.({ offline: true, editCount: 0 });

    // Track offline edits for merge feedback
    this.doc.on('update', this._offlineEditTracker);
  }

  /**
   * Reconnect after simulated offline. Yjs sync protocol will automatically
   * merge all offline edits with the server state (and any concurrent peer edits).
   */
  simulateReconnect(): void {
    if (!this.simulatedOffline || this.destroyed) return;
    this.simulatedOffline = false;
    const editCount = this.offlineEditCount;

    // Stop tracking offline edits
    this.doc.off('update', this._offlineEditTracker);

    // Re-connect — the connect() method sends sync step 1 + step 2,
    // which pushes all offline Y.Doc changes and pulls all server changes
    this.connect();

    // Fire merge callback ONLY after verified sync success.
    // onSynced fires when:
    //   (a) sync step 2 is received from a peer (real merge), or
    //   (b) the solitary-client fallback confirms WS is open + no peers (trivial merge)
    // If connect() fails entirely (ticket rejected, WS never opens), onSynced never fires
    // and onMergeComplete never fires — no false-positive merge toast.
    this._pendingMerge = { editCount, timestamp: Date.now() };
    const origOnSynced = this.onSynced;
    this.onSynced = () => {
      if (this._pendingMerge) {
        this.onMergeComplete?.({ offlineEdits: this._pendingMerge.editCount, mergedAt: Date.now() });
        this._pendingMerge = null;
      }
      this.onSynced = origOnSynced;
      origOnSynced?.();
    };

    // Safety: if sync doesn't complete within 15s, clear the pending merge
    // so the toast doesn't fire stale on a much-later reconnect.
    setTimeout(() => {
      if (this._pendingMerge && this._pendingMerge.timestamp === editCount) {
        this._pendingMerge = null;
      }
    }, 15000);

    this.onSimulateOfflineChange?.({ offline: false, editCount });
  }

  isSimulatedOffline(): boolean {
    return this.simulatedOffline;
  }

  getOfflineEditCount(): number {
    return this.offlineEditCount;
  }

  private _pendingMerge: { editCount: number; timestamp: number } | null = null;

  private _offlineEditTracker = (_update: Uint8Array, origin: unknown) => {
    if (origin === this) return; // skip remote echoes
    this.offlineEditCount++;
    this.onSimulateOfflineChange?.({ offline: true, editCount: this.offlineEditCount });
  };

  constructor(options: SyncProviderOptions) {
    this.options = options;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);

    // Set local awareness state — identity comes from the authenticated session
    this.awareness.setLocalStateField('user', {
      name: options.username,
      color: CURSOR_COLORS[options.colorSlot % CURSOR_COLORS.length].color,
      colorLight: CURSOR_COLORS[options.colorSlot % CURSOR_COLORS.length].light,
      isBot: false,
    });

    // When the Y.Doc changes, send sync updates to the server
    let snapshotTimeout: NodeJS.Timeout | null = null;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // Don't echo back remote updates
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
      this._syncMsgSent++;
      this.onInspectorUpdate?.();

      // Stream debounced text snapshot over WebSocket for zero-data-loss server persistence
      if (snapshotTimeout) clearTimeout(snapshotTimeout);
      snapshotTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const text = this.doc.getText('content').toString();
          this.ws.send(JSON.stringify({ type: 'content_snapshot', content: text }));
        }
      }, 300);
    });

    // When local awareness changes, broadcast
    this.awareness.on('update', ({ added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => {
      const changedClients = added.concat(updated).concat(removed);
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
      this.ws.send(encoding.toUint8Array(encoder));
      this._awarenessMsgSent++;
      this.onInspectorUpdate?.();
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this._handleWindowOffline);
      window.addEventListener('online', this._handleWindowOnline);
    }

    this.connect();
  }

  private _markDisconnected() {
    this.connected = false;
    this.synced = false;
    if (this._wasEverSynced && this._disconnectedAt === null) {
      this._disconnectedAt = Date.now();
    }
    this.onStatus?.({ connected: false });
  }

  private _markSynced() {
    this.synced = true;
    if (this._wasEverSynced && this._disconnectedAt !== null) {
      const durationMs = Date.now() - this._disconnectedAt;
      if (durationMs >= 3000) {
        this.onLongDisconnectReconnect?.({ durationMs });
      }
      this._disconnectedAt = null;
    }
    this._wasEverSynced = true;
    this.onSynced?.();
  }

  forceClose(): void {
    if (this.ws) {
      this.ws.close();
    }
  }

  getWebSocket(): WebSocket | null {
    return this.ws;
  }

  setReconnectDelay(ms: number): void {
    this._reconnectDelay = ms;
  }

  getDisconnectedDuration(): number | null {
    if (this._disconnectedAt === null) return null;
    return Date.now() - this._disconnectedAt;
  }

  private _handleWindowOffline = () => {
    if (this.destroyed || this.simulatedOffline) return;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._markDisconnected();
  };

  private _handleWindowOnline = () => {
    if (this.destroyed || this.simulatedOffline) return;
    if (!this.connected) {
      this.connect();
    }
  };

  private async connect() {
    if (this.destroyed) return;
    // Block reconnect while simulated offline
    if (this.simulatedOffline) return;

    try {
      // Step 1: Request a single-use ticket using httpOnly cookie auth
      const csrfToken = getCookie('syncspace_csrf') || '';
      const ticketRes = await fetch(`${TICKET_API}/api/ws-ticket`, {
        method: 'POST',
        credentials: 'include', // sends httpOnly cookies
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
      });

      if (!ticketRes.ok) {
        console.error('[SyncProvider] Failed to get ticket:', ticketRes.status);
        this._markDisconnected();
        this.scheduleReconnect();
        return;
      }

      const { ticket } = await ticketRes.json();

      // Step 2: Connect WebSocket with the ticket (NOT the JWT)
      const wsUrl = WS_BASE.replace(/^http/, 'ws') +
        `/ws/${this.options.slug}/${encodeURIComponent(this.options.filePath)}?ticket=${ticket}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      if (typeof window !== 'undefined') {
        (window as any).__syncProvider = this;
        (window as any).__activeWs = ws;
      }

      ws.onopen = () => {
        this.connected = true;
        this.synced = false;
        this.onStatus?.({ connected: true });

        // Send sync step 1 (our state vector) to request missing updates from peers
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        ws.send(encoding.toUint8Array(encoder));
        this._syncMsgSent++;

        // Also send sync step 2 (our full state as an update) so peers get OUR changes.
        // In a relay architecture, step 1 alone only triggers peers to send THEIR diff
        // to us. We also need to push OUR diff to them — critical for offline reconnect.
        const step2Encoder = encoding.createEncoder();
        encoding.writeVarUint(step2Encoder, MSG_SYNC);
        syncProtocol.writeSyncStep2(step2Encoder, this.doc);
        ws.send(encoding.toUint8Array(step2Encoder));
        this._syncMsgSent++;

        // Broadcast full awareness state
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        ws.send(encoding.toUint8Array(awarenessEncoder));
        this._awarenessMsgSent++;

        // Solitary client fallback: In a dumb binary relay architecture, if no peers exist
        // to respond with sync step 2, mark as synced after sending initial vectors.
        // CONDITIONED STRICTLY on WebSocket having successfully opened and remaining open.
        if (this.solitarySyncTimer) {
          clearTimeout(this.solitarySyncTimer);
          this.solitarySyncTimer = null;
        }
        this.solitarySyncTimer = setTimeout(() => {
          this.solitarySyncTimer = null;
          if (
            !this.destroyed &&
            this.connected &&
            this.ws &&
            this.ws.readyState === WebSocket.OPEN &&
            !this.synced &&
            this.awareness.getStates().size <= 1
          ) {
            this._markSynced();
          }
        }, 400);
      };

      ws.onmessage = (event) => {
        // Control messages arrive as TEXT frames (string); Yjs data arrives as BINARY frames (ArrayBuffer).
        // This distinction is structural (WebSocket frame type), not byte-level, so there is zero
        // risk of collision with Yjs protocol bytes (e.g. MSG_SYNC=0x00).
        if (typeof event.data === 'string') {
          try {
            const parsed = JSON.parse(event.data);
            if (parsed.type === 'seed_grant' && parsed.file === this.options.filePath) {
              this.hasSeedGrant = true;
              this.onSeedGrant?.();
              return;
            }
            if (parsed.type === 'chat_message') {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('syncspace:chat', { detail: parsed.message }));
              }
              this.onChatMessage?.(parsed.message);
            } else if (parsed.type && parsed.type.startsWith('run_')) {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('syncspace:run', { detail: parsed }));
              }
            } else {
              this.onFileTreeEvent?.(parsed);
            }
          } catch (e) {
            console.warn('[SyncProvider] Failed to parse control message:', e);
          }
          return;
        }

        const data = new Uint8Array(event.data);

        const decoder = decoding.createDecoder(data);
        const messageType = decoding.readVarUint(decoder);

        switch (messageType) {
          case MSG_SYNC: {
            const syncEncoder = encoding.createEncoder();
            encoding.writeVarUint(syncEncoder, MSG_SYNC);
            // readSyncMessage returns a response type:
            // 0 = sync step 1 received (we send step 2 back)
            // 1 = sync step 2 received (initial sync done)
            // 2 = update received
            const msgType = syncProtocol.readSyncMessage(decoder, syncEncoder, this.doc, this);
            this._syncMsgReceived++;
            if (encoding.length(syncEncoder) > 1) {
              ws.send(encoding.toUint8Array(syncEncoder));
              this._syncMsgSent++;
            }
            this.onInspectorUpdate?.();
            // Mark as synced after receiving sync step 2
            if (msgType === 1 && !this.synced) {
              this._markSynced();
            }
            break;
          }
          case MSG_AWARENESS: {
            const update = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
            this._awarenessMsgReceived++;
            this.onInspectorUpdate?.();
            break;
          }
        }
      };

      ws.onclose = () => {
        if (this.solitarySyncTimer) {
          clearTimeout(this.solitarySyncTimer);
          this.solitarySyncTimer = null;
        }
        this._markDisconnected();
        this.ws = null;
        if (typeof window !== 'undefined' && (window as any).__activeWs === ws) {
          (window as any).__activeWs = null;
        }

        if (!this.destroyed) {
          // Remove awareness for this client
          awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], this);
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };

    } catch (err) {
      console.error('[SyncProvider] Connection error:', err);
      this._markDisconnected();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    // Don't auto-reconnect while simulated offline
    if (this.simulatedOffline) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this._reconnectDelay);
  }

  /**
   * Get the Y.Text instance for this document.
   * This is what y-monaco binds to.
   */
  getText(): Y.Text {
    return this.doc.getText('content');
  }

  /**
   * Seed the Y.Doc from existing content (e.g., from the database).
   * Only call this when the Y.Doc is empty AND this client was elected as seeder.
   */
  seedContent(content: string) {
    if (!this.hasSeedGrant) {
      return;
    }
    const ytext = this.getText();
    if (ytext.length === 0 && content.length > 0) {
      this.doc.transact(() => {
        ytext.insert(0, content);
      }, 'seed');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  isSynced(): boolean {
    return this.synced;
  }

  destroy() {
    this.destroyed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this._handleWindowOffline);
      window.removeEventListener('online', this._handleWindowOnline);
    }
    if (this.solitarySyncTimer) {
      clearTimeout(this.solitarySyncTimer);
      this.solitarySyncTimer = null;
    }
    this.connected = false;
    this.synced = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Remove offline edit tracker if active
    this.doc.off('update', this._offlineEditTracker);

    // Remove awareness state
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], this);

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.awareness.destroy();
    this.doc.destroy();
  }
}

