package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNativePingCannotExtendProtocolPhase(t *testing.T) {
	for _, phase := range []string{"ready", "listening", "data", "agent", "pool"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var pongs atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{Subprotocols: []string{"codex-forward-v1", "codex-agent-v2", "codex-forward-pool-v1"}, CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				conn.SetPongHandler(func(string) error { pongs.Add(1); return nil })
				go func() {
					for {
						if _, _, err := conn.ReadMessage(); err != nil {
							return
						}
					}
				}()
				ticker := time.NewTicker(15 * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
						if conn.WriteControl(websocket.PingMessage, []byte("alive"), time.Now().Add(time.Second)) != nil {
							return
						}
					}
				}
			}))
			defer func() { cancel(); server.Close() }()
			target, _ := serverURL(server.URL)
			path := map[string]string{"ready": "/forward/resume", "listening": "/forward/resume", "data": "/forward/data", "agent": "/forward/agent", "pool": "/forward/transport"}[phase]
			conn, err := dialHeaders(ctx, target, path, strings.Repeat("a", 43), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			until := time.Now().Add(180 * time.Millisecond)
			done := make(chan error, 1)
			go func() {
				var err error
				switch phase {
				case "ready":
					_, err = readForwardReady(conn, until)
				case "listening":
					err = confirmListening(conn, readyMessage{}, until)
				default:
					_, _, err = readHandshake(conn, until)
				}
				done <- err
			}()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("missing phase confirmation was accepted")
				}
				if time.Now().Before(until.Add(-25 * time.Millisecond)) {
					t.Fatal("phase expired prematurely", err)
				}
			case <-time.After(650 * time.Millisecond):
				conn.Close()
				<-done
				t.Fatal("native Ping extended the absolute handshake budget")
			}
			if pongs.Load() == 0 {
				t.Fatal("bounded native Pong was lost during the handshake")
			}
		})
	}
}

func TestSuccessfulHandshakeRestoresNativeIdleKeepalive(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{Subprotocols: []string{"codex-forward-v1"}, CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.WriteMessage(websocket.TextMessage, []byte("ready"))
		<-release
		conn.WriteControl(websocket.PingMessage, []byte("active"), time.Now().Add(time.Second))
		// The old phase deadline expires; an active reader may still receive data.
		time.Sleep(200 * time.Millisecond)
		conn.WriteMessage(websocket.BinaryMessage, []byte("safe"))
	}))
	defer server.Close()
	target, _ := serverURL(server.URL)
	conn, err := dialHeaders(ctx, target, "/forward/data", strings.Repeat("a", 43), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, _, err = readHandshake(conn, time.Now().Add(150*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	close(release)
	kind, data, err := conn.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || string(data) != "safe" {
		t.Fatal("active native Ping failed to renew idle time", err)
	}
}
