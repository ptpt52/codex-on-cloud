package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestFullOSDiagnosticPipeCannotBlockPoolReaderLivenessOrCancellation(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	fd := int(writer.Fd())
	if err = syscall.SetNonblock(fd, true); err != nil {
		t.Fatal(err)
	}
	for {
		_, err = syscall.Write(fd, make([]byte, 4096))
		if err == syscall.EAGAIN {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = syscall.SetNonblock(fd, false); err != nil {
		t.Fatal(err)
	}
	diagnostics := &diagnosticOutput{writer: writer}
	defer diagnostics.Close()
	output := &agentOutput{writer: diagnostics}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	peer := &directPeer{id: 7, ready: true, healthAt: time.Now()}
	direct := &directManager{ctx: ctx, peer: peer, wake: make(chan struct{}, 1), answers: make(chan directSignal, 1), report: func(text string) { fmt.Fprintln(output, text) }}
	pong := make(chan bool, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{Subprotocols: []string{"codex-forward-pool-v1"}, CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.WriteJSON(map[string]any{"type": "pool-ready", "version": 1, "id": strings.Repeat("a", 32), "token": strings.Repeat("b", 43)})
		conn.WriteJSON(map[string]any{"type": "rtc_status", "id": 7, "available": true, "healthy": true, "family": "IPv4"})
		conn.WriteJSON(map[string]any{"type": "pool-ping", "id": 1})
		_, data, err := conn.ReadMessage()
		var value struct {
			Type string `json:"type"`
			ID   int    `json:"id"`
		}
		pong <- err == nil && json.Unmarshal(data, &value) == nil && value.Type == "pool-pong" && value.ID == 1
		conn.ReadMessage()
	}))
	defer server.Close()
	target, _ := serverURL(server.URL)
	conn, err := dialHeaders(ctx, target, "/forward/transport", strings.Repeat("a", 43), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	pool := newTransportPool(ctx, target, agentGrant{Agent: strings.Repeat("a", 32)}, "", output)
	pool.token = strings.Repeat("b", 43)
	pool.direct = direct
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); pool.writer() }()
	done := make(chan error, 1)
	go func() { done <- pool.session(conn, func() {}) }()
	defer func() { pool.cancel(); conn.Close(); <-writerDone }()
	select {
	case ok := <-pong:
		if !ok {
			t.Fatal("status logging blocked or corrupted the application Pong")
		}
	case <-time.After(time.Second):
		t.Fatal("full OS output pipe blocked the pool reader")
	}
	alive := make(chan bool, 1)
	go func() { alive <- direct.peerAlive(peer) }()
	select {
	case ok := <-alive:
		if !ok {
			t.Fatal("healthy peer lost liveness")
		}
	case <-time.After(time.Second):
		t.Fatal("full output pipe held the peer lock")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancellation waited for diagnostic output")
	}
	closed := make(chan struct{})
	go func() { diagnostics.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("shutdown waited for the full output pipe")
	}
	// Release the test-only OS pipe so its one bounded worker also exits.
	reader.Close()
}
