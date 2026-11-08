package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestPreservedManagementResumeRejectsChangedDataScope(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*readyMessage)
	}{
		{"data-token", func(r *readyMessage) { r.StreamToken = strings.Repeat("d", 43) }},
		{"target", func(r *readyMessage) { r.TargetHost = "127.0.0.2" }},
		{"keep-protocol", func(r *readyMessage) { r.KeepStreamsProtocol = 0 }},
		{"direct-protocol", func(r *readyMessage) { r.DirectProtocol = 0 }},
		{"connection-limit", func(r *readyMessage) { r.MaxConnections = 1 }},
	} {
		t.Run(change.name, func(t *testing.T) {
			first := readyMessage{Type: "ready", Version: 1, ID: strings.Repeat("a", 32), StreamToken: strings.Repeat("c", 43), TargetHost: "127.0.0.1", TargetPort: 22, LocalPort: 2222, MaxConnections: 8, DirectProtocol: 1, KeepStreamsProtocol: 1, ResumeProtocol: 1, ResumeMs: 30000, ResumeToken: strings.Repeat("b", 43)}
			state := &resumeState{}
			if err := state.accept(first); err != nil {
				t.Fatal(err)
			}
			next := first
			next.ResumeToken = ""
			change.apply(&next)
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Path != "/forward/resume" || r.Header.Get("X-Codex-Forward-Keep-Streams") != "1" || r.Header.Get("Authorization") != "Bearer "+state.token {
					t.Error("Resume lost its scoped capability")
				}
				upgrader := websocket.Upgrader{Subprotocols: []string{"codex-forward-v1"}, CheckOrigin: func(*http.Request) bool { return true }}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				conn.WriteJSON(next)
				conn.ReadMessage()
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			link := &managementLink{ctx: ctx}
			address, _ := url.Parse(server.URL)
			_, err := resumeManagement(ctx, address, state, first, link, &runOutput{writer: &bytes.Buffer{}})
			if err == nil || canResume(err) || link.available() {
				t.Fatal("Changed scope kept data authorization or retried", err)
			}
			if requests.Load() != 1 {
				t.Fatal("Permanent rejection was retried")
			}
		})
	}
}

func TestCanceledManagementLinkCannotInstallANewControl(t *testing.T) {
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		conn.ReadMessage()
		close(closed)
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	link := &managementLink{ctx: ctx}
	if link.install(conn) == nil || link.conn != nil {
		t.Fatal("Canceled mapping installed a new control")
	}
	// A disconnected writer fails immediately, without retaining a signal queue.
	if link.available() || link.write(map[string]any{"type": "rtc_offer"}) == nil {
		t.Fatal("Canceled management accepted a new signal")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Canceled installation left its socket open")
	}
}
