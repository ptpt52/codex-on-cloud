package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Exercise the production entry points, not just readHandshake. Removing the
// protected read from any caller must fail its own native Ping regression.
func TestNativePingCannotExtendSessionReady(t *testing.T) {
	for _, phase := range []string{"agent", "pool", "forward", "reverse"} {
		t.Run(phase, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			budget, path, protocol, code := 5*time.Second, "/forward/agent", "codex-agent-v2", "network_timeout"
			if phase == "pool" {
				path, protocol = "/forward/transport", "codex-forward-pool-v1"
			}
			if phase == "forward" || phase == "reverse" {
				budget, path, protocol, code = dataReadyTimeout, "/forward/data", "codex-forward-v1", "relay_ready_timeout"
			}
			var pongs, application, admitted, targetDials atomic.Int32
			upgraded := make(chan *websocket.Conn, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != path {
					t.Error("wrong production endpoint", r.URL.Path)
					w.WriteHeader(404)
					return
				}
				conn, err := (&websocket.Upgrader{Subprotocols: []string{protocol}, CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				upgraded <- conn
				conn.SetPongHandler(func(string) error { pongs.Add(1); return nil })
				readDone := make(chan struct{})
				go func() {
					defer close(readDone)
					for {
						if _, _, err := conn.ReadMessage(); err != nil {
							return
						}
						application.Add(1)
					}
				}()
				ticker := time.NewTicker(30 * time.Millisecond)
				defer ticker.Stop()
				// Withhold the application's ready record while the real native
				// connection remains responsive to control frames in both directions.
				for {
					select {
					case <-ctx.Done():
						conn.Close()
						<-readDone
						return
					case <-readDone:
						return
					case <-ticker.C:
						if conn.WriteControl(websocket.PingMessage, []byte("alive"), time.Now().Add(time.Second)) != nil {
							conn.Close()
							<-readDone
							return
						}
					}
				}
			}))
			defer func() { cancel(); server.Close() }()
			target, err := serverURL(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			active := &connections{items: make(map[*net.TCPConn]messageSocket)}
			defer active.close()
			local, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
			if err != nil {
				t.Fatal(err)
			}
			defer local.Close()
			acceptDone := make(chan struct{})
			accepted := make(chan *net.TCPConn, 1)
			go func() {
				defer close(acceptDone)
				conn, err := local.AcceptTCP()
				if err != nil {
					return
				}
				targetDials.Add(1)
				accepted <- conn
			}()
			defer func() {
				local.Close()
				<-acceptDone
				select {
				case conn := <-accepted:
					conn.Close()
				default:
				}
			}()
			var tcp *net.TCPConn
			if phase == "forward" {
				source, err := net.DialTCP("tcp4", nil, local.Addr().(*net.TCPAddr))
				if err != nil {
					t.Fatal(err)
				}
				defer source.Close()
				tcp = <-accepted
				if !active.add(tcp) {
					t.Fatal("fixture admission failed")
				}
				if _, err = source.Write([]byte("must wait for target ready")); err != nil {
					t.Fatal(err)
				}
			}
			done := make(chan error, 1)
			started := time.Now()
			go func() {
				switch phase {
				case "agent", "pool":
					conn, err := dialHeaders(ctx, target, path, strings.Repeat("a", 43), nil)
					if err != nil {
						done <- err
						return
					}
					defer conn.Close()
					if phase == "agent" {
						done <- agentSession(ctx, conn, agentGrant{}, target, nil, &managementLink{ctx: ctx}, nil, func() { admitted.Add(1) })
					} else {
						pool := newTransportPool(ctx, target, agentGrant{}, "", &agentOutput{writer: io.Discard})
						defer pool.cancel()
						done <- pool.session(conn, func() { admitted.Add(1) })
					}
				case "forward":
					done <- proxy(ctx, target, strings.Repeat("a", 43), tcp, active, nil)
				case "reverse":
					done <- reverseProxy(ctx, target, readyMessage{StreamToken: strings.Repeat("a", 43), TargetHost: "127.0.0.1", TargetPort: local.Addr().(*net.TCPAddr).Port}, strings.Repeat("b", 32), active, nil)
				}
			}()
			var conn *websocket.Conn
			select {
			case conn = <-upgraded:
			case err := <-done:
				t.Fatal("session never reached ready", err)
			case <-time.After(2 * time.Second):
				cancel()
				active.close()
				t.Fatal("native connection did not upgrade")
			}
			defer conn.Close()
			select {
			case err := <-done:
				var detail *diagnostic
				if !errors.As(err, &detail) || detail.code != code {
					t.Fatalf("wrong phase outcome: %v", err)
				}
				if time.Since(started) < budget-200*time.Millisecond {
					t.Fatal("session failed before its ready deadline", time.Since(started))
				}
			case <-time.After(time.Until(started.Add(budget + 2*time.Second))):
				cancel()
				active.close()
				conn.Close()
				select {
				case <-done:
				case <-time.After(time.Second):
				}
				t.Fatal("native Ping extended the production session's ready deadline")
			}
			if pongs.Load() == 0 {
				t.Fatal("fixture did not exchange native Pong controls")
			}
			if admitted.Load() != 0 || application.Load() != 0 {
				t.Fatal("unconfirmed ready admitted a session or replayed business bytes")
			}
			if phase == "reverse" && targetDials.Load() != 0 {
				t.Fatal("reverse target was dialed before ready")
			}
		})
	}
}
