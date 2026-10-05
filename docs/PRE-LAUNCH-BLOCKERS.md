# SyncSpace — Pre-Launch Blockers & Tracked Debt

> Items that **must** be resolved before production launch.

---

## 🚫 BLOCKER-001: Non-Overlapping Offline Merge Data Loss

**Status:** CONFIRMED — test evidence in `tests/test-data-loss-probe.mjs`
**Severity:** PRE-LAUNCH BLOCKING
**Documented in:** `ARCHITECTURE.md` §"Known Limitation: Non-Overlapping Offline Merge Data Loss"

### Problem

When two users go offline, edit independently, and reconnect at non-overlapping
times (neither is ever in the room while the other is connected), the last user
to flush **overwrites** the first user's edits in Postgres. Alice's edit is
silently lost.

### Root Cause

The persistence layer stores flattened text (`UPDATE files SET content = $1`),
not Yjs CRDT state. The server is a dumb binary relay — it does not maintain a
server-side Y.Doc and does not buffer Yjs updates for offline peers. When Bob
reconnects alone, his Y.Doc never received Alice's edit, so his flattened-text
flush erases it.

All four persistence paths are last-write-wins:
- `content_snapshot` WS text frame → `StoreRoomSnapshot` → room eviction flush
- REST `PUT /file` (3s debounce in `useTabManager`)
- `beacon-persist` (`beforeunload` / `pagehide`)
- Room eviction flush (last client leaves)

### Fix Options (identified, not yet implemented)

1. **Server-side persistent Y.Doc** — The server maintains a Y.Doc per file
   (e.g., `y-leveldb`, `y-postgresql`, or the Yjs `y-protocols` persistence
   adapter). When any client reconnects, it syncs against the server's Y.Doc,
   which already contains all previously-received updates. The server becomes a
   Yjs-aware peer rather than a dumb relay.

2. **Append-only update log** — Instead of storing flattened text, store
   individual Y.Doc binary updates in an append-only table
   (`file_id, update_bytes, seq, created_at`). On reconnect, the server sends
   all accumulated updates to the client, which applies them to its local
   Y.Doc. Flattened text is derived on read (for REST API / editor seeding),
   never stored as the canonical source.

Either approach eliminates the gap because the server retains CRDT history, not
just the latest text snapshot.

### Current Workaround

The gap only manifests when users **never overlap in the room**. If both are
online simultaneously for even a few seconds, the relay forwards Yjs sync
messages and the CRDT merge is correct. In practice, the 3-second debounce and
300ms content_snapshot streaming provide ample opportunity for convergence when
users are concurrently connected.
