package realtime

import (
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
)

// roomKey identifies a collaborative editing room
type roomKey struct {
	Workspace string
	FilePath  string
}

// Client represents a single WebSocket connection
type Client struct {
	ID        string
	UserID    uuid.UUID
	Username  string
	Workspace string
	FilePath  string // Which file this connection is editing
	ColorSlot int
	Send      chan []byte // Binary (Yjs sync/awareness) messages
	SendText  chan []byte // Text (JSON control) messages — file tree events, etc.
	Hub       *Hub
}

// PresenceInfo represents a single online user for workspace-level presence
type PresenceInfo struct {
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	File      string `json:"file"`
	ColorSlot int    `json:"color_slot"`
}

// Hub manages all WebSocket connections, organized by (workspace, file) rooms
// It relays opaque binary Yjs messages — it does NOT parse Yjs internals.
// This is intentional: the Go server is a dumb relay, and the CRDT merge
// logic lives entirely in the Yjs library on each client.
type Hub struct {
	mu         sync.RWMutex
	instanceID string
	rooms      map[roomKey]map[*Client]bool   // per-file rooms for Yjs relay
	workspaces map[string]map[*Client]bool    // per-workspace for presence
	colorSeq   map[string]int                 // workspace -> next color slot
	register   chan *Client
	unregister chan *Client
	Redis      *RedisRelay                    // nil if Redis not configured
}

// NewHub creates and starts a new Hub
func NewHub() *Hub {
	h := &Hub{
		instanceID: uuid.New().String()[:8],
		rooms:      make(map[roomKey]map[*Client]bool),
		workspaces: make(map[string]map[*Client]bool),
		colorSeq:   make(map[string]int),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
	go h.run()
	return h
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			// Add to room
			rk := roomKey{Workspace: client.Workspace, FilePath: client.FilePath}
			if h.rooms[rk] == nil {
				h.rooms[rk] = make(map[*Client]bool)
			}
			h.rooms[rk][client] = true

			// Add to workspace presence
			if h.workspaces[client.Workspace] == nil {
				h.workspaces[client.Workspace] = make(map[*Client]bool)
			}
			// Assign color slot
			client.ColorSlot = h.colorSeq[client.Workspace] % 8
			h.colorSeq[client.Workspace]++
			h.workspaces[client.Workspace][client] = true

			roomCount := len(h.rooms[rk])
			wsCount := len(h.workspaces[client.Workspace])
			// Subscribe to Redis channel when first local client joins a room
			if roomCount == 1 && h.Redis != nil {
				h.Redis.Subscribe(rk)
			}
			// Subscribe to workspace Redis channel when first local client joins workspace
			if wsCount == 1 && h.Redis != nil {
				h.Redis.SubscribeWorkspace(client.Workspace, h.instanceID)
			}
			h.mu.Unlock()

			log.Printf("[WS] %s joined room %s:%s (%d in room, %d in workspace)",
				client.Username, client.Workspace, client.FilePath, roomCount, wsCount)

		case client := <-h.unregister:
			h.mu.Lock()
			// Remove from room
			rk := roomKey{Workspace: client.Workspace, FilePath: client.FilePath}
			if clients, ok := h.rooms[rk]; ok {
				if _, exists := clients[client]; exists {
					delete(clients, client)
					close(client.Send)
					if len(clients) == 0 {
						delete(h.rooms, rk)
						// Unsubscribe from Redis when last local client leaves
						if h.Redis != nil {
							h.Redis.Unsubscribe(rk)
						}
					}
				}
			}

			// Remove from workspace presence
			if clients, ok := h.workspaces[client.Workspace]; ok {
				delete(clients, client)
				if len(clients) == 0 {
					delete(h.workspaces, client.Workspace)
					delete(h.colorSeq, client.Workspace)
					if h.Redis != nil {
						h.Redis.UnsubscribeWorkspace(client.Workspace)
					}
				}
			}

			roomCount := len(h.rooms[rk])
			h.mu.Unlock()

			log.Printf("[WS] %s left room %s:%s (%d remaining)",
				client.Username, client.Workspace, client.FilePath, roomCount)
		}
	}
}

// Register adds a client to its room and workspace
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister removes a client
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

