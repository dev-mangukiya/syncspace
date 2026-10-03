package realtime

import (
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type mockPersister struct {
	mu      sync.Mutex
	flushed map[string]string
}

func (m *mockPersister) PersistFileContent(workspaceSlug, filePath, content string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.flushed == nil {
		m.flushed = make(map[string]string)
	}
	m.flushed[workspaceSlug+":"+filePath] = content
	return nil
}

func TestHub_SeederCrashReElection(t *testing.T) {
	hub := NewHub()

	clientA := &Client{
		ID:        "client-A",
		UserID:    uuid.New(),
		Username:  "alice",
		Workspace: "ws-test",
		FilePath:  "main.py",
		Send:      make(chan []byte, 10),
		SendText:  make(chan []byte, 10),
		Hub:       hub,
	}

	clientB := &Client{
		ID:        "client-B",
		UserID:    uuid.New(),
		Username:  "bob",
		Workspace: "ws-test",
		FilePath:  "main.py",
		Send:      make(chan []byte, 10),
		SendText:  make(chan []byte, 10),
		Hub:       hub,
	}

	hub.Register(clientA)
	hub.Register(clientB)

	// Wait for registration
	time.Sleep(50 * time.Millisecond)

	// Check clientA got seed grant
	select {
	case msg := <-clientA.SendText:
		if string(msg) == "" {
			t.Fatal("expected seed grant for clientA")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for clientA seed grant")
	}

	// Client B should NOT have received seed grant yet
	select {
	case <-clientB.SendText:
		t.Fatal("clientB should not have received seed grant while clientA is active")
	default:
	}

	// Simulate Client A crash / unregister
	hub.Unregister(clientA)

	// Client B MUST be immediately re-elected as seeder
	select {
	case msg := <-clientB.SendText:
		if string(msg) == "" {
			t.Fatal("expected re-election seed grant for clientB")
		}
		t.Logf("Client B successfully received re-election grant: %s", string(msg))
	case <-time.After(500 * time.Millisecond):
		t.Fatal("clientB was NOT re-elected after clientA crash")
	}

	// Clean up
	hub.Unregister(clientB)
}

func TestHub_PersistOnRoomClose(t *testing.T) {
	hub := NewHub()
	persister := &mockPersister{flushed: make(map[string]string)}
	hub.Persister = persister

	client := &Client{
		ID:        "client-single",
		UserID:    uuid.New(),
		Username:  "alice",
		Workspace: "ws-persist",
		FilePath:  "script.js",
		Send:      make(chan []byte, 10),
		SendText:  make(chan []byte, 10),
		Hub:       hub,
	}

	hub.Register(client)
	time.Sleep(50 * time.Millisecond)

	// Simulate content snapshot sent by client during edit
	testContent := "console.log('persisted before drop');"
	hub.StoreRoomSnapshot("ws-persist", "script.js", testContent)

	// Simulate abrupt unregister (network drop / kill)
	hub.Unregister(client)
	time.Sleep(100 * time.Millisecond)

	persister.mu.Lock()
	saved, ok := persister.flushed["ws-persist:script.js"]
	persister.mu.Unlock()

	if !ok || saved != testContent {
		t.Fatalf("expected content to be flushed on room close, got ok=%v, content=%q", ok, saved)
	}
	t.Logf("Room eviction flushed content successfully: %q", saved)
}
