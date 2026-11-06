package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestDataHandshakeAllowsSlowRelay(t *testing.T) {
	upgrader := websocket.Upgrader{Subprotocols: []string{"codex-forward-v1"}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(6 * time.Second):
		case <-r.Context().Done():
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			defer ws.Close()
			ws.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"ready\"}"))
		}
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, err := dial(ctx, u, "/forward/data", strings.Repeat("a", 43))
	if err != nil {
		t.Fatalf("A six-second relay handshake was rejected: %v", err)
	}
	defer ws.Close()
	_, bytes, err := ws.ReadMessage()
	if err != nil || string(bytes) != "{\"type\":\"ready\"}" {
		t.Fatalf("Relay lost readiness: %v", err)
	}
}