// BroadcastToRoom sends an opaque binary message to all clients in the same
// (workspace, file) room, excluding the sender. Also publishes to Redis for
// cross-instance relay. The Go server treats these as opaque byte slices and
// never parses Yjs internals.
func (h *Hub) BroadcastToRoom(client *Client, data []byte) {
	h.mu.RLock()
	rk := roomKey{Workspace: client.Workspace, FilePath: client.FilePath}
	clients := h.rooms[rk]
	for c := range clients {
		if c == client {
			continue
		}
		select {
		case c.Send <- data:
		default:
			log.Printf("[WS] Dropping message for slow client %s in %s:%s",
				c.Username, client.Workspace, client.FilePath)
		}
	}
	h.mu.RUnlock()

	// Publish to Redis for cross-instance relay
	if h.Redis != nil {
		h.Redis.Publish(client, data)
	}
}

// GetWorkspacePresence returns all online users in a workspace
func (h *Hub) GetWorkspacePresence(workspace string) []PresenceInfo {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients := h.workspaces[workspace]
	seen := make(map[string]bool)
	users := make([]PresenceInfo, 0, len(clients))
	for c := range clients {
		// Deduplicate by user_id (a user may have multiple file connections)
		if seen[c.UserID.String()] {
			continue
		}
		seen[c.UserID.String()] = true
		users = append(users, PresenceInfo{
			UserID:    c.UserID.String(),
			Username:  c.Username,
			File:      c.FilePath,
			ColorSlot: c.ColorSlot,
		})
	}
	return users
}

// BroadcastToWorkspaceLocal sends a JSON control message to all clients on THIS instance.
func (h *Hub) BroadcastToWorkspaceLocal(workspace string, jsonMsg []byte) {
	h.mu.RLock()
	clients := h.workspaces[workspace]
	for c := range clients {
		select {
		case c.SendText <- jsonMsg:
		default:
			log.Printf("[WS] Dropping control event for slow client %s in %s",
				c.Username, workspace)
		}
	}
	h.mu.RUnlock()
}

// BroadcastToWorkspace sends a JSON control message to all clients connected
// to any file in this workspace locally, AND relays it via Redis to all other
// server instances so multi-instance setups stay synchronized.
// Control messages are sent as WebSocket TEXT frames via the SendText channel,
// structurally separate from Yjs binary (BINARY frames via Send channel).
func (h *Hub) BroadcastToWorkspace(workspace string, jsonMsg []byte) {
	h.BroadcastToWorkspaceLocal(workspace, jsonMsg)
	if h.Redis != nil {
		h.Redis.PublishWorkspace(workspace, h.instanceID, jsonMsg)
	}
}

// RoomClientCount returns how many clients are in a specific room
func (h *Hub) RoomClientCount(workspace, filePath string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[roomKey{Workspace: workspace, FilePath: filePath}])
}

// ── Connection tickets ──────────────────────────────────────

// Ticket is a short-lived, single-use token for WebSocket authentication.
// It replaces the previous raw-JWT-in-query-string approach which leaked the
// long-lived (24h) JWT into server logs, proxy logs, and browser history.
type Ticket struct {
	UserID   uuid.UUID `json:"user_id"`
	Username string    `json:"username"`
}

// TicketIssuer abstracts ticket issuance/consumption so we can swap
// in-memory (single instance) vs Redis (multi-instance) implementations.
type TicketIssuer interface {
	Issue(userID uuid.UUID, username string) string
	Consume(ticketID string) *Ticket
}

// ── In-memory ticket store (fallback when Redis is not available) ────

type memoryTicketStore struct {
	mu      sync.Mutex
	tickets map[string]*memTicket
}

type memTicket struct {
	Ticket
	Expiry time.Time
}

func NewMemoryTicketStore() TicketIssuer {
	ts := &memoryTicketStore{
		tickets: make(map[string]*memTicket),
	}
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		for range ticker.C {
			ts.mu.Lock()
			now := time.Now()
			for id, t := range ts.tickets {
				if now.After(t.Expiry) {
					delete(ts.tickets, id)
				}
			}
			ts.mu.Unlock()
		}
	}()
	return ts
}

func (ts *memoryTicketStore) Issue(userID uuid.UUID, username string) string {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	ticketID := uuid.New().String()
	ts.tickets[ticketID] = &memTicket{
		Ticket: Ticket{UserID: userID, Username: username},
		Expiry: time.Now().Add(10 * time.Second),
	}
	return ticketID
}

func (ts *memoryTicketStore) Consume(ticketID string) *Ticket {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	ticket, ok := ts.tickets[ticketID]
	if !ok {
		return nil
	}
	delete(ts.tickets, ticketID)
	if time.Now().After(ticket.Expiry) {
		return nil
	}
	return &ticket.Ticket
}
