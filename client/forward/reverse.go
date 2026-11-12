package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
	"unicode"

	"github.com/gorilla/websocket"
)

func validDeviceName(value string) bool {
	if value == "" || len(value) > 192 {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// First authenticate the server's one-time accepted socket. Only after its
// ready record may we dial the locally approved, immutable IP and port.
func reverseProxy(ctx context.Context, server *url.URL, ready readyMessage, id string, active *connections, direct *directManager) error {
	dialCtx, cancel := context.WithTimeout(ctx, dataConnectTimeout)
	defer cancel()
	var ws messageSocket
	pooled, shared := ctx.Value(forwardPoolRuleContext{}).(pooledRule)
	if shared {
		var err error
		ws, err = pooled.pool.Open(dialCtx, pooled.mapping, ready.StreamToken, id)
		if err != nil {
			return streamFailure(err, "relay_connect_timeout")
		}
	} else if direct != nil {
		if channel := direct.Open(dialCtx); channel != nil {
			ws = channel
		}
	}
	usingDirect := ws != nil && !shared
	if ws == nil {
		remote, err := dialHeaders(dialCtx, server, "/forward/data", ready.StreamToken, http.Header{"X-Codex-Reverse-Stream": {id}})
		if err != nil {
			return streamFailure(err, "relay_connect_timeout")
		}
		ws = remote
	}
	defer ws.Close()
	stop := context.AfterFunc(ctx, func() { ws.Close() })
	defer stop()
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	ws.SetReadDeadline(time.Now().Add(dataReadyTimeout))
	if usingDirect {
		record, _ := json.Marshal(map[string]string{"type": "open", "id": id})
		if err := ws.WriteMessage(websocket.TextMessage, record); err != nil {
			return streamFailure(err, "relay_ready_timeout")
		}
	}
	kind, bytes, err := ws.ReadMessage()
	if err != nil {
		return streamFailure(err, "relay_ready_timeout")
	}
	if kind != websocket.TextMessage || string(bytes) != "{\"type\":\"ready\"}" {
		return recordFailure(bytes)
	}
	if ready.Serial != nil {
		return reverseSerial(ctx, ready, active, ws)
	}
	targetCtx, cancelTarget := context.WithTimeout(ctx, 5*time.Second)
	defer cancelTarget()
	tcp, err := (&net.Dialer{KeepAlive: 30 * time.Second}).DialContext(targetCtx, "tcp", net.JoinHostPort(ready.TargetHost, fmt.Sprint(ready.TargetPort)))
	if err != nil {
		code := "target_unavailable"
		if value, ok := err.(net.Error); ok && value.Timeout() {
			code = "target_timeout"
		}
		record, _ := json.Marshal(map[string]string{"type": "error", "code": code})
		ws.SetWriteDeadline(time.Now().Add(time.Second))
		ws.WriteMessage(websocket.TextMessage, record)
		return failure(code)
	}
	local, ok := tcp.(*net.TCPConn)
	if !ok {
		tcp.Close()
		return failure("protocol_error")
	}
	defer local.Close()
	if !active.add(local) {
		return failure("connection_limit")
	}
	defer active.remove(local)
	if !active.attach(local, ws) {
		return nil
	}
	local.SetNoDelay(true)
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"target_ready\"}")); err != nil {
		return streamFailure(err, "relay_ready_timeout")
	}
	return copyStream(local, ws)
}
