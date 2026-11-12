package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestPooledTransportRetriesWhenDataReconnectPrecedesManagementEnrollment(t *testing.T) {
	var attempts atomic.Int32
	ready := make(chan struct{}, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/forward/transport" || r.Header.Get("X-Codex-Agent-Instance") != strings.Repeat("b", 32) || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 32)+"."+strings.Repeat("c", 43) {
			t.Error("pool identity was not pinned")
			w.WriteHeader(400)
			return
		}
		if attempts.Add(1) == 1 {
			w.Header().Set("X-Codex-Forward-Error", "helper_reconnecting")
			w.WriteHeader(409)
			return
		}
		upgrader := websocket.Upgrader{Subprotocols: []string{"codex-forward-pool-v1"}, CheckOrigin: func(*http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		conn.WriteJSON(map[string]any{"type": "pool-ready", "version": 1, "id": strings.Repeat("a", 32), "token": strings.Repeat("d", 43)})
		conn.WriteJSON(map[string]any{"type": "rtc_config", "enabled": false})
		conn.WriteJSON(map[string]any{"type": "pool-ping", "id": 1})
		_, data, err := conn.ReadMessage()
		var pong struct {
			Type string `json:"type"`
			ID   int    `json:"id"`
		}
		if err != nil || json.Unmarshal(data, &pong) != nil || pong.Type != "pool-pong" || pong.ID != 1 {
			t.Error("standby did not prove application health")
			return
		}
		ready <- struct{}{}
		conn.ReadMessage()
	}))
	defer server.Close()
	url, _ := serverURL(server.URL)
	pool := newTransportPool(ctx, url, agentGrant{Agent: strings.Repeat("a", 32), Secret: strings.Repeat("c", 43)}, strings.Repeat("b", 32), &agentOutput{writer: io.Discard})
	pool.start()
	defer pool.close()
	select {
	case <-ready:
		if attempts.Load() != 2 {
			t.Fatal("unexpected reconnect count")
		}
	case <-ctx.Done():
		t.Fatal("data reconnect stopped before management enrollment recovered")
	}
}

func TestPoolWriterPrioritizesControlAndDiscardsExpiredOrOldConnectionRecords(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type packet struct {
		kind int
		data string
	}
	packets := make(chan packet, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for i := 0; i < 2; i++ {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			packets <- packet{kind, string(data)}
		}
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	url, _ := serverURL(server.URL)
	pool := newTransportPool(ctx, url, agentGrant{}, "", &agentOutput{writer: io.Discard})
	pool.conn = conn
	expired, stop := context.WithCancel(ctx)
	stop()
	request := func(scope context.Context, peer *websocket.Conn, kind int, value string) poolWrite {
		return poolWrite{ctx: scope, conn: peer, kind: kind, data: []byte(value), done: make(chan error, 1)}
	}
	old := request(ctx, &websocket.Conn{}, websocket.BinaryMessage, "must not replay")
	stale := request(expired, conn, websocket.TextMessage, "expired")
	data := request(ctx, conn, websocket.BinaryMessage, "business bytes")
	control := request(ctx, conn, websocket.TextMessage, "control first")
	pool.data <- old
	pool.data <- data
	pool.controls <- stale
	pool.controls <- control
	go pool.writer()
	defer func() { pool.cancel(); <-pool.writerDone }()
	for _, expected := range []packet{{websocket.TextMessage, "control first"}, {websocket.BinaryMessage, "business bytes"}} {
		select {
		case got := <-packets:
			if got != expected {
				t.Fatalf("wrong shared wire order: %+v", got)
			}
		case <-ctx.Done():
			t.Fatal("writer did not make progress")
		}
	}
	for _, item := range []struct {
		request  poolWrite
		rejected bool
	}{{old, true}, {stale, true}, {data, false}, {control, false}} {
		select {
		case err := <-item.request.done:
			if (err != nil) != item.rejected {
				t.Fatalf("wrong request result: %v", err)
			}
		case <-ctx.Done():
			t.Fatal("request result lost")
		}
	}
}
