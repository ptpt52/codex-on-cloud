package main

import (
	"sync"
	"time"
)

const directPeerBytes = 512 * 1024
const directWindowLegacy = 4
const directWindowMax = 16

func validWindow(window int) bool {
	return window == directWindowLegacy || window == 8 || window == directWindowMax
}

type creditWaiter struct {
	size    int
	ready   chan struct{}
	granted bool
	err     error
}
type flowBudget struct {
	mu                sync.Mutex
	used, limit, peak int
	waiting           []*creditWaiter
	closed            bool
}

func newFlowBudget() *flowBudget { return &flowBudget{limit: directPeerBytes} }
func (b *flowBudget) grant() {
	for index := 0; index < len(b.waiting); {
		request := b.waiting[index]
		if b.used+request.size > b.limit {
			break
		}
		b.waiting = append(b.waiting[:index], b.waiting[index+1:]...)
		b.used += request.size
		b.peak = max(b.peak, b.used)
		request.granted = true
		close(request.ready)
	}
}
func (b *flowBudget) acquire(size int, done <-chan struct{}, deadline time.Time) error {
	b.mu.Lock()
	if b.closed || size < 0 || size > b.limit || len(b.waiting) >= 32 {
		b.mu.Unlock()
		return failure("buffer_limit")
	}
	request := &creditWaiter{size: size, ready: make(chan struct{})}
	b.waiting = append(b.waiting, request)
	b.grant()
	b.mu.Unlock()
	if deadline.IsZero() {
		deadline = time.Now().Add(15 * time.Second)
	}
	timer := time.NewTimer(max(0, time.Until(deadline)))
	defer timer.Stop()
	cancel := func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if request.granted {
			b.used -= size
			request.granted = false
		} else {
			for i, item := range b.waiting {
				if item == request {
					b.waiting = append(b.waiting[:i], b.waiting[i+1:]...)
					break
				}
			}
		}
		b.grant()
	}
	select {
	case <-request.ready:
		if request.err != nil {
			return request.err
		}
		select {
		case <-done:
			cancel()
			return failure("rtc_unavailable")
		default:
			return nil
		}
	case <-done:
		cancel()
		return failure("rtc_unavailable")
	case <-timer.C:
		cancel()
		return failure("rtc_health_timeout")
	}
}
func (b *flowBudget) release(size int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if size < 0 || size > b.used {
		panic("invalid peer flow credit")
	}
	b.used -= size
	b.grant()
}
func (b *flowBudget) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for _, request := range b.waiting {
		request.err = failure("rtc_unavailable")
		close(request.ready)
	}
	b.waiting = nil
}
