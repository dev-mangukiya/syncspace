package handlers

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestRunHandler_UserRateLimit(t *testing.T) {
	h := NewRunHandler(nil, nil, "http://localhost:8081", "test-secret")
	userID := uuid.New()

	// Should allow first 10 runs
	for i := 1; i <= 10; i++ {
		if !h.CheckUserRateLimit(userID) {
			t.Fatalf("expected run %d to be allowed under rate limit", i)
		}
	}

	// 11th run within 60s window must be rejected
	if h.CheckUserRateLimit(userID) {
		t.Fatalf("expected 11th run to be rejected by rate limiter")
	}

	// Another user should still be allowed
	otherUser := uuid.New()
	if !h.CheckUserRateLimit(otherUser) {
		t.Fatalf("expected different user to have independent rate limit quota")
	}
}

func TestRunHandler_WorkspaceLock(t *testing.T) {
	h := NewRunHandler(nil, nil, "http://localhost:8081", "test-secret")
	wsID := uuid.New()

	ctx := context.Background()

	// First user acquires lock
	acquired, runner := h.AcquireWorkspaceLock(ctx, wsID, "alice", "run1")
	if !acquired {
		t.Fatalf("expected alice to acquire workspace lock")
	}
	if runner != "" {
		t.Fatalf("expected empty runner on successful acquire, got %s", runner)
	}

	// Second user attempts to acquire lock on same workspace
	acquired2, runner2 := h.AcquireWorkspaceLock(ctx, wsID, "bob", "run2")
	if acquired2 {
		t.Fatalf("expected bob to be rejected while alice is running")
	}
	if runner2 != "alice" {
		t.Fatalf("expected runner to be 'alice', got %s", runner2)
	}

	// Release lock
	h.ReleaseWorkspaceLock(wsID)

	// Now bob can acquire
	acquired3, _ := h.AcquireWorkspaceLock(ctx, wsID, "bob", "run3")
	if !acquired3 {
		t.Fatalf("expected bob to acquire lock after alice released it")
	}
	h.ReleaseWorkspaceLock(wsID)
}

func TestRunHandler_GlobalConcurrencyCap(t *testing.T) {
	h := NewRunHandler(nil, nil, "http://localhost:8081", "test-secret")

	// Acquire all 5 slots
	for i := 0; i < GlobalConcurrencyCap; i++ {
		select {
		case h.concurrencySem <- struct{}{}:
		default:
			t.Fatalf("failed to acquire concurrency slot %d", i)
		}
	}

	// 6th attempt must fail non-blocking
	select {
	case h.concurrencySem <- struct{}{}:
		t.Fatalf("expected 6th concurrency slot to be blocked by GlobalConcurrencyCap=5")
	default:
		// expected
	}

	// Release one slot
	<-h.concurrencySem

	// Now acquisition succeeds
	select {
	case h.concurrencySem <- struct{}{}:
		// success
	default:
		t.Fatalf("expected to acquire newly freed slot")
	}
}

func TestRunHandler_OutputCapping(t *testing.T) {
	// Verify MaxOutputCapBytes is 256KB
	if MaxOutputCapBytes != 256*1024 {
		t.Fatalf("expected MaxOutputCapBytes to be 256KB (262144 bytes), got %d", MaxOutputCapBytes)
	}

	// Simulate output capping logic
	var buf strings.Builder
	truncated := false
	chunk := strings.Repeat("A", 10*1024) // 10KB chunk

	for i := 0; i < 30; i++ { // 30 * 10KB = 300KB > 256KB
		if buf.Len()+len(chunk) <= MaxOutputCapBytes {
			buf.WriteString(chunk)
		} else if !truncated {
			remaining := MaxOutputCapBytes - buf.Len()
			if remaining > 0 {
				buf.WriteString(chunk[:remaining])
			}
			truncated = true
		}
	}

	if !truncated {
		t.Fatalf("expected output exceeding 256KB to be marked truncated")
	}
	if buf.Len() != MaxOutputCapBytes {
		t.Fatalf("expected capped buffer length to equal %d, got %d", MaxOutputCapBytes, buf.Len())
	}
}
