package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// These are isolated loopback WebSocket fixtures. No target socket is opened.
func openContextPool(t *testing.T, beforeReady func()) (*transportPool, <-chan []byte) {
	t.Helper()
	packets := make(chan []byte, 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if kind == websocket.BinaryMessage && len(data) == 5 && data[0] == 4 {
				data[0] = 5
				if conn.WriteMessage(kind, data) != nil {
					return
				}
			} else {
				packets <- data
			}
		}
	}))
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	target, _ := serverURL(server.URL)
	pool := newTransportPool(ctx, target, agentGrant{}, "", &agentOutput{writer: io.Discard})
	pool.conn, pool.healthAt = conn, time.Now()
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil || kind != websocket.BinaryMessage || pool.receive(conn, data) != nil {
				return
			}
			if beforeReady != nil && data[0] == 5 {
				beforeReady()
			}
		}
	}()
	t.Cleanup(func() { cancel(); pool.cancel(); conn.Close(); <-readerDone; server.Close() })
	return pool, packets
}

func TestPoolOpenCancelledAtPreflightNeverDispatchesTarget(t *testing.T) {
	// Deliver preflight and cancel in the same reader turn before Open resumes.
	old := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(old)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pool, packets := openContextPool(t, cancel)
	go pool.writer()
	t.Cleanup(func() { pool.cancel(); <-pool.writerDone })
	stream, err := pool.Open(ctx, "synthetic-mapping", "synthetic-token", "")
	if stream != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled preflight admitted a target: %v", err)
	}
	// A succeeding control proves that the writer has drained earlier records.
	if err := pool.write(websocket.TextMessage, []byte("barrier"), nil); err != nil {
		t.Fatal(err)
	}
	for {
		got := <-packets
		if len(got) == 5 && got[0] == 3 {
			continue // Closing the confirmed preflight is valid.
		}
		if string(got) != "barrier" {
			t.Fatal("target-open escaped cancellation:", string(got))
		}
		break
	}
}

func TestPoolCancelledQueuedPreflightDoesNotCloseAnUnknownRemoteStream(t *testing.T) {
	pool, packets := openContextPool(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := pool.openRelay(ctx); done <- err }()
	limit := time.Now().Add(time.Second)
	for len(pool.controls) == 0 && time.Now().Before(limit) {
		time.Sleep(time.Millisecond)
	}
	if len(pool.controls) != 1 {
		t.Fatal("preflight did not reach the blocked writer")
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	pool.mu.Lock()
	retained := len(pool.channels)
	pool.mu.Unlock()
	if retained != 0 {
		t.Fatal("cancelled preflight retained a local stream")
	}
	go pool.writer()
	t.Cleanup(func() { pool.cancel(); <-pool.writerDone })
	if err := pool.write(websocket.TextMessage, []byte("barrier"), nil); err != nil {
		t.Fatal(err)
	}
	if got := string(<-packets); got != "barrier" {
		t.Fatal("cancelled preflight emitted an unknown stream frame:", got)
	}
}

func TestPoolAlreadyCancelledOpenDoesNotAllocateOrFallback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	pool := newTransportPool(context.Background(), nil, agentGrant{}, "", nil)
	defer pool.cancel()
	pool.conn, pool.healthAt = &websocket.Conn{}, time.Now()
	peer := &directPeer{channels: 128, available: true}
	pool.direct = &directManager{peer: peer, write: func(any) error { t.Fatal("cancelled dial changed peer state"); return nil }}
	stream, err := pool.Open(ctx, "mapping", "token", "")
	if stream != nil || !errors.Is(err, context.Canceled) || pool.next != 0 || peer.draining || !peer.available {
		t.Fatal("cancelled caller allocated a stream or revoked the shared peer")
	}
}

func TestPoolCallerCancellationDiscardsQueuedOpen(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[deadline], func(t *testing.T) {
			pool, packets := openContextPool(t, nil)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- pool.writeContext(ctx, websocket.TextMessage, []byte("forbidden open"), nil, time.Now().Add(5*time.Second))
			}()
			limit := time.Now().Add(time.Second)
			for len(pool.controls) == 0 && time.Now().Before(limit) {
				time.Sleep(time.Millisecond)
			}
			if len(pool.controls) != 1 {
				t.Fatal("open did not reach the blocked writer")
			}
			if !deadline {
				cancel()
			}
			if err := <-done; !errors.Is(err, ctx.Err()) {
				t.Fatalf("caller context not preserved: %v", err)
			}
			go pool.writer()
			t.Cleanup(func() { pool.cancel(); <-pool.writerDone })
			if err := pool.write(websocket.TextMessage, []byte("barrier"), nil); err != nil {
				t.Fatal(err)
			}
			if got := string(<-packets); got != "barrier" {
				t.Fatal("expired queued request reached the wire:", got)
			}
		})
	}
}

func TestRTCQueuedOpenHonorsCallerCancellationAndDeadline(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[deadline], func(t *testing.T) {
			w := newDirectWriter(context.Background())
			t.Cleanup(func() { w.close(); <-w.done })
			packets := make(chan string, 4)
			raw := &scheduledTestChannel{buffer: 192 * 1024, packets: packets}
			channel := w.channel(raw, false)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- channel.sendContextDeadline(ctx, []byte("forbidden open"), true, time.Now().Add(5*time.Second))
			}()
			limit := time.Now().Add(time.Second)
			for channel.BufferedAmount() == 192*1024 && time.Now().Before(limit) {
				time.Sleep(time.Millisecond)
			}
			if !deadline {
				cancel()
			}
			if err := <-done; !errors.Is(err, ctx.Err()) {
				t.Fatalf("caller context not preserved: %v", err)
			}
			raw.mu.Lock()
			raw.buffer = 0
			raw.mu.Unlock()
			w.notify()
			if err := channel.SendText("barrier"); err != nil {
				t.Fatal(err)
			}
			if got := <-packets; got != ":barrier" {
				t.Fatal("cancelled RTC request reached native send:", got)
			}
		})
	}
}

func TestCompletedOpenContextDoesNotOwnEstablishedStream(t *testing.T) {
	w := newDirectWriter(context.Background())
	t.Cleanup(func() { w.close(); <-w.done })
	packets := make(chan string, 4)
	c := newFlowChannel(w.channel(&scheduledTestChannel{packets: packets}, false), func() bool { return true })
	t.Cleanup(func() { c.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.writeMessageContext(ctx, websocket.TextMessage, []byte("open")); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := c.WriteMessage(websocket.BinaryMessage, []byte("business")); err != nil {
		t.Fatal("completed dial cancellation revoked established stream:", err)
	}
	for _, want := range []string{":open", ":business"} {
		if got := <-packets; got != want {
			t.Fatal("unexpected native write:", got)
		}
	}
}
