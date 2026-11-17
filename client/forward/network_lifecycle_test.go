package main

import (
	"context"
	"io"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func TestClosedDirectChannelDiscardsQueuedData(t *testing.T) {
	for range 64 {
		raw := &scheduledTestChannel{packets: make(chan string, 4)}
		c := newFlowChannel(raw, func() bool { return true })
		c.receive(webrtc.DataChannelMessage{Data: []byte("old stream data")})
		c.Close()
		_, bytes, err := c.ReadMessage()
		if err != io.EOF || len(bytes) != 0 || len(c.queue) != 0 {
			t.Fatal("closed stream retained or delivered queued data", string(bytes), err)
		}
		c.receive(webrtc.DataChannelMessage{Data: []byte("late callback")})
		if len(c.queue) != 0 {
			t.Fatal("late callback retained data")
		}
	}
}

func TestConcurrentDirectReceiveAndCloseCannotRetainData(t *testing.T) {
	for range 64 {
		c := newFlowChannel(&scheduledTestChannel{packets: make(chan string, 4)}, func() bool { return true })
		var workers sync.WaitGroup
		workers.Go(func() { c.receive(webrtc.DataChannelMessage{Data: []byte("racing callback")}) })
		workers.Go(func() { c.Close() })
		workers.Wait()
		if len(c.queue) != 0 {
			t.Fatal("closed stream retained a racing callback")
		}
		if _, bytes, err := c.ReadMessage(); err == nil || len(bytes) != 0 {
			t.Fatal("closed stream delivered a racing callback")
		}
	}
}

func TestDefaultWriteDeadlineSpansWindowAndPeerCredit(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		raw := &scheduledTestChannel{packets: make(chan string, 8)}
		c := newFlowChannel(raw, func() bool { return true })
		c.budget, c.held = newFlowBudget(), make(map[uint32]int)
		defer c.Close()
		charge := directPeerBytes - directReservedBytes
		if err := c.budget.acquire(charge, c.done, time.Time{}); err != nil {
			t.Fatal(err)
		}
		for range 4 {
			if err := c.WriteMessage(websocket.BinaryMessage, []byte("x")); err != nil {
				t.Fatal(err)
			}
		}
		released := make(chan struct{})
		go func() {
			time.Sleep(8 * time.Second)
			c.receive(webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"ack","id":4}`)})
			time.Sleep(10 * time.Second)
			c.budget.release(charge, charge)
			close(released)
		}()
		start := time.Now()
		err := c.WriteMessage(websocket.BinaryMessage, make([]byte, 1024))
		if err == nil || time.Since(start) != 15*time.Second {
			t.Fatal("write renewed its deadline between admission phases", time.Since(start), err)
		}
		<-released
	})
}

func TestExpiredPeerCreditIsNeverGranted(t *testing.T) {
	for range 64 {
		b := newFlowBudget()
		if err := b.acquire(10, make(chan struct{}), time.Now().Add(-time.Second)); err == nil {
			t.Fatal("expired request acquired credit")
		}
		if b.used != 0 || len(b.waiting) != 0 {
			t.Fatal("expired request retained credit")
		}
	}
}

func TestDefaultRelayDeadlineSpansWindowAndPoolWriter(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		conn := &websocket.Conn{} // Only its identity is used by this fake pool writer.
		pool := &transportPool{ctx: ctx, conn: conn, controls: make(chan poolWrite, 8), data: make(chan poolWrite, 8)}
		raw := &relayChannel{pool: pool, conn: conn, id: 1}
		c := newFlowChannel(raw, func() bool { return true })
		c.relay, c.sent = true, 4
		defer c.Close()
		go func() {
			time.Sleep(8 * time.Second)
			c.receive(webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"ack","id":4}`)})
			request := <-pool.data
			<-request.ctx.Done()
			request.done <- request.ctx.Err()
		}()
		start := time.Now()
		if err := c.WriteMessage(websocket.BinaryMessage, []byte("blocked pool writer")); err == nil || time.Since(start) != 15*time.Second {
			t.Fatal("pool writer renewed the stream write deadline", time.Since(start), err)
		}
	})
}
