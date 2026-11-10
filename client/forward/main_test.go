package main

import (
	"context"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServerURL(t *testing.T) {
	valid := map[string]string{
		"https://example.com/node/edge-1/": "https://example.com/node/edge-1/",
		"https://example.com/":             "https://example.com",
		"https://example.com:443":          "https://example.com",
		"https://[2001:db8::1]:443/":       "https://[2001:db8::1]",
		"http://127.0.0.1:1234":            "http://127.0.0.1:1234",
		"http://localhost:36080/":          "http://localhost:36080",
	}
	for input, expected := range valid {
		result, err := serverURL(input)
		if err != nil || result.String() != expected {
			t.Fatalf("Invalid normalized server for %q", input)
		}
	}
	for _, input := range []string{
		"https://example.com/node/a", "https://example.com/node/A/", "https://example.com/node/a/../b/", "https://example.com/node/%61/", "example.com", "http://example.com", "http://192.168.1.1", "http://localhost.evil.test",
		"https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret",
		"https://example.com/#secret", "file:///tmp/config", "wss://example.com",
	} {
		if _, err := serverURL(input); err == nil {
			t.Fatalf("Accepted an invalid server address: %q", input)
		}
	}
}

func TestNodePathsAndOrigin(t *testing.T) {
	for _, base := range []string{"", "/node/edge-1/"} {
		for _, endpoint := range []string{"/forward/helper", "/forward/data", "/forward/resume"} {
			seen := false
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen = true
				if r.URL.Path != strings.TrimSuffix(base, "/")+endpoint || r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Authorization") != "Bearer synthetic-token" {
					t.Error("path, origin or authentication changed")
				}
				upgrader := websocket.Upgrader{Subprotocols: []string{"codex-forward-v1"}, CheckOrigin: func(*http.Request) bool { return true }}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
			}))
			server, err := serverURL(srv.URL + base)
			if err != nil {
				t.Fatal(err)
			}
			conn, err := dial(context.Background(), server, endpoint, "synthetic-token")
			if err != nil {
				t.Fatal(err)
			}
			conn.Close()
			srv.Close()
			if !seen {
				t.Fatal("no handshake")
			}
		}
	}
}
