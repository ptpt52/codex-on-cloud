package main

import (
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestPoolQueuedPongDoesNotBlockUnrelatedInboundData(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	sendData, written, pong := make(chan struct{}), make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.WriteJSON(map[string]any{"type": "pool-ready", "version": 1, "id": strings.Repeat("a", 32), "token": strings.Repeat("b", 43)})
		ws.WriteJSON(map[string]any{"type": "rtc_config", "enabled": false})
		ws.WriteJSON(map[string]any{"type": "pool-ping", "id": 1})
		select {
		case <-sendData:
		case <-ctx.Done():
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
		for {
			if kind, data, err := ws.ReadMessage(); err != nil {
				return
			} else if kind == websocket.TextMessage && string(data) == `{"id":1,"type":"pool-pong"}` {
				close(pong)
			}
		}
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	target, _ := serverURL(server.URL)
	pool := newTransportPool(ctx, target, agentGrant{Agent: strings.Repeat("a", 32)}, "", &agentOutput{writer: io.Discard})
	session := make(chan error, 1)
	go func() { session <- pool.session(conn, func() {}) }()
	defer func() {
		pool.cancel()
		conn.Close()
		<-session
		pool.mu.Lock()
		direct := pool.direct
		pool.mu.Unlock()
		if direct != nil {
			direct.Close()
		}
	}()
	deadline := time.Now().Add(time.Second)
	for len(pool.controls) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(pool.controls) != 1 {
		t.Fatal("Pong not queued")
	}
	channel := &relayChannel{pool: pool, conn: conn, id: 1, ready: true, opened: make(chan struct{})}
	channel.flow = newFlowChannel(channel, func() bool { return true })
	pool.mu.Lock()
	pool.channels[1] = channel
	pool.next = 1
	pool.mu.Unlock()
	close(sendData)
	<-written
	channel.flow.SetReadDeadline(time.Now().Add(time.Second))
	_, data, err := channel.flow.ReadMessage()
	if err != nil || string(data) != "data" {
		t.Fatalf("queued Pong held unrelated inbound data: %q %v", data, err)
	}
	if len(pool.controls) != 1 {
		t.Fatal("fixture resumed the writer before proving read progress")
	}
	go pool.writer()
	defer func() { pool.cancel(); <-pool.writerDone }()
	select {
	case <-pong:
	case <-ctx.Done():
		t.Fatal("queued Pong did not drain")
	}
}

func TestPoolPongQueueIsBoundedAndHealthWaitsForNativeWrite(t *testing.T) {
	pool, packets := openContextPool(t, nil)
	pool.mu.Lock()
	pool.healthAt = time.Time{}
	pool.mu.Unlock()
	if err := pool.queuePong(pool.conn, 1); err != nil {
		t.Fatal(err)
	}
	pool.mu.Lock()
	health := pool.healthAt
	pool.mu.Unlock()
	if !health.IsZero() {
		t.Fatal("unsent Pong made the pool healthy")
	}
	go pool.writer()
	t.Cleanup(func() { pool.cancel(); <-pool.writerDone })
	if got := string(<-packets); got != `{"id":1,"type":"pool-pong"}` {
		t.Fatal(got)
	}
	deadline := time.Now().Add(time.Second)
	for {
		pool.mu.Lock()
		healthy := !pool.healthAt.IsZero()
		pool.mu.Unlock()
		if healthy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completed Pong did not update health")
		}
		time.Sleep(time.Millisecond)
	}
	blocked, _ := openContextPool(t, nil)
	for id := uint32(1); id <= uint32(cap(blocked.controls)); id++ {
		if err := blocked.queuePong(blocked.conn, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := blocked.queuePong(blocked.conn, 129); err == nil {
		t.Fatal("Pong work escaped the control queue bound")
	}
}

func TestPoolExpiredPongClosesItsOldSocketAndNeverAReplacement(t *testing.T) {
	pool, _ := openContextPool(t, nil, 10*time.Second)
	replacement, packets := openContextPool(t, nil, 10*time.Second)
	old := pool.conn
	if err := pool.queuePong(old, 1); err != nil {
		t.Fatal(err)
	}
	queued := <-pool.controls
	pool.mu.Lock()
	pool.conn = replacement.conn
	pool.mu.Unlock()
	// Keep the queued record alive until its real five-second deadline. Its
	// timeout must close the captured old socket even without a running writer.
	<-queued.ctx.Done()
	deadline := time.Now().Add(time.Second)
	for old.WriteControl(websocket.PingMessage, nil, time.Now().Add(100*time.Millisecond)) == nil {
		if time.Now().After(deadline) {
			t.Fatal("expired Pong retained its socket")
		}
		time.Sleep(time.Millisecond)
	}
	if queued.ctx.Err() != context.DeadlineExceeded {
		t.Fatalf("old socket closed before its Pong deadline: %v", queued.ctx.Err())
	}
	queued.finish(queued.ctx.Err())
	go replacement.writer()
	t.Cleanup(func() { replacement.cancel(); <-replacement.writerDone })
	if err := replacement.write(websocket.TextMessage, []byte("replacement alive"), nil); err != nil {
		t.Fatal(err)
	}
	if got := string(<-packets); got != "replacement alive" {
		t.Fatal(got)
	}
}
