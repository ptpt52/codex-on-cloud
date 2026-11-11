package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func testAgentKey(grant agentGrant) string {
	data, _ := json.Marshal(grant)
	return "COCA1." + base64.RawURLEncoding.EncodeToString(data)
}

func TestAgentKeyBindsNodeAndEntryWithoutPermittingUnsafeURLs(t *testing.T) {
	value := agentGrant{Version: 1, Server: "https://desk.example/node/office/", Node: strings.Repeat("a", 32), Agent: strings.Repeat("b", 32), Secret: strings.Repeat("c", 43)}
	grant, server, err := parseAgentKey(testAgentKey(value))
	if err != nil || grant != value || server.String() != value.Server {
		t.Fatal("valid key rejected", err)
	}
	for _, bad := range []string{"http://public.example", "https://user:password@desk.example", "https://desk.example/node/a/../b/", "https://desk.example/?token=secret"} {
		changed := value
		changed.Server = bad
		if _, _, err := parseAgentKey(testAgentKey(changed)); err == nil {
			t.Fatal("unsafe entry accepted", bad)
		}
	}
	for _, key := range []string{"not-a-key", "COCA1." + strings.Repeat("a", 2048), "COCA1." + base64.RawURLEncoding.EncodeToString([]byte(`{"version":1,"unexpected":true}`))} {
		if _, _, err := parseAgentKey(key); err == nil {
			t.Fatal("bad key accepted")
		}
	}
}

func TestManagedRuleCannotChangeTargetDuringItsMappingHandshake(t *testing.T) {
	rule := managedRule{ID: strings.Repeat("a", 32), MappingID: strings.Repeat("b", 32), Code: strings.Repeat("c", 43), Revision: 1, Name: "SSH", Config: agentRuleConfig{LocalPort: 2222, TargetHost: "192.168.1.1", TargetPort: 22}}
	ready := readyMessage{ID: rule.MappingID, LocalPort: 2222, TargetHost: "192.168.1.1", TargetPort: 22}
	if !rule.valid() || !rule.matches(ready) {
		t.Fatal("valid rule rejected")
	}
	changed := ready
	changed.TargetHost = "192.168.1.2"
	if rule.matches(changed) {
		t.Fatal("mutable target accepted")
	}
	changed = ready
	changed.LocalPort++
	if rule.matches(changed) {
		t.Fatal("mutable listener accepted")
	}
	changed = ready
	changed.ID = strings.Repeat("d", 32)
	if rule.matches(changed) {
		t.Fatal("another mapping accepted")
	}
	rule.Config = agentRuleConfig{Direction: "reverse", DeviceName: "串口", Protocol: "serial", LocalPort: 22001, Serial: &serialConfig{Path: "COM3", Baud: 115200, DataBits: 8, StopBits: 1, Parity: "none"}}
	ready = readyMessage{ID: rule.MappingID, LocalPort: 22001, Direction: "reverse", DeviceName: "串口", Protocol: "serial", Serial: rule.Config.Serial}
	if !rule.valid() || !rule.matches(ready) {
		t.Fatal("serial rule rejected")
	}
	changed = ready
	copied := *ready.Serial
	copied.Baud = 9600
	changed.Serial = &copied
	if rule.matches(changed) {
		t.Fatal("serial parameter mutation accepted")
	}
}

func TestAgentHandshakeUsesDedicatedProtocolAndPinsEveryNativeConnection(t *testing.T) {
	for _, path := range []string{"/forward/agent", "/forward/helper", "/forward/resume", "/forward/data"} {
		protocol := "codex-forward-v1"
		if path == "/forward/agent" {
			protocol = "codex-agent-v1"
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != path || r.Header.Get("X-Codex-Forward-Node") != strings.Repeat("a", 32) || r.Header.Get("Authorization") != "Bearer synthetic-token" {
				t.Error("node identity or capability changed")
			}
			upgrader := websocket.Upgrader{Subprotocols: []string{protocol}, CheckOrigin: func(*http.Request) bool { return true }}
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
		}))
		server, _ := serverURL(srv.URL)
		ctx := context.WithValue(context.Background(), forwardNodeContext{}, strings.Repeat("a", 32))
		conn, err := dial(ctx, server, path, "synthetic-token")
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
		srv.Close()
	}
}

func TestInventoryRemovesConsoleControlsAndBoundsTheWholePayload(t *testing.T) {
	if got := safeAgentText("eth\x1b[31m\u200b网卡", 12); strings.ContainsAny(got, "\x1b\u200b") || len(got) > 12 {
		t.Fatal("unbounded control text", got)
	}
	value := agentInventoryReport{Type: "inventory", SerialPorts: []string{}, Interfaces: []agentInterface{}}
	for i := 0; i < 128; i++ {
		iface := agentInterface{Name: strings.Repeat("n", 128), Index: i + 1, Addresses: []agentIPv4{}}
		for n := 0; n < 32; n++ {
			iface.Addresses = append(iface.Addresses, agentIPv4{Address: "192.168.100.100", Prefix: 24})
		}
		value.Interfaces = append(value.Interfaces, iface)
	}
	bounded := boundedAgentInventory(value)
	data, _ := json.Marshal(bounded)
	if len(data) > 32768 || !bounded.Truncated {
		t.Fatal("inventory can overflow its control channel")
	}
}
