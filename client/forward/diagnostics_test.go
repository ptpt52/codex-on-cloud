package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestStreamDiagnosticsDistinguishPhaseAndTCPSideWithoutLeakingDetails(t *testing.T) {
	for _, code := range []string{"relay_connect_timeout", "relay_ready_timeout", "relay_stream_timeout"} {
		for _, err := range []error{os.ErrDeadlineExceeded, failure("network_timeout")} {
			if streamFailure(err, code).Error() != failure(code).Error() {
				t.Fatal("Lost timeout phase")
			}
		}
	}
	if tcpFailure(os.ErrDeadlineExceeded).Error() != failure("tcp_peer_stalled").Error() {
		t.Fatal("TCP stall was blamed on the relay")
	}
	if tcpFailure(errors.New("private TCP metadata")).Error() != failure("tcp_peer_disconnected").Error() {
		t.Fatal("TCP reset was blamed on the relay")
	}
	for _, code := range []string{"target_timeout", "tls_certificate", "heartbeat_timeout", "reverse_stream_timeout", "stream_authorization_invalid"} {
		if streamFailure(failure(code), "relay_ready_timeout").Error() != failure(code).Error() {
			t.Fatal("Known diagnostic was lost")
		}
	}
	if streamFailure(errors.New("private credential"), "relay_stream_timeout").Error() != failure("relay_stream_disconnected").Error() {
		t.Fatal("Untrusted error was exposed")
	}
}

func TestRejectedRuleGrantExplainsCauseWithoutLeakingPeerText(t *testing.T) {
	for _, sample := range []struct {
		code, expected string
		status         int
	}{
		{"pair_expired", "规则通道授权已过期", 410},
		{"pair_used", "规则通道授权已使用", 409},
		{"pair_invalid", "规则通道授权无效", 401},
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
