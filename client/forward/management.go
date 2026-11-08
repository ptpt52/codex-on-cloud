package main

import (
	"context"
	"encoding/json"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Only management signals use this writer. Existing data sockets have their
// own contexts and heartbeats; a control reconnect never sends their bytes.
type managementLink struct {
	mu     sync.Mutex
	ctx    context.Context
	conn   *websocket.Conn
	online bool
}

func (m *managementLink) available() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.online && m.ctx.Err() == nil
}

func (m *managementLink) install(conn *websocket.Conn) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		conn.Close()
		return m.ctx.Err()
	}
	m.conn, m.online = conn, true
	return nil
}

func (m *managementLink) write(value any) error {
	bytes, err := json.Marshal(value)
	if err != nil || len(bytes) > 48*1024 {
		return failure("protocol_error")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.online || m.conn == nil || m.ctx.Err() != nil {
		return failure("helper_reconnecting")
	}
	m.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return m.conn.WriteMessage(websocket.TextMessage, bytes)
}

func (m *managementLink) offline(conn *websocket.Conn) {
	m.mu.Lock()
	if m.conn == conn {
		m.conn, m.online = nil, false
	}
	m.mu.Unlock()
	conn.Close()
}

func (m *managementLink) close(stopping bool) {
	m.mu.Lock()
	conn := m.conn
	m.conn, m.online = nil, false
	m.mu.Unlock()
	if conn == nil {
		return
	}
	if stopping {
		conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "client_stopping"), time.Now().Add(time.Second))
	}
	conn.Close()
}

func readForwardReady(conn *websocket.Conn) (readyMessage, error) {
	kind, data, err := conn.ReadMessage()
	var ready readyMessage
	if err != nil {
		return ready, connectionFailure(err)
	}
	if kind != websocket.TextMessage || len(data) > 2048 || json.Unmarshal(data, &ready) != nil || ready.Type != "ready" || ready.Version != 1 ||
		!tokenPattern.MatchString(ready.StreamToken) || ready.LocalPort < 1024 || ready.LocalPort > 65535 || !ready.validTarget() {
		return ready, failure("protocol_error")
	}
	if ready.Serial == nil {
		ready.TargetHost = ready.targetIP()
	}
	if ready.Direction != "" && ready.Direction != "reverse" || ready.Direction == "reverse" && (ready.ReverseProtocol != 1 || !validDeviceName(ready.DeviceName)) ||
		ready.DirectProtocol != 0 && ready.DirectProtocol != 1 ||
		ready.KeepStreamsProtocol != 0 && ready.KeepStreamsProtocol != 1 || ready.KeepStreamsProtocol == 1 && (ready.ResumeProtocol != 1 || ready.MaxConnections < 1 || ready.MaxConnections > connectionLimit) {
		return ready, failure("protocol_error")
	}
	return ready, nil
}

func confirmListening(conn *websocket.Conn, ready readyMessage, until time.Time) error {
	deadline := time.Now().Add(5 * time.Second)
	if !until.IsZero() && until.Before(deadline) {
		deadline = until
	}
	conn.SetReadDeadline(deadline)
	conn.SetWriteDeadline(deadline)
	record := map[string]any{"type": "listening"}
	if ready.DirectProtocol == 1 {
		record["direct"] = 1
	}
	bytes, _ := json.Marshal(record)
	if err := conn.WriteMessage(websocket.TextMessage, bytes); err != nil {
		return connectionFailure(err)
	}
	kind, data, err := conn.ReadMessage()
	if err != nil {
		return connectionFailure(err)
	}
	if kind != websocket.TextMessage || string(data) != "{\"type\":\"listening\"}" {
		return failure("protocol_error")
	}
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	return nil
}

// The original recovery deadline and scope survive every failed dial/handshake.
// Installation occurs after the server's ack, so local accepts stay paused.
func resumeManagement(ctx context.Context, serverURLValue *url.URL, state *resumeState, ready readyMessage, link *managementLink, output *runOutput) (*websocket.Conn, error) {
	state.deadline = time.Now().Add(resumeWindow)
	for attempt := 0; attempt < resumeAttempts; attempt++ {
		delay := min(time.Second*time.Duration(1<<min(attempt, 3)), time.Until(state.deadline))
		if delay <= 0 {
			break
		}
		output.print(2, "管理连接中断，正在自动恢复（第 %d 次，最多 30 秒）；已有健康数据连接保留，新连接暂停。", attempt+1)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		if !time.Now().Before(state.deadline) {
			break
		}
		dialCtx, cancel := context.WithDeadline(ctx, state.deadline)
		conn, err := dial(dialCtx, serverURLValue, "/forward/resume", state.token)
		cancel()
		if err != nil {
			if canResume(err) {
				continue
			}
			return nil, err
		}
		stop := context.AfterFunc(ctx, func() { conn.Close() })
		deadline := minDeadline(time.Now().Add(5*time.Second), state.deadline)
		conn.SetReadDeadline(deadline)
		next, err := readForwardReady(conn)
		if err == nil {
			err = state.accept(next)
		}
		if err == nil && (next.KeepStreamsProtocol != 1 || next.StreamToken != ready.StreamToken || next.DirectProtocol != ready.DirectProtocol || next.MaxConnections != ready.MaxConnections) {
			err = failure("protocol_error")
		}
		if err == nil {
			err = confirmListening(conn, next, state.deadline)
		}
		if err == nil {
			err = link.install(conn)
		}
		stop()
		if err == nil {
			state.active = true
			state.deadline = time.Time{}
			output.print(2, "映射已恢复；保留原数据连接，新连接已恢复。能够继续传输的连接不会重建或重放数据。")
			return conn, nil
		}
		conn.Close()
		if !canResume(err) {
			return nil, err
		}
	}
	return nil, failure("resume_expired")
}

func minDeadline(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
