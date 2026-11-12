package main

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func waitBudget(t *testing.T, b *flowBudget, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		n := len(b.waiting)
		b.mu.Unlock()
		if n == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("credit waiter did not arrive")
}

func TestPeerCreditFairnessCancellationAndBounds(t *testing.T) {
	b := newFlowBudget()
	done := make(chan struct{})
	if err := b.acquire(directPeerBytes, done, time.Time{}); err != nil {
		t.Fatal(err)
	}
	first, second := make(chan error, 1), make(chan error, 1)
	go func() { first <- b.acquire(16384, done, time.Time{}) }()
	waitBudget(t, b, 1)
	go func() { second <- b.acquire(1, done, time.Time{}) }()
	waitBudget(t, b, 2)
	b.release(1)
	select {
	case <-second:
		t.Fatal("new small stream jumped ahead of an older blocked stream")
	default:
	}
	b.release(16383)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	b.release(1)
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if b.used != directPeerBytes || b.peak != directPeerBytes {
		t.Fatal("peer credit escaped its bound")
	}
	canceled := make(chan error, 1)
	go func() { canceled <- b.acquire(1, done, time.Time{}) }()
	waitBudget(t, b, 1)
	close(done)
	if err := <-canceled; err == nil {
		t.Fatal("closed stream waited for credit")
	}
	waitBudget(t, b, 0)
	b.release(directPeerBytes)
	if b.used != 0 {
		t.Fatal("credit leaked on cancellation")
	}
	if err := b.acquire(1, make(chan struct{}), time.Now().Add(-time.Second)); err == nil {
		b.release(1)
	}
	if b.used != 0 {
		t.Fatal("expired reservation leaked credit")
	}
	b.close()
	if err := b.acquire(1, make(chan struct{}), time.Time{}); err == nil {
		t.Fatal("closed peer admitted a stream")
	}
}

func TestDirectWindowNegotiationRejectsUnknownFieldsAndUnagreedBounds(t *testing.T) {
	for _, record := range []string{`{"type":"ready","window":8,"peerWindowBytes":524288}`, `{"type":"ready","window":16,"peerWindowBytes":524288}`} {
		if window, ok := directReady([]byte(record), 16); !ok || window < 8 {
			t.Fatal("valid negotiation refused")
		}
	}
	if window, ok := directReady([]byte(`{"type":"ready"}`), 0); !ok || window != 4 {
		t.Fatal("legacy peer lost its four-record bound")
	}
	for _, record := range []string{`{"TYPE":"ready"}`, `{"type":"ready","window":32,"peerWindowBytes":524288}`, `{"type":"ready","Window":8,"peerWindowBytes":524288}`, `{"type":"ready","window":8,"peerWindowBytes":1}`, `{"type":"ready","window":8,"peerWindowBytes":524288,"extra":1}`} {
		if _, ok := directReady([]byte(record), 16); ok {
			t.Fatal("accepted invalid negotiation:", record)
		}
	}
	if _, ok := directReady([]byte(`{"type":"ready","window":16,"peerWindowBytes":524288}`), 8); ok {
		t.Fatal("peer enlarged the offered window")
	}
}

type scheduledTestChannel struct {
	mu      sync.Mutex
	buffer  uint64
	closed  bool
	name    string
	packets chan string
}

func (c *scheduledTestChannel) Send(data []byte) error {
	c.packets <- c.name + ":" + string(data)
	return nil
}
func (c *scheduledTestChannel) SendText(data string) error { return c.Send([]byte(data)) }
func (c *scheduledTestChannel) BufferedAmount() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buffer
}
func (c *scheduledTestChannel) Close() error { c.mu.Lock(); c.closed = true; c.mu.Unlock(); return nil }
func (c *scheduledTestChannel) ReadyState() webrtc.DataChannelState {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return webrtc.DataChannelStateClosed
	}
	return webrtc.DataChannelStateOpen
}
func (*scheduledTestChannel) SetBufferedAmountLowThreshold(uint64) {}
func (*scheduledTestChannel) OnBufferedAmountLow(func())           {}

