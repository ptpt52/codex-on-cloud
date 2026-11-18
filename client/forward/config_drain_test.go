package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func TestConfigurationDrainCannotBlockSharedReceive(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start, written, drained := make(chan struct{}), make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.WriteJSON(map[string]any{"type": "pool-ready", "version": 1, "id": strings.Repeat("a", 32), "token": strings.Repeat("b", 43)})
		select {
		case <-start:
		case <-ctx.Done():
			return
		}
		ws.WriteJSON(map[string]any{"type": "rtc_config", "enabled": true, "hints": map[string]string{"server": "127.0.0.2"}})
		frame := make([]byte, 9)
		frame[0] = 2
		binary.BigEndian.PutUint32(frame[1:5], 1)
		copy(frame[5:], "data")
		if ws.WriteMessage(websocket.BinaryMessage, frame) != nil {
			return
		}
		close(written)
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var record directSignal
			if json.Unmarshal(data, &record) == nil && record.Type == "rtc_drain" && record.ID == 7 {
				close(drained)
				return
			}
		}
	}))
	defer func() { cancel(); server.Close() }()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	target, _ := serverURL(server.URL)
	pool := newTransportPool(ctx, target, agentGrant{Agent: strings.Repeat("a", 32)}, "", &agentOutput{writer: io.Discard})
	pool.token = strings.Repeat("b", 43)
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	managerCtx, stopManager := context.WithCancel(ctx)
	manager := &directManager{ctx: managerCtx, cancel: stopManager, configured: true, config: directSignal{Enabled: true},
		peer: &directPeer{id: 7, pc: pc, streams: map[*directChannel]struct{}{nil: {}}},
		wake: make(chan struct{}, 1), answers: make(chan directSignal, 1), done: make(chan struct{}),
		write: func(value any) error {
			data, _ := json.Marshal(value)
			return pool.write(websocket.TextMessage, data, conn)
		}}
	pool.direct = manager
	go manager.run()
	done := make(chan error, 1)
	go func() { done <- pool.session(conn, func() {}) }()
	defer func() { cancel(); pool.cancel(); conn.Close(); <-done; manager.Close() }()
	channel := &relayChannel{pool: pool, conn: conn, id: 1, ready: true, opened: make(chan struct{})}
	channel.flow = newFlowChannel(channel, func() bool { return true })
	pool.mu.Lock()
	pool.channels[1] = channel
	pool.next = 1
	pool.mu.Unlock()
	close(start)
	select {
	case <-written:
	case <-ctx.Done():
		t.Fatal("fixture did not send data")
	}
	channel.flow.SetReadDeadline(time.Now().Add(time.Second))
	_, data, err := channel.flow.ReadMessage()
	if err != nil || string(data) != "data" {
		t.Fatalf("configuration held unrelated incoming data: %q %v", data, err)
	}
	deadline := time.Now().Add(time.Second)
	for len(pool.controls) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(pool.controls) != 1 {
		t.Fatal("drain was not queued independently of the reader")
	}
	go pool.writer()
	defer func() { pool.cancel(); <-pool.writerDone }()
	select {
	case <-drained:
	case <-ctx.Done():
		t.Fatal("configuration drain did not reach its peer")
	}
}

func TestConfigurationDrainCoalescesAndDiscardsRetiredGenerations(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	writes := make(chan any, 2)
	manager := &directManager{ctx: ctx, cancel: cancel, configured: true, config: directSignal{Enabled: true},
		peer: &directPeer{id: 7, pc: pc, streams: map[*directChannel]struct{}{nil: {}}},
		wake: make(chan struct{}, 1), done: make(chan struct{}), write: func(value any) error { writes <- value; return nil }}
	for n := 0; n < 100; n++ {
		value := directSignal{Type: "rtc_config", Enabled: true, HintRevision: strings.Repeat("a", n%2+1)}
		manager.accept(value)
	}
	if manager.drainID != 7 || len(writes) != 0 {
		t.Fatal("configuration reads wrote synchronously or escaped one mailbox")
	}
	// A retired generation must never send a drain for its replacement.
	manager.peer.id = 8
	go manager.run()
	defer manager.Close()
	deadline := time.Now().Add(time.Second)
	for {
		manager.mu.Lock()
		pending := manager.drainID
		manager.mu.Unlock()
		if pending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("mailbox did not drain")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-writes:
		t.Fatal("retired drain reached replacement")
	default:
	}
}
