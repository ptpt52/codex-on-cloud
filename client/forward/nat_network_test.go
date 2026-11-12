package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Invoked only by test:rtc:nat inside a private LAN behind kernel SNAT.
func TestNATPeerWorker(t *testing.T) {
	if os.Getenv("FORWARD_NAT_WORKER") != "1" {
		t.Skip("requires the isolated NAT network runner")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	var outputMu sync.Mutex
	output := json.NewEncoder(os.Stdout)
	write := func(value any) error {
		outputMu.Lock()
		defer outputMu.Unlock()
		return output.Encode(value)
	}
	manager := newDirectManager(ctx, strings.Repeat("t", 43), write, func() bool { return true }, func(string) {})
	defer manager.Close()
	go func() {
		input := json.NewDecoder(os.Stdin)
		for ctx.Err() == nil {
			var value directSignal
			if input.Decode(&value) != nil {
				return
			}
			manager.accept(value)
		}
	}()
	manager.accept(directSignal{Type: "rtc_config", Enabled: true, STUN: "stun:13.0.0.1:3478"})
	var stream *directChannel
	for stream == nil && ctx.Err() == nil {
		stream = manager.Open(ctx)
		if stream == nil {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if stream == nil {
		t.Fatal("Go helper could not open an authenticated NAT data channel")
	}
	defer stream.Close()
	stream.SetReadDeadline(time.Now().Add(5 * time.Second))
	stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := stream.WriteMessage(websocket.TextMessage, []byte(`{"type":"open"}`)); err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte{37}, 4096)
	for i := 0; i < 64; i++ {
		if err := stream.WriteMessage(websocket.BinaryMessage, payload); err != nil {
			t.Fatal(err)
		}
		kind, result, err := stream.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(result, payload) {
			t.Fatal("NAT data round trip failed", err)
		}
	}
	manager.mu.Lock()
	label := manager.lastStatus
	manager.mu.Unlock()
	if label != "directIPv4nat" {
		t.Fatalf("NAT path was not classified correctly: %s", label)
	}
	if err := write(map[string]any{"type": "done", "bytes": 262144}); err != nil {
		t.Fatal(err)
	}
}
