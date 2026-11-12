package main

import (
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type messageSocket interface {
	ReadMessage() (int, []byte, error)
	WriteMessage(int, []byte) error
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
	Close() error
}

type directRecord struct {
	kind  int
	bytes []byte
	id    uint32
}
type flowSender interface {
	Send([]byte) error
	SendText(string) error
	BufferedAmount() uint64
	Close() error
}
type directChannel struct {
	dc                                         flowSender
	mu, writeMu, sendMu                        sync.Mutex
	done                                       chan struct{}
	wake                                       chan struct{}
	queue                                      chan directRecord
	ended                                      bool
	cause                                      error
	sent, acked, received, credited, delivered uint32
	readDeadline, writeDeadline                time.Time
	longRead                                   bool
	alive                                      func() bool
	relay                                      bool
}

func newDirectChannel(dc *webrtc.DataChannel, alive func() bool) *directChannel {
	c := newFlowChannel(dc, alive)
	dc.OnClose(func() { c.finish(io.EOF) })
	dc.OnError(func(error) { c.finish(failure("rtc_unavailable")) })
	dc.OnMessage(c.receive)
	return c
}
func newFlowChannel(dc flowSender, alive func() bool) *directChannel {
	return &directChannel{dc: dc, done: make(chan struct{}), wake: make(chan struct{}, 1), queue: make(chan directRecord, 4), alive: alive}
}
func (c *directChannel) unavailable() error {
	if c.relay {
		return failure("helper_reconnecting")
	}
	return failure("rtc_unavailable")
}
func (c *directChannel) timeout() error {
	if c.relay {
		return failure("network_timeout")
	}
	return failure("rtc_health_timeout")
}
func (c *directChannel) finish(err error) {
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return
	}
	c.ended = true
	c.cause = err
	close(c.done)
	c.mu.Unlock()
	// Pion can invoke callbacks from its SCTP read loop; close outside that loop.
	go c.dc.Close()
}
func (c *directChannel) Close() error { c.finish(io.EOF); return nil }
func (c *directChannel) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline = t
	c.longRead = time.Until(t) > 10*time.Second
	c.mu.Unlock()
	return nil
}
func (c *directChannel) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.writeDeadline = t
	c.mu.Unlock()
	return nil
}
func (c *directChannel) receive(message webrtc.DataChannelMessage) {
	if len(message.Data) > chunkSize {
		c.finish(failure("protocol_error"))
		return
	}
	if message.IsString {
		var record struct {
			Type string `json:"type"`
			ID   uint32 `json:"id"`
		}
		if json.Unmarshal(message.Data, &record) != nil {
			c.finish(failure("protocol_error"))
			return
		}
		if record.Type == "ack" {
			var fields map[string]json.RawMessage
			json.Unmarshal(message.Data, &fields)
			c.mu.Lock()
			valid := len(fields) == 2 && record.ID > c.acked && record.ID <= c.sent
			if valid {
				c.acked = record.ID
			}
			c.mu.Unlock()
			if !valid {
				c.finish(failure("protocol_error"))
				return
			}
			select {
			case c.wake <- struct{}{}:
			default:
			}
			return
		}
	}
	c.mu.Lock()
	c.received++
	id := c.received
	valid := !c.ended && id <= 2147483647 && id-c.credited <= 4
	c.mu.Unlock()
	if !valid {
		c.finish(failure("buffer_limit"))
		return
	}
	kind := websocket.BinaryMessage
	if message.IsString {
		kind = websocket.TextMessage
	}
	select {
	case c.queue <- directRecord{kind: kind, bytes: append([]byte(nil), message.Data...), id: id}:
	default:
		c.finish(failure("buffer_limit"))
	}
}
func (c *directChannel) ReadMessage() (int, []byte, error) {
	c.mu.Lock()
	id := c.delivered
	credit := id > c.credited
	if credit {
		c.credited = id
	}
	c.mu.Unlock()
	if credit {
		bytes, _ := json.Marshal(map[string]any{"type": "ack", "id": id})
		c.sendMu.Lock()
		err := c.dc.SendText(string(bytes))
		c.sendMu.Unlock()
		if err != nil {
			c.finish(c.unavailable())
		}
	}
	for {
		c.mu.Lock()
		deadline := c.readDeadline
		long := c.longRead
		c.mu.Unlock()
		if deadline.IsZero() {
			deadline = time.Now().Add(45 * time.Second)
		}
		timer := time.NewTimer(max(time.Until(deadline), 0))
		select {
		case record := <-c.queue:
			timer.Stop()
			c.mu.Lock()
			c.delivered = record.id
			c.mu.Unlock()
			return record.kind, record.bytes, nil
		case <-c.done:
			timer.Stop()
			c.mu.Lock()
			err := c.cause
			c.mu.Unlock()
			return 0, nil, err
		case <-timer.C:
			if long && c.alive() {
				c.SetReadDeadline(time.Now().Add(45 * time.Second))
				continue
			}
			return 0, nil, c.timeout()
		}
	}
}
func (c *directChannel) WriteMessage(kind int, bytes []byte) error {
	if len(bytes) > chunkSize || (kind != websocket.TextMessage && kind != websocket.BinaryMessage) {
		return failure("protocol_error")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	for {
		c.mu.Lock()
		deadline := c.writeDeadline
		room := c.sent-c.acked < 4 && !c.ended && c.sent < 2147483647
		if room {
			c.sent++
		}
		c.mu.Unlock()
		if room {
			c.sendMu.Lock()
			var err error
			if c.dc.BufferedAmount() > 256*1024 {
				err = failure("buffer_limit")
			} else if kind == websocket.TextMessage {
				err = c.dc.SendText(string(bytes))
			} else {
				err = c.dc.Send(bytes)
			}
			c.sendMu.Unlock()
			if err != nil {
				c.finish(c.unavailable())
				return c.unavailable()
			}
			return nil
		}
		if deadline.IsZero() {
			deadline = time.Now().Add(15 * time.Second)
		}
		timer := time.NewTimer(max(time.Until(deadline), 0))
		select {
		case <-c.wake:
			timer.Stop()
		case <-c.done:
			timer.Stop()
			return c.unavailable()
		case <-timer.C:
			return c.timeout()
		}
	}
}
