package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type pongSocket struct {
	writes chan nativePong
	gate   chan struct{}
	closed chan struct{}
	once   sync.Once
	err    error
}

func (c *pongSocket) WriteControl(kind int, data []byte, deadline time.Time) error {
	if kind != websocket.PongMessage {
		return errors.New("unexpected control frame")
	}
	c.writes <- nativePong{data: append([]byte(nil), data...), deadline: deadline}
	timer := time.NewTimer(max(0, time.Until(deadline)))
	defer timer.Stop()
	select {
	case <-c.gate:
		return c.err
	case <-c.closed:
		return io.EOF
	case <-timer.C:
		return context.DeadlineExceeded
	}
}
func (c *pongSocket) Close() error { c.once.Do(func() { close(c.closed) }); return nil }
func newPongSocket() *pongSocket {
	return &pongSocket{writes: make(chan nativePong, 32), gate: make(chan struct{}), closed: make(chan struct{})}
}
func waitPongWorker(t *testing.T, w *nativePongWriter) {
	t.Helper()
	until := time.Now().Add(time.Second)
	for {
		w.mu.Lock()
		running := w.running
		w.mu.Unlock()
		if !running {
			return
		}
		if time.Now().After(until) {
			t.Fatal("idle Pong worker retained")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestNativePongQueueBoundIncludesInFlightWrite(t *testing.T) {
	c := newPongSocket()
	defer c.Close()
	w := &nativePongWriter{conn: c}
	if err := w.enqueue("first"); err != nil {
		t.Fatal(err)
	}
	<-c.writes
	for n := 1; n < nativePongLimit; n++ {
		if err := w.enqueue("queued"); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.enqueue("excess"); err == nil {
		t.Fatal("unbounded protocol Pong queue")
	}
	select {
	case <-c.closed:
	default:
		t.Fatal("overloaded original socket retained")
	}
	waitPongWorker(t, w)
}

func TestNativePongsPreservePayloadOrderAndOriginalDeadlines(t *testing.T) {
	c := newPongSocket()
	defer c.Close()
	w := &nativePongWriter{conn: c}
	started := time.Now()
	for _, text := range []string{"one", "two", "three"} {
		if err := w.enqueue(text); err != nil {
			t.Fatal(err)
		}
	}
	enqueuedAt := time.Now()
	first := <-c.writes
	time.Sleep(20 * time.Millisecond)
	close(c.gate)
	for n, record := range []nativePong{first, <-c.writes, <-c.writes} {
		if string(record.data) != []string{"one", "two", "three"}[n] {
			t.Fatal("Pong reordered")
		}
		if record.deadline.Before(started.Add(nativePongTimeout)) || record.deadline.After(enqueuedAt.Add(nativePongTimeout)) {
			t.Fatal("Pong deadline renewed after waiting")
		}
	}
	waitPongWorker(t, w)
	select {
	case <-c.closed:
		t.Fatal("healthy socket closed")
	default:
	}
}

func TestNativePongFailureClosesOnlyItsOriginalSocket(t *testing.T) {
	old, replacement := newPongSocket(), newPongSocket()
	defer old.Close()
	defer replacement.Close()
	old.err = io.EOF
	close(old.gate)
	close(replacement.gate)
	a, b := &nativePongWriter{conn: old}, &nativePongWriter{conn: replacement}
	if err := a.enqueue("old"); err != nil {
		t.Fatal(err)
	}
	if err := b.enqueue("new"); err != nil {
		t.Fatal(err)
	}
	<-old.writes
	<-replacement.writes
	waitPongWorker(t, a)
	waitPongWorker(t, b)
	select {
	case <-old.closed:
	default:
		t.Fatal("failed socket retained")
	}
	select {
	case <-replacement.closed:
		t.Fatal("old failure closed replacement")
	default:
	}
}

// Actual Gorilla reader/writer contention on loopback. All business records
// retain their 16 KiB bound; no target, desktop or external network is used.
func TestNativePingCannotBlockUnrelatedPoolData(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	start, drain, written := make(chan struct{}), make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{Subprotocols: []string{"codex-forward-pool-v1"}, CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.UnderlyingConn().(*net.TCPConn).SetReadBuffer(1024)
		ws.WriteJSON(map[string]any{"type": "pool-ready", "version": 1, "id": strings.Repeat("a", 32), "token": strings.Repeat("b", 43)})
		select {
		case <-start:
		case <-ctx.Done():
			return
		}
		if ws.WriteControl(websocket.PingMessage, []byte("native-probe"), time.Now().Add(time.Second)) != nil {
			return
		}
		frame := make([]byte, 9)
		frame[0] = 2
		binary.BigEndian.PutUint32(frame[1:5], 1)
		copy(frame[5:], "data")
		if ws.WriteMessage(websocket.BinaryMessage, frame) != nil {
			return
		}
		close(written)
		select {
		case <-drain:
		case <-ctx.Done():
			return
		}
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer func() { cancel(); server.Close() }()
	target, _ := serverURL(server.URL)
	conn, err := dialHeaders(ctx, target, "/forward/transport", strings.Repeat("a", 43), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.UnderlyingConn().(*net.TCPConn).SetWriteBuffer(1024)
	pool := newTransportPool(ctx, target, agentGrant{Agent: strings.Repeat("a", 32)}, "", &agentOutput{writer: io.Discard})
	pool.token = strings.Repeat("b", 43)
	pool.direct = &directManager{ctx: ctx, wake: make(chan struct{}, 1), answers: make(chan directSignal, 1)}
	done := make(chan error, 1)
	go func() { done <- pool.session(conn, func() {}) }()
	defer func() { pool.cancel(); conn.Close(); <-done }()
	channel := &relayChannel{pool: pool, conn: conn, id: 1, ready: true, opened: make(chan struct{})}
	channel.flow = newFlowChannel(channel, func() bool { return true })
	pool.mu.Lock()
	pool.channels[1] = channel
	pool.next = 1
	pool.mu.Unlock()
	blocked := make(chan error, 1)
	conn.SetWriteDeadline(time.Now().Add(6 * time.Second))
	go func() {
		for n := 0; n < 32; n++ {
			if err := conn.WriteMessage(websocket.BinaryMessage, make([]byte, chunkSize)); err != nil {
				blocked <- err
				return
			}
		}
		blocked <- nil
	}()
	defer func() { conn.Close(); <-blocked }()
	select {
	case err := <-blocked:
		blocked <- err
		t.Fatalf("fixture writer did not block: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(start)
	select {
	case <-written:
	case <-ctx.Done():
		t.Fatal("fixture did not send incoming data")
	}
	select {
	case record := <-channel.flow.queue:
		if string(record.bytes) != "data" {
			t.Fatal("wrong business data")
		}
	case <-time.After(time.Second):
		t.Fatal("native Ping blocked unrelated incoming data")
	}
	close(drain)
}
