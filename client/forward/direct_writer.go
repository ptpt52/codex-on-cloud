package main

import (
	"context"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// One writer per peer, one record per stream per turn. Native SCTP owns packet
// reliability; this only bounds admission and gives small control records room.
type directWrite struct {
	data                []byte
	text, priority, ack bool
	ctx                 context.Context
	done                chan error
}
type schedulableChannel interface {
	flowSender
	ReadyState() webrtc.DataChannelState
	SetBufferedAmountLowThreshold(uint64)
	OnBufferedAmountLow(func())
}
type scheduledChannel struct {
	writer          *directWriter
	raw             schedulableChannel
	control, closed bool
	done            chan struct{}
	queue           []*directWrite
	bytes           int
}
type directWriter struct {
	mu               sync.Mutex
	ctx              context.Context
	cancel           context.CancelFunc
	done, wake       chan struct{}
	groups           []*scheduledChannel
	next             int
	queued, controls int
	budget           *flowBudget
}

func newDirectWriter(ctx context.Context) *directWriter {
	ctx, cancel := context.WithCancel(ctx)
	w := &directWriter{ctx: ctx, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1), budget: newFlowBudget()}
	go w.run()
	return w
}
func (w *directWriter) notify() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}
func (w *directWriter) channel(raw schedulableChannel, control bool) *scheduledChannel {
	w.mu.Lock()
	w.prune()
	if w.ctx.Err() != nil || len(w.groups) >= 32 {
		w.mu.Unlock()
		return nil
	}
	c := &scheduledChannel{writer: w, raw: raw, control: control, done: make(chan struct{})}
	w.groups = append(w.groups, c)
	w.mu.Unlock()
	raw.SetBufferedAmountLowThreshold(0)
	raw.OnBufferedAmountLow(w.notify)
	return c
}
func (w *directWriter) prune() {
	kept := w.groups[:0]
	for _, group := range w.groups {
		if group.closed && group.raw.ReadyState() == webrtc.DataChannelStateClosed {
			continue
		}
		kept = append(kept, group)
	}
	w.groups = kept
	if w.next >= len(kept) {
		w.next = 0
	}
}
func (c *scheduledChannel) send(data []byte, text, ack bool, deadline time.Time) error {
	w := c.writer
	priority := c.control || text
	if len(data) == 0 || len(data) > chunkSize {
		return failure("buffer_limit")
	}
	timeout := 15 * time.Second
	if priority {
		timeout = 5 * time.Second
	}
	limit := time.Now().Add(timeout)
	if !deadline.IsZero() && deadline.Before(limit) {
		limit = deadline
	}
	ctx, cancel := context.WithDeadline(w.ctx, limit)
	defer cancel()
	request := &directWrite{data: append([]byte(nil), data...), text: text, priority: priority, ack: ack, ctx: ctx, done: make(chan error, 1)}
	w.mu.Lock()
	if c.closed || w.ctx.Err() != nil || len(c.queue) >= 32 || c.bytes+len(data) > 512*1024 || w.queued+len(data) > 1024*1024 || priority && w.controls+len(data) > 65536 {
		w.mu.Unlock()
		return failure("buffer_limit")
	}
	if ack {
		at := 0
		for at < len(c.queue) && c.queue[at].ack {
			at++
		}
		c.queue = append(c.queue, nil)
		copy(c.queue[at+1:], c.queue[at:])
		c.queue[at] = request
	} else {
		c.queue = append(c.queue, request)
	}
	c.bytes += len(data)
	w.queued += len(data)
	if priority {
		w.controls += len(data)
	}
	w.mu.Unlock()
	w.notify()
	select {
	case err := <-request.done:
		return err
	case <-c.done:
		return failure("rtc_unavailable")
	case <-ctx.Done():
		return failure("rtc_health_timeout")
	}
}
func (c *scheduledChannel) Send(data []byte) error { return c.send(data, false, false, time.Time{}) }
func (c *scheduledChannel) SendText(data string) error {
	return c.send([]byte(data), true, false, time.Time{})
}
func (c *scheduledChannel) SendACK(data string) error {
	return c.send([]byte(data), true, true, time.Time{})
}
func (c *scheduledChannel) sendDeadline(data []byte, text bool, deadline time.Time) error {
	return c.send(data, text, false, deadline)
}
func (c *scheduledChannel) BufferedAmount() uint64 {
	c.writer.mu.Lock()
	defer c.writer.mu.Unlock()
	return uint64(c.bytes) + c.raw.BufferedAmount()
}
func (c *scheduledChannel) Close() error           { return c.close(false) }
func (c *scheduledChannel) CloseGracefully() error { return c.close(true) }
func (c *scheduledChannel) close(graceful bool) error {
	w := c.writer
	w.mu.Lock()
	if c.closed {
		w.mu.Unlock()
		return nil
	}
	c.closed = true
	kept := c.queue[:0]
	for _, request := range c.queue {
		if graceful && request.ack {
			kept = append(kept, request)
			continue
		}
		w.queued -= len(request.data)
		c.bytes -= len(request.data)
		if request.priority {
			w.controls -= len(request.data)
		}
		request.done <- failure("rtc_unavailable")
	}
	c.queue = kept
	w.mu.Unlock()
	w.notify()
	if graceful {
		// ACKs were accepted by the application, but may still be in SCTP.
		// Resetting their stream immediately can strand the peer's final FIN.
		deadline := time.NewTimer(time.Second)
		ticker := time.NewTicker(2 * time.Millisecond)
	drain:
		for {
			w.mu.Lock()
			pending := len(c.queue) > 0
			w.mu.Unlock()
			if !pending && c.raw.BufferedAmount() == 0 {
				break
			}
			select {
			case <-w.ctx.Done():
				break drain
			case <-deadline.C:
				break drain
			case <-ticker.C:
			}
		}
		deadline.Stop()
		ticker.Stop()
	}
	w.mu.Lock()
	close(c.done)
	for _, request := range c.queue {
		w.queued -= len(request.data)
		c.bytes -= len(request.data)
		if request.priority {
			w.controls -= len(request.data)
		}
		request.done <- failure("rtc_unavailable")
	}
	c.queue = nil
	w.mu.Unlock()
	w.notify()
	return c.raw.Close()
}
func (w *directWriter) take() (*scheduledChannel, *directWrite) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.prune()
	index := -1
	native := uint64(0)
	for _, group := range w.groups {
		native += group.raw.BufferedAmount()
	}
	for step := 0; step < len(w.groups); step++ {
		i := (w.next + step) % len(w.groups)
		group := w.groups[i]
		if len(group.queue) == 0 || group.closed && !group.queue[0].ack {
			continue
		}
		if index < 0 || group.queue[0].priority {
			index = i
		}
		if group.queue[0].priority {
			break
		}
	}
	if index < 0 {
		return nil, nil
	}
	group := w.groups[index]
	request := group.queue[0]
	limit := uint64(128 * 1024)
	if request.priority {
		limit += 65536
	}
	if request.ctx.Err() == nil && native+uint64(len(request.data)) > limit {
		return nil, nil
	}
	group.queue = group.queue[1:]
	group.bytes -= len(request.data)
	w.queued -= len(request.data)
	if request.priority {
		w.controls -= len(request.data)
	}
	w.next = (index + 1) % len(w.groups)
	return group, request
}
func (w *directWriter) run() {
	defer close(w.done)
	for {
		if w.ctx.Err() != nil {
			return
		}
		if group, request := w.take(); request != nil {
			err := request.ctx.Err()
			if err == nil {
				select {
				case <-group.done:
					err = failure("rtc_unavailable")
				default:
				}
			}
			if err == nil {
				if request.text {
					err = group.raw.SendText(string(request.data))
				} else {
					err = group.raw.Send(request.data)
				}
			}
			request.done <- err
			continue
		}
		w.mu.Lock()
		pending := w.queued > 0
		w.mu.Unlock()
		if !pending {
			select {
			case <-w.ctx.Done():
				return
			case <-w.wake:
				continue
			}
		}
		timer := time.NewTimer(2 * time.Millisecond)
		select {
		case <-w.ctx.Done():
			timer.Stop()
			return
		case <-w.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}
func (w *directWriter) close() { w.cancel(); w.budget.close(); w.notify() }
