package realtime

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// RedisRelay fans out Yjs binary messages across multiple ws-server instances
// via Redis Pub/Sub. Each instance publishes incoming binary frames to a Redis
// channel keyed by (workspace, file), and subscribes to receive frames from
// other instances. This enables horizontal scaling.
type RedisRelay struct {
	client *redis.Client
	hub    *Hub
	ctx    context.Context
	cancel context.CancelFunc
	subs   map[roomKey]*redis.PubSub
	wsSubs map[string]*redis.PubSub
}

// NewRedisRelay creates a new Redis relay. Pass "" for redisURL to disable Redis.
func NewRedisRelay(hub *Hub, redisURL string) *RedisRelay {
	if redisURL == "" {
		log.Println("[Redis] No REDIS_URL set — running in single-instance mode (no cross-instance sync)")
		return nil
	}

	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Printf("[Redis] Failed to parse REDIS_URL: %v — running in single-instance mode", err)
		return nil
	}

	client := redis.NewClient(opts)
	ctx, cancel := context.WithCancel(context.Background())

	// Verify connection
	if err := client.Ping(ctx).Err(); err != nil {
		log.Printf("[Redis] Failed to connect: %v — running in single-instance mode", err)
		cancel()
		return nil
	}

	log.Printf("[Redis] Connected to %s — cross-instance sync enabled", redisURL)

	rr := &RedisRelay{
		client: client,
		hub:    hub,
		ctx:    ctx,
		cancel: cancel,
		subs:   make(map[roomKey]*redis.PubSub),
		wsSubs: make(map[string]*redis.PubSub),
	}

	return rr
}

// channelKey returns the Redis channel name for a (workspace, file) room
func channelKey(rk roomKey) string {
	return "yjs:" + rk.Workspace + ":" + rk.FilePath
}

// Publish sends a binary frame to Redis so other instances can relay it
func (rr *RedisRelay) Publish(client *Client, data []byte) {
	if rr == nil {
		return
	}
	rk := roomKey{Workspace: client.Workspace, FilePath: client.FilePath}
	// Prefix with the client ID so we can skip echoing back to the original sender's instance
	// Format: clientID (36 bytes UUID) + data
	msg := make([]byte, len(client.ID)+len(data))
	copy(msg, client.ID)
	copy(msg[len(client.ID):], data)
	rr.client.Publish(rr.ctx, channelKey(rk), msg)
}

// Subscribe starts listening for messages from other instances for a room
func (rr *RedisRelay) Subscribe(rk roomKey) {
	if rr == nil {
		return
	}
	if _, exists := rr.subs[rk]; exists {
		return // Already subscribed
	}

	channel := channelKey(rk)
	sub := rr.client.Subscribe(rr.ctx, channel)
	rr.subs[rk] = sub

	go func() {
		ch := sub.Channel()
		for msg := range ch {
			payload := []byte(msg.Payload)
			if len(payload) <= 36 {
				continue // Too short, skip
			}
			senderID := string(payload[:36])
			data := payload[36:]

			// Broadcast to all LOCAL clients in this room, EXCEPT the original sender
			rr.hub.mu.RLock()
			clients := rr.hub.rooms[rk]
			for c := range clients {
				if c.ID == senderID {
					continue // Don't echo back to sender
				}
				select {
				case c.Send <- data:
				default:
					log.Printf("[Redis] Dropping message for slow client %s", c.Username)
				}
			}
			rr.hub.mu.RUnlock()
		}
	}()

	log.Printf("[Redis] Subscribed to channel %s", channel)
}

// Unsubscribe stops listening for a room (when no more local clients)
func (rr *RedisRelay) Unsubscribe(rk roomKey) {
	if rr == nil {
		return
	}
	if sub, exists := rr.subs[rk]; exists {
		sub.Close()
		delete(rr.subs, rk)
		log.Printf("[Redis] Unsubscribed from channel %s", channelKey(rk))
	}
}

// workspaceChannelKey returns the Redis channel name for workspace control messages (chat, file events)
func workspaceChannelKey(workspace string) string {
	return "ws_ctrl:" + workspace
}

// PublishWorkspace sends a text/JSON control message to Redis for cross-instance relay
func (rr *RedisRelay) PublishWorkspace(workspace string, instanceID string, data []byte) {
	if rr == nil {
		return
	}
	// Prefix with instanceID so the publishing instance doesn't re-broadcast to its own clients
	msg := make([]byte, len(instanceID)+1+len(data))
	copy(msg, instanceID+":")
	copy(msg[len(instanceID)+1:], data)
	rr.client.Publish(rr.ctx, workspaceChannelKey(workspace), msg)
}

