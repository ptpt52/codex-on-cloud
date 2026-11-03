package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestRejectedPairingExplainsCauseWithoutLeakingPeerText(t *testing.T) {
	for _, sample := range []struct {
		code, expected string
		status         int
	}{
		{"pair_expired", "配对码已过期", 410},
		{"pair_used", "配对码已使用", 409},
		{"pair_invalid", "配对码无效", 401},
		{"untrusted-secret-text", "服务器拒绝授权", 401},
	} {
		t.Run(sample.code, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Codex-Forward-Error", sample.code)
				w.WriteHeader(sample.status)
				fmt.Fprint(w, "untrusted-secret-text")
			}))
			defer s.Close()
			u, _ := url.Parse(s.URL)
			_, err := dial(context.Background(), u, "/forward/helper", strings.Repeat("a", 43))
			if err == nil || !strings.Contains(err.Error(), sample.expected) || strings.Contains(err.Error(), "untrusted-secret-text") || strings.Contains(err.Error(), strings.Repeat("a", 43)) {
				t.Fatalf("Unsafe or unclear authorization diagnostic: %v", err)
			}
		})
	}
}

func TestNativeControlCloseExplainsRevocationAndRestart(t *testing.T) {
	for _, code := range []string{"signed_out", "authorization_expired", "stopped", "server_stopping"} {
		t.Run(code, func(t *testing.T) {
			upgrader := websocket.Upgrader{Subprotocols: []string{"codex-forward-v1"}}
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				c, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer c.Close()
				c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4000, code))
			}))
			defer s.Close()
			u, _ := url.Parse(s.URL)
			err := run(context.Background(), u, strings.Repeat("a", 43), io.Discard)
			if err == nil || err.Error() != failureMessages[code] {
				t.Fatalf("Missing close reason %s: %v", code, err)
			}
		})
	}
}
