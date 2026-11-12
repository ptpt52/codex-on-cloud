package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type forwardPoolContext struct{}
type forwardPoolRuleContext struct{}
type pooledRule struct {
	pool    *transportPool
	mapping string
}

// Management and rules have their own connections/contexts. This pool belongs
// to one entered key + process instance and survives individual rule changes.
// Nothing here retries a target-open record or any business bytes.
type poolWrite struct {
	ctx  context.Context
	kind int
	data []byte
	conn *websocket.Conn
	done chan error
}
type transportPool struct {
	mu         sync.Mutex
	ctx        context.Context
	cancel     context.CancelFunc
	server     *url.URL
	grant      agentGrant
	instance   string
	output     *agentOutput
	startOnce  sync.Once
	done       chan struct{}
	writerDone chan struct{}
	controls   chan poolWrite
	data       chan poolWrite
	conn       *websocket.Conn
	channels   map[uint32]*relayChannel
	next       uint32
	healthAt   time.Time
	token      string
	direct     *directManager
}

func newTransportPool(ctx context.Context, server *url.URL, grant agentGrant, instance string, output *agentOutput) *transportPool {
	ctx, cancel := context.WithCancel(ctx)
	return &transportPool{ctx: ctx, cancel: cancel, server: server, grant: grant, instance: instance, output: output, done: make(chan struct{}), writerDone: make(chan struct{}), controls: make(chan poolWrite, 128), data: make(chan poolWrite, 128), channels: make(map[uint32]*relayChannel)}
}
func (p *transportPool) start() { p.startOnce.Do(func() { go p.writer(); go p.run() }) }
func (p *transportPool) close() { p.cancel(); p.start(); <-p.done; <-p.writerDone }
func (p *transportPool) available() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conn != nil && p.ctx.Err() == nil
}
func (p *transportPool) write(kind int, data []byte, expected *websocket.Conn) error {
	p.mu.Lock()
	conn := p.conn
	p.mu.Unlock()
	if conn == nil || expected != nil && conn != expected || p.ctx.Err() != nil {
		return failure("helper_reconnecting")
	}
	queue, timeout := p.controls, 5*time.Second
	if kind == websocket.BinaryMessage && len(data) > 0 && data[0] == 2 {
		queue, timeout = p.data, 15*time.Second
	}
	ctx, cancel := context.WithTimeout(p.ctx, timeout)
	defer cancel()
	request := poolWrite{ctx: ctx, kind: kind, data: data, conn: conn, done: make(chan error, 1)}
	select {
	case queue <- request:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-request.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *transportPool) writer() {
	defer close(p.writerDone)
	for {
		var request poolWrite
		// Preflight, ACK and FIN are small. A stream waits for its preceding
		// data write to finish, so priority never reorders its business bytes.
		select {
		case request = <-p.controls:
		default:
			select {
			case request = <-p.controls:
			case request = <-p.data:
			case <-p.ctx.Done():
				return
			}
		}
		if p.ctx.Err() != nil {
			return
		}
		if err := request.ctx.Err(); err != nil {
			request.done <- err
			continue
		}
		p.mu.Lock()
		current := p.conn == request.conn
		p.mu.Unlock()
		if !current {
			request.done <- failure("helper_reconnecting")
			continue
		}
		deadline, _ := request.ctx.Deadline()
		request.conn.SetWriteDeadline(deadline)
		err := request.conn.WriteMessage(request.kind, request.data)
		if err != nil {
			request.conn.Close()
		}
		request.done <- err
	}
}
func (p *transportPool) writeJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) > 48*1024 {
		return failure("protocol_error")
	}
	return p.write(websocket.TextMessage, data, nil)
}
func (p *transportPool) run() {
	defer close(p.done)
	defer func() {
		p.cancel()
		p.mu.Lock()
		direct := p.direct
		p.direct = nil
		p.mu.Unlock()
		if direct != nil {
			direct.Close()
		}
	}()
	for attempt := 0; p.ctx.Err() == nil; attempt++ {
		conn, err := dialHeaders(p.ctx, p.server, "/forward/transport", p.grant.Agent+"."+p.grant.Secret, http.Header{"X-Codex-Agent-Instance": {p.instance}})
		if err == nil {
			err = p.session(conn)
			p.offline(conn)
		}
		if p.ctx.Err() != nil {
			return
		}
		if err != nil && !canResume(connectionFailure(err)) {
			return
		}
		delay := min(time.Second*time.Duration(1<<min(attempt, 4)), 15*time.Second)
		timer := time.NewTimer(delay)
		select {
		case <-p.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
func (p *transportPool) offline(conn *websocket.Conn) {
	p.mu.Lock()
	var channels []*relayChannel
	if p.conn == conn {
		p.conn = nil
		p.healthAt = time.Time{}
		for _, channel := range p.channels {
			channels = append(channels, channel)
		}
		p.channels = make(map[uint32]*relayChannel)
	}
	p.mu.Unlock()
	conn.Close()
	for _, channel := range channels {
		channel.flow.finish(failure("network_disconnected"))
	}
}
func (p *transportPool) session(conn *websocket.Conn) error {
	stop := context.AfterFunc(p.ctx, func() { conn.Close() })
	defer stop()
	kind, data, err := conn.ReadMessage()
	if err != nil {
		return connectionFailure(err)
	}
	var ready struct {
		Type    string `json:"type"`
		Version int    `json:"version"`
		ID      string `json:"id"`
		Token   string `json:"token"`
	}
	if kind != websocket.TextMessage || len(data) > 2048 || json.Unmarshal(data, &ready) != nil || ready.Type != "pool-ready" || ready.Version != 1 || ready.ID != p.grant.Agent || !tokenPattern.MatchString(ready.Token) {
		return failure("protocol_error")
	}
	p.mu.Lock()
	old := p.direct
	if p.token != ready.Token {
		p.direct = nil
	}
	p.conn = conn
	p.next = 0
	p.healthAt = time.Time{}
	p.token = ready.Token
	if p.direct == nil {
		write := func(value any) error {
			p.mu.Lock()
			current, conn := p.token == ready.Token, p.conn
			p.mu.Unlock()
			if !current || conn == nil {
				return failure("helper_reconnecting")
			}
			data, err := json.Marshal(value)
			if err != nil || len(data) > 48*1024 {
				return failure("protocol_error")
			}
			return p.write(websocket.TextMessage, data, conn)
		}
		p.direct = makeDirectManager(p.ctx, ready.Token, write, p.available, func(text string) { p.output.Write([]byte("共享连接：" + text + "\n")) }, true)
	} else {
		old = nil
	}
	direct := p.direct
	p.mu.Unlock()
	if old != nil {
		old.Close()
	}
	conn.SetReadLimit(48 * 1024)
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	for {
		kind, data, err = conn.ReadMessage()
		if err != nil {
			return connectionFailure(err)
		}
		if kind == websocket.BinaryMessage {
			if err := p.receive(conn, data); err != nil {
				return err
			}
			p.mu.Lock()
			if p.conn == conn {
				p.healthAt = time.Now()
			}
			p.mu.Unlock()
			conn.SetReadDeadline(time.Now().Add(45 * time.Second))
			continue
		}
		if kind != websocket.TextMessage {
			return failure("protocol_error")
		}
		var value directSignal
		if json.Unmarshal(data, &value) != nil {
			return failure("protocol_error")
		}
		if value.Type == "pool-ping" && value.ID > 0 && value.ID <= 2147483647 {
			conn.SetReadDeadline(time.Now().Add(45 * time.Second))
			if err := p.writeJSON(map[string]any{"type": "pool-pong", "id": value.ID}); err != nil {
				return err
			}
			p.mu.Lock()
			if p.conn == conn {
				p.healthAt = time.Now()
			}
			p.mu.Unlock()
		} else if value.Type == "rtc_config" || value.Type == "rtc_answer" || value.Type == "rtc_status" {
			direct.accept(value)
		} else {
			return failure("protocol_error")
		}
	}
}

type relayChannel struct {
	pool   *transportPool
	conn   *websocket.Conn
	id     uint32
	flow   *directChannel
	opened chan struct{}
	ready  bool // protected by pool.mu
}

func (c *relayChannel) frame(op byte, data []byte) error {
	if len(data) > chunkSize {
		return failure("buffer_limit")
	}
	frame := make([]byte, 5+len(data))
	frame[0] = op
	binary.BigEndian.PutUint32(frame[1:5], c.id)
	copy(frame[5:], data)
	return c.pool.write(websocket.BinaryMessage, frame, c.conn)
}
func (c *relayChannel) Send(data []byte) error     { return c.frame(2, data) }
func (c *relayChannel) SendText(data string) error { return c.frame(1, []byte(data)) }
func (c *relayChannel) BufferedAmount() uint64     { return 0 } // Writes are synchronous, with one bounded writer.
func (c *relayChannel) Close() error {
	c.pool.mu.Lock()
	current := c.pool.channels[c.id] == c && c.pool.conn == c.conn
	if current {
		delete(c.pool.channels, c.id)
	}
	c.pool.mu.Unlock()
	if current {
		return c.frame(3, nil)
	}
	return nil
}
func (p *transportPool) receive(conn *websocket.Conn, frame []byte) error {
	if len(frame) < 5 || len(frame) > chunkSize+5 {
		return failure("protocol_error")
	}
	op, id := frame[0], binary.BigEndian.Uint32(frame[1:5])
	data := frame[5:]
	if id == 0 || id > 2147483647 || op != 1 && op != 2 && op != 3 && op != 5 || (op == 3 || op == 5) && len(data) != 0 {
		return failure("protocol_error")
	}
	p.mu.Lock()
	channel, last := p.channels[id], p.next
	if p.conn != conn {
		p.mu.Unlock()
		return failure("helper_reconnecting")
	}
	if channel != nil && op == 5 {
		if channel.ready {
			p.mu.Unlock()
			return failure("protocol_error")
		}
		channel.ready = true
		close(channel.opened)
	}
	ready := channel != nil && channel.ready
	p.mu.Unlock()
	if channel == nil {
		if id > last {
			return failure("protocol_error")
		}
		return nil
	}
	if op == 5 {
		return nil
	}
	if op == 3 {
		channel.flow.finish(io.EOF)
		return nil
	}
	if !ready {
		return failure("protocol_error")
	}
	channel.flow.receive(webrtc.DataChannelMessage{IsString: op == 1, Data: data})
	return nil
}
func (p *transportPool) openRelay(ctx context.Context) (messageSocket, error) {
	// Wait only for a transport preflight, never for permission to replay an open.
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		p.mu.Lock()
		conn := p.conn
		if conn != nil && time.Since(p.healthAt) < 10*time.Second {
			if len(p.channels) >= 128 || p.next >= 2147483647 {
				p.mu.Unlock()
				return nil, failure("connection_limit")
			}
			p.next++
			channel := &relayChannel{pool: p, conn: conn, id: p.next, opened: make(chan struct{})}
			channel.flow = newFlowChannel(channel, func() bool {
				p.mu.Lock()
				defer p.mu.Unlock()
				return p.conn == conn && time.Since(p.healthAt) < 10*time.Second
			})
			channel.flow.relay = true
			p.channels[channel.id] = channel
			p.mu.Unlock()
			if err := channel.frame(4, nil); err != nil {
				channel.flow.Close()
				return nil, err
			}
			timer := time.NewTimer(dataReadyTimeout)
			select {
			case <-channel.opened:
				timer.Stop()
				return channel.flow, nil
			case <-channel.flow.done:
				timer.Stop()
			case <-ctx.Done():
				timer.Stop()
			case <-timer.C:
			}
			channel.flow.Close()
			return nil, failure("helper_reconnecting")
		}
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-p.ctx.Done():
			return nil, failure("helper_reconnecting")
		case <-ticker.C:
		}
	}
}
func (p *transportPool) Open(ctx context.Context, mapping, token, reverseID string) (messageSocket, error) {
	p.mu.Lock()
	direct := p.direct
	p.mu.Unlock()
	var stream messageSocket
	if direct != nil {
		if channel := direct.Open(ctx); channel != nil {
			stream = channel
		}
	}
	if stream == nil {
		var err error
		stream, err = p.openRelay(ctx)
		if err != nil {
			return nil, err
		}
	}
	record := map[string]string{"type": "open", "mapping": mapping, "token": token}
	if reverseID != "" {
		record["id"] = reverseID
	}
	bytes, _ := json.Marshal(record)
	stream.SetReadDeadline(time.Now().Add(dataReadyTimeout))
	stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
	// This is the sole target-open attempt. A write error can mean the peer has
	// already acted: close the stream, never retry it on the other transport.
	if err := stream.WriteMessage(websocket.TextMessage, bytes); err != nil {
		stream.Close()
		return nil, err
	}
	return stream, nil
}