// SubscribeWorkspace starts listening for workspace control events from other instances
func (rr *RedisRelay) SubscribeWorkspace(workspace string, instanceID string) {
	if rr == nil {
		return
	}
	if rr.wsSubs == nil {
		rr.wsSubs = make(map[string]*redis.PubSub)
	}
	if _, exists := rr.wsSubs[workspace]; exists {
		return
	}

	channel := workspaceChannelKey(workspace)
	sub := rr.client.Subscribe(rr.ctx, channel)
	rr.wsSubs[workspace] = sub

	go func() {
		ch := sub.Channel()
		for msg := range ch {
			payload := []byte(msg.Payload)
			idx := bytes.IndexByte(payload, ':')
			if idx == -1 {
				continue
			}
			senderInstance := string(payload[:idx])
			if senderInstance == instanceID {
				continue // Don't re-broadcast our own messages
			}
			data := payload[idx+1:]
			rr.hub.BroadcastToWorkspaceLocal(workspace, data)
		}
	}()
	log.Printf("[Redis] Subscribed to workspace channel %s", channel)
}

// UnsubscribeWorkspace stops listening for workspace control events
func (rr *RedisRelay) UnsubscribeWorkspace(workspace string) {
	if rr == nil {
		return
	}
	if sub, exists := rr.wsSubs[workspace]; exists {
		sub.Close()
		delete(rr.wsSubs, workspace)
		log.Printf("[Redis] Unsubscribed from workspace channel %s", workspaceChannelKey(workspace))
	}
}

// Close shuts down the Redis relay
func (rr *RedisRelay) Close() {
	if rr == nil {
		return
	}
	rr.cancel()
	for rk, sub := range rr.subs {
		sub.Close()
		delete(rr.subs, rk)
	}
	for w, sub := range rr.wsSubs {
		sub.Close()
		delete(rr.wsSubs, w)
	}
	rr.client.Close()
}

// Client returns the underlying Redis client (for use by RedisTicketStore)
func (rr *RedisRelay) Client() *redis.Client {
	if rr == nil {
		return nil
	}
	return rr.client
}

// ── Redis-backed ticket store ───────────────────────────────

// RedisTicketStore implements TicketIssuer using Redis SETEX + GETDEL.
// This allows tickets issued on one instance to be consumed on another,
// which is required for correct behavior behind a load balancer.
type RedisTicketStore struct {
	client *redis.Client
	ctx    context.Context
}

// NewRedisTicketStore creates a ticket store backed by Redis
func NewRedisTicketStore(client *redis.Client) TicketIssuer {
	return &RedisTicketStore{
		client: client,
		ctx:    context.Background(),
	}
}

func (rs *RedisTicketStore) Issue(userID uuid.UUID, username string) string {
	ticketID := uuid.New().String()
	ticket := Ticket{UserID: userID, Username: username}
	data, _ := json.Marshal(ticket)

	// SETEX: set with 10-second expiry (Redis handles cleanup automatically)
	key := "ws_ticket:" + ticketID
	rs.client.SetEx(rs.ctx, key, string(data), 10*time.Second)

	return ticketID
}

func (rs *RedisTicketStore) Consume(ticketID string) *Ticket {
	key := "ws_ticket:" + ticketID

	// GETDEL: atomic get-and-delete — prevents race between two simultaneous
	// consume attempts on the same ticket. Only one caller gets the value;
	// the other gets nil. This is the Redis equivalent of the in-memory
	// lock-then-delete pattern.
	result, err := rs.client.GetDel(rs.ctx, key).Result()
	if err != nil {
		return nil // Not found or expired (Redis already deleted it via TTL)
	}

	var ticket Ticket
	if err := json.Unmarshal([]byte(result), &ticket); err != nil {
		return nil
	}
	return &ticket
}

// NewTicketStore creates the appropriate ticket store based on Redis availability.
// If Redis is connected, returns a Redis-backed store (for multi-instance deployments).
// If Redis is not available, returns an in-memory store (single-instance only).
func NewTicketStore(relay *RedisRelay) TicketIssuer {
	if relay != nil && relay.Client() != nil {
		log.Println("[Tickets] Using Redis-backed ticket store (cross-instance)")
		return NewRedisTicketStore(relay.Client())
	}
	log.Println("[Tickets] Using in-memory ticket store (single-instance)")
	return NewMemoryTicketStore()
}
