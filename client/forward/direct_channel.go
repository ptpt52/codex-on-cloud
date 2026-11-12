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
	window                                     int
	budget                                     *flowBudget
	held                                       map[uint32]int
	preflight                                  chan bool
	preflightSeen                              bool
}

func newDirectChannel(dc *webrtc.DataChannel, alive func() bool) *directChannel {
	c := newFlowChannel(dc, alive)
	dc.OnClose(func() { c.finish(io.EOF) })
	dc.OnError(func(error) { c.finish(failure("rtc_unavailable")) })
	dc.OnMessage(c.receive)
	return c
}
func newScheduledDirectChannel(dc *webrtc.DataChannel, alive func() bool, window int, writer *directWriter, preflight bool) *directChannel {
	sender := writer.channel(dc, false)
	if sender == nil {
		return nil
	}
	c := newFlowChannel(sender, alive)
	c.window = window
	c.queue = make(chan directRecord, window)
	c.budget = writer.budget
	c.held = make(map[uint32]int)
	if preflight {
		c.preflight = make(chan bool, 1)
	}
	dc.OnClose(func() { c.finish(io.EOF) })
	dc.OnError(func(error) { c.finish(c.unavailable()) })
	dc.OnMessage(c.receive)
	return c
}
func newFlowChannel(dc flowSender, alive func() bool) *directChannel {
	return &directChannel{dc: dc, done: make(chan struct{}), wake: make(chan struct{}, 1), queue: make(chan directRecord, 4), window: 4, alive: alive}
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
	graceful := err == io.EOF && c.sent == c.acked && c.received == c.credited
	released, bulk := 0, 0
	for id, size := range c.held {
		released += size
		bulk += c.budget.bulkBytes(size)
		delete(c.held, id)
	}
	close(c.done)
	c.mu.Unlock()
	if c.budget != nil {
		c.budget.release(released, bulk)
	}
	// Pion can invoke callbacks from its SCTP read loop; close outside that loop.
	go func() {
		if sender, ok := c.dc.(interface{ CloseGracefully() error }); ok && graceful {
			sender.CloseGracefully()
		} else {
			c.dc.Close()
		}
	}()
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
		if record.Type == "preflight" {
			var value struct {
				Ready *bool `json:"ready"`
			}
			var fields map[string]json.RawMessage
			json.Unmarshal(message.Data, &fields)
			err := json.Unmarshal(message.Data, &value)
			c.mu.Lock()
			valid := !c.ended && c.preflight != nil && !c.preflightSeen && err == nil && value.Ready != nil && len(fields) == 2 && fields["ready"] != nil && fields["type"] != nil
			if valid {
				c.preflightSeen = true
				c.preflight <- *value.Ready
			}
			c.mu.Unlock()
			if !valid {
				c.finish(failure("protocol_error"))
			}
			return
		}
		if record.Type == "ack" {
			var fields map[string]json.RawMessage
			json.Unmarshal(message.Data, &fields)
			c.mu.Lock()
			valid := len(fields) == 2 && record.ID > c.acked && record.ID <= c.sent
			released, bulk := 0, 0
			if valid {
				c.acked = record.ID
				for id, size := range c.held {
					if id <= record.ID {
						released += size
						bulk += c.budget.bulkBytes(size)
						delete(c.held, id)
					}
				}
			}
			c.mu.Unlock()
			if c.budget != nil {
				c.budget.release(released, bulk)
			}
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
	if c.preflight != nil && !c.preflightSeen {
		c.mu.Unlock()
		c.finish(failure("protocol_error"))
		return
	}
	c.received++
	id := c.received
	window := c.window
	if window == 0 {
		window = 4
	}
	valid := !c.ended && id <= 2147483647 && id-c.credited <= uint32(window)
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
		var err error
		if sender, ok := c.dc.(interface{ SendACK(string) error }); ok {
			// The peer writer serializes native sends. ACKs bypass a bulk write
			// waiting for admission; they never reorder business data or FIN.
			err = sender.SendACK(string(bytes))
		} else {
			c.sendMu.Lock()
			err = c.dc.SendText(string(bytes))
			c.sendMu.Unlock()
		}
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
		window := c.window
		if window == 0 {
			window = 4
		}
		room := c.sent-c.acked < uint32(window) && !c.ended && c.sent < 2147483647
		c.mu.Unlock()
		if room {
			if !deadline.IsZero() && !time.Now().Before(deadline) {
				return c.timeout()
			}
			if c.budget != nil {
				if err := c.budget.acquire(len(bytes), c.done, deadline); err != nil {
					return err
				}
			}
			c.mu.Lock()
			if c.ended {
				c.mu.Unlock()
				if c.budget != nil {
					c.budget.release(len(bytes), c.budget.bulkBytes(len(bytes)))
				}
				return c.unavailable()
			}
			c.sent++
			if c.budget != nil {
				c.held[c.sent] = len(bytes)
			}
			c.mu.Unlock()
			c.sendMu.Lock()
			var err error
			if c.dc.BufferedAmount() > 512*1024 {
				err = failure("buffer_limit")
			} else if sender, ok := c.dc.(interface {
				sendDeadline([]byte, bool, time.Time) error
			}); ok {
				err = sender.sendDeadline(bytes, kind == websocket.TextMessage, deadline)
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
