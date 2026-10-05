# SyncSpace Architecture

## Overview

SyncSpace is a real-time collaborative code editor. The architecture has four main layers:

1. **Frontend** — Next.js React app with Monaco Editor, Yjs CRDT, and WebSocket sync
2. **WS Server** — Go service handling REST API, authentication, and WebSocket relay
3. **Exec Service** — Isolated Docker-based code execution sandbox
4. **Database** — PostgreSQL for persistence, Redis for cross-instance pub/sub

## Real-Time Collaboration

- Each file uses a separate Yjs `Y.Doc` with a `Y.Text` shared type (`content`)
- The Go server is a **dumb binary relay** — it does not parse Yjs internals
- All CRDT merge logic runs on the client via Yjs
- Awareness protocol provides cursor positions and user presence
- Seed lock mechanism ensures only the first joiner in an empty room seeds content

## WebSocket Authentication

- Clients request a single-use, time-limited ticket via `POST /api/ws-ticket`
- The ticket is consumed on WebSocket upgrade — no JWT in query strings
- Identity is stamped server-side from the ticket, preventing spoofing

## Demo Bot (Ghost Collaborator)

A Node-based service (`services/demo-bot/`) that connects as a scripted
collaborator to demo workspaces. Server-side enforcement guarantees:

- Bot cannot join or be invited into non-demo workspaces (HTTP 403)
- Bot is visually labeled with a purple `🤖 BOT` badge — never presentable as human
- `is_demo` is NOT client-settable at workspace creation — the field is
  excluded from the `POST /api/workspaces` request schema. Only the owner-only
  `POST /{slug}/demo` endpoint can toggle it.

---

## ⚠️ Landing-Page Demo: Gap to Target Experience

> **Status: NOT YET BUILT**

This phase proves the **bot collaboration mechanism** works:
- Scripted bot joins demo workspaces, types fixes, shows cursor presence
- Server-side isolation prevents bot from accessing non-demo data
- Three-party CRDT convergence verified (Alice + Bob + Bot → byte-identical)

However, the **actual zero-friction landing-page demo experience** does not
exist yet and depends on two unbuilt prerequisites:

1. **Guest Mode** — anonymous visitors must be able to open a demo workspace
   without signup. Today, all WebSocket access requires authentication via
   `POST /api/ws-ticket`, which requires a valid session cookie from login/signup.

2. **Canonical Demo Workspace** — a server-seeded, always-available demo workspace
   (not user-created). Today, demo workspaces are created by authenticated users
   and toggled via the `SetDemo` endpoint.

**Why this matters:** The eventual landing-page "Try it now" button must NOT
route visitors through the normal signup flow. It should provide instant access
to a pre-seeded demo workspace with the bot already ready to join. Implementing
this incorrectly (e.g., auto-creating accounts, sharing credentials) would
create security and UX debt.

**Planned approach (not yet implemented):**
- A `/demo` route that provisions a temporary anonymous session
- A pre-seeded canonical demo workspace that resets periodically
- Rate limiting and abuse prevention for anonymous access

---

## ⚠️ Known Limitation: Non-Overlapping Offline Merge Data Loss

> **Status: CONFIRMED GAP — tracked debt, pre-launch fix required**

### The Problem

When two users go offline, edit independently, and reconnect at non-overlapping
times (i.e., neither is ever in the room while the other is connected), **the
last user to flush overwrites the first user's edits in Postgres**. This was
confirmed by `test-data-loss-probe.mjs` (Scenario 3).

### Mechanism

The persistence layer stores **flattened text**, not Yjs CRDT state:

1. Alice reconnects alone → pushes her Y.Doc changes to the server → her
   `content_snapshot` (flattened text) is written to Postgres. ✅ Alice's edit
   is in Postgres at this point.
2. Alice closes her tab (Y.Doc destroyed, WS closed).
3. Bob reconnects alone. The server relay has no buffered Yjs updates (it's a
   dumb relay, not a Yjs-aware peer). Bob's Y.Doc still contains only his own
   offline edits + the original content — it **never received Alice's edit**.
4. Bob's `content_snapshot` overwrites Alice's version in Postgres.
   ❌ **Alice's edit is lost.**

The Yjs CRDT itself handles this merge perfectly — if Alice and Bob are ever
simultaneously connected, the relay forwards sync messages and both Y.Docs
converge. The gap is only in the **Postgres persistence path**, which is a
simple `UPDATE files SET content = $1` — no merge, no version check.

### Why This Happens

Four persistence paths exist, and all are last-write-wins:

| Path | Trigger | SQL |
|------|---------|-----|
| `content_snapshot` WS text frame | 300ms debounce on `doc.update` | Via `StoreRoomSnapshot` → room eviction → `PersistFileContent` |
| REST `PUT /file` | 3s debounce in `useTabManager` | `UPDATE files SET content = $1` |
| `beacon-persist` | `beforeunload` / `pagehide` | `UPDATE files SET content = $1` |
| Room eviction flush | Last client leaves room | `UPDATE files SET content = $1` |

### Pre-Launch Fix

True asynchronous multi-party offline merge requires one of:

1. **Server-side persistent Y.Doc** — the server maintains a Y.Doc per file
   (e.g., using `y-leveldb` or `y-postgresql`). When any client reconnects,
   it syncs against the server's Y.Doc, which contains all previously-received
   updates. The server is a Yjs-aware peer, not a dumb relay.

2. **Append-only update log** — instead of storing flattened text, store
   individual Y.Doc updates in an append-only table. On reconnect, the client
   receives all accumulated updates and applies them to its local Y.Doc.
   Flattened text is derived on read, not stored on write.

Either approach eliminates the last-write-wins gap because the server retains
CRDT history, not just the latest snapshot.

### Current Workaround

The issue only manifests when two users **never overlap in the room**. In
practice, the 3-second debounce save and content_snapshot streaming mean that
if users are online at the same time for even a few seconds, the relay forwards
Yjs sync messages and both Y.Docs converge — the CRDT merge is correct. The
gap is specifically in the offline→Postgres→offline handoff path.