func TestRTCWriterControlReservationAndCancellation(t *testing.T) {
	w := newDirectWriter(context.Background())
	t.Cleanup(func() { w.close(); <-w.done })
	packets := make(chan string, 16)
	raw := &scheduledTestChannel{buffer: 128 * 1024, name: "bulk", packets: packets}
	bulk := w.channel(raw, false)
	health := w.channel(&scheduledTestChannel{name: "health", packets: packets}, true)
	bulkDone := make(chan error, 1)
	go func() { bulkDone <- bulk.Send([]byte("payload")) }()
	deadline := time.Now().Add(time.Second)
	for bulk.BufferedAmount() == 128*1024 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if err := health.Send([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if got := <-packets; got != "health:ping" {
		t.Fatal("bulk blocked health reservation:", got)
	}
	select {
	case <-bulkDone:
		t.Fatal("bulk exceeded native admission bound")
	default:
	}
	bulk.Close()
	if err := <-bulkDone; err == nil {
		t.Fatal("closed stream sent a queued payload")
	}
	select {
	case data := <-packets:
		t.Fatal("revoked data sent:", data)
	default:
	}
}

func TestRTCACKBypassesABlockedWriteOnTheSameStream(t *testing.T) {
	w := newDirectWriter(context.Background())
	t.Cleanup(func() { w.close(); <-w.done })
	packets := make(chan string, 16)
	raw := &scheduledTestChannel{buffer: 128 * 1024, packets: packets}
	c := newFlowChannel(w.channel(raw, false), func() bool { return true })
	t.Cleanup(func() { c.Close() })
	writing := make(chan error, 1)
	go func() { writing <- c.WriteMessage(websocket.BinaryMessage, []byte("bulk")) }()
	deadline := time.Now().Add(time.Second)
	for c.dc.BufferedAmount() == 128*1024 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	c.receive(webrtc.DataChannelMessage{Data: []byte("received")})
	if _, _, err := c.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	reading := make(chan error, 1)
	go func() { _, _, err := c.ReadMessage(); reading <- err }()
	select {
	case packet := <-packets:
		if !strings.Contains(packet, `"id":1`) {
			t.Fatal("business data preceded ACK:", packet)
		}
	case <-time.After(time.Second):
		t.Fatal("ACK blocked behind its opposite-direction bulk write")
	}
	c.Close()
	<-reading
	if err := <-writing; err == nil {
		t.Fatal("closed queued write was sent")
	}
}

func TestRTCExpiredQueuedWriteNeverSendsLater(t *testing.T) {
	w := newDirectWriter(context.Background())
	t.Cleanup(func() { w.close(); <-w.done })
	packets := make(chan string, 4)
	raw := &scheduledTestChannel{buffer: 128 * 1024, packets: packets}
	c := w.channel(raw, false)
	if err := c.sendDeadline([]byte("expired"), false, time.Now().Add(10*time.Millisecond)); err == nil {
		t.Fatal("queued write ignored its original deadline")
	}
	raw.mu.Lock()
	raw.buffer = 0
	raw.mu.Unlock()
	w.notify()
	time.Sleep(10 * time.Millisecond)
	select {
	case packet := <-packets:
		t.Fatal("expired payload sent:", packet)
	default:
	}
}

func TestRTCGracefulCloseDrainsNativeACKsAndPeerRevocationInterruptsIt(t *testing.T) {
	w := newDirectWriter(context.Background())
	t.Cleanup(func() { w.close(); <-w.done })
	raw := &scheduledTestChannel{buffer: 32, packets: make(chan string, 4)}
	c := w.channel(raw, false)
	done := make(chan error, 1)
	go func() { done <- c.CloseGracefully() }()
	time.Sleep(10 * time.Millisecond)
	if raw.ReadyState() != webrtc.DataChannelStateOpen {
		t.Fatal("native ACK reset before draining")
	}
	raw.mu.Lock()
	raw.buffer = 0
	raw.mu.Unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("drained native channel stayed open")
	}
	if raw.ReadyState() != webrtc.DataChannelStateClosed {
		t.Fatal("graceful channel did not close")
	}
	other := &scheduledTestChannel{buffer: 32, packets: make(chan string, 4)}
	second := w.channel(other, false)
	go func() { done <- second.CloseGracefully() }()
	time.Sleep(10 * time.Millisecond)
	w.close()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("peer revocation waited for native flush")
	}
}

func TestNegotiatedForwardWindowAndCreditReturn(t *testing.T) {
	for _, window := range []int{4, 8, 16} {
		t.Run(strconv.Itoa(window), func(t *testing.T) {
			raw := &scheduledTestChannel{packets: make(chan string, 64)}
			c := newFlowChannel(raw, func() bool { return true })
			c.window = window
			c.queue = make(chan directRecord, window)
			c.budget = newFlowBudget()
			c.held = make(map[uint32]int)
			for i := 0; i < window; i++ {
				if err := c.WriteMessage(websocket.BinaryMessage, make([]byte, 16384)); err != nil {
					t.Fatal(err)
				}
			}
			if c.budget.used != window*16384 {
				t.Fatal("incorrect application credit")
			}
			for i := 0; i < window; i++ {
				c.receive(webrtc.DataChannelMessage{Data: []byte("bounded")})
			}
			select {
			case <-c.done:
				t.Fatal("negotiated receive window rejected valid data")
			default:
			}
			c.receive(webrtc.DataChannelMessage{Data: []byte("overflow")})
			<-c.done
			if c.budget.used != 0 {
				t.Fatal("closed stream leaked unacknowledged peer credit")
			}
		})
	}
}
