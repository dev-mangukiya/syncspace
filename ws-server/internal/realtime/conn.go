package realtime

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	// 4MB hard cap. Yjs sync-step-2 for a file encodes the entire document state,
	// so this needs to be larger than any reasonable source file. 4MB is generous
	// for code while still preventing abuse (a 4MB source file is ~100K lines).
	// Previous value was 64KB which would fail on any file over ~60KB.
	maxMessageSize = 4 * 1024 * 1024 // 4MB
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  16384, // 16KB
	WriteBufferSize: 16384, // 16KB
	CheckOrigin:     func(r *http.Request) bool { return true }, // CORS handled by middleware
}

// ServeWS upgrades an HTTP connection to a WebSocket and starts the binary relay.
// Identity comes from the consumed connection ticket, NOT from the WebSocket
// message payloads. The server is the authority on who this connection belongs to.
func ServeWS(hub *Hub, w http.ResponseWriter, r *http.Request, userID uuid.UUID, username, workspace, filePath string) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] upgrade error: %v", err)
		return
	}

	client := &Client{
		ID:        uuid.New().String(),
		UserID:    userID,
		Username:  username,
		Workspace: workspace,
		FilePath:  filePath,
		Send:      make(chan []byte, 256),
		SendText:  make(chan []byte, 64),
		Hub:       hub,
	}

	hub.Register(client)

	go client.writePump(conn)
	go client.readPump(conn)
}

// readPump reads binary messages from the WebSocket and broadcasts them to the room.
// It handles ALL messages as opaque binary — the Go server never parses Yjs internals.
// This is the key architectural decision: merge logic lives in the Yjs CRDT on each
// client, and the server is just a relay. This means:
// - Sync messages (state vectors, diffs) flow through unchanged
// - Awareness messages (cursors, selections) flow through unchanged
// - The server cannot tamper with or misinterpret the CRDT state
func (c *Client) readPump(conn *websocket.Conn) {
	defer func() {
		c.Hub.Unregister(c)
		conn.Close()
	}()

	conn.SetReadLimit(maxMessageSize)
	if err := conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		return
	}
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[WS] read error for %s: %v", c.Username, err)
			}
			break
		}

		// Binary messages carry Yjs sync and awareness protocols
		if messageType == websocket.BinaryMessage && len(data) > 0 {
			c.Hub.BroadcastToRoom(c, data)
		} else if messageType == websocket.TextMessage && len(data) > 0 {
			// Text messages carry control frames such as real-time content snapshots
			var msg struct {
				Type    string `json:"type"`
				Content string `json:"content"`
			}
			if err := json.Unmarshal(data, &msg); err == nil {
				if msg.Type == "content_snapshot" || msg.Type == "content_update" {
					c.Hub.StoreRoomSnapshot(c.Workspace, c.FilePath, msg.Content)
				}
			}
		}
	}
}

// writePump sends messages from Send (binary) and SendText (text) channels to the WebSocket.
// Binary messages carry Yjs sync/awareness data; text messages carry JSON control events
// (file tree changes). Using separate WebSocket frame types (BinaryMessage vs TextMessage)
// structurally eliminates any byte-level collision between Yjs protocol bytes and control
// message encoding — the distinction happens at the WebSocket frame layer, not content layer.
func (c *Client) writePump(conn *websocket.Conn) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if !ok {
				conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, message); err != nil {
				return
			}

		case textMsg := <-c.SendText:
			if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, textMsg); err != nil {
				return
			}

		case <-ticker.C:
			if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
