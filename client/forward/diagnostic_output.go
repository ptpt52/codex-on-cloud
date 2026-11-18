package main

import (
	"io"
	"sync"
	"time"
)

const diagnosticRecords = 64
const diagnosticBytes = 8192
const diagnosticFlush = 100 * time.Millisecond

// Best-effort runtime diagnostics must never backpressure protocol readers or
// shutdown. One worker owns the external writer, with at most 64 short records
// including its current write (512 KiB). An uncooperative io.Writer can hold
// that one worker until process exit, but cannot create more workers or retain
// queued output after Close. The caller's stdout is never closed.
type diagnosticOutput struct {
	mu                      sync.Mutex
	writer                  io.Writer
	queue                   [][]byte
	pending                 int
	running, closing, ended bool
	done                    chan struct{}
}

func (o *diagnosticOutput) Write(data []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closing || o.ended || o.pending >= diagnosticRecords || len(data) == 0 {
		return len(data), nil
	}
	o.queue = append(o.queue, append([]byte(nil), data[:min(len(data), diagnosticBytes)]...))
	o.pending++
	if !o.running {
		o.running = true
		o.done = make(chan struct{})
		go o.run(o.done)
	}
	return len(data), nil
}

func (o *diagnosticOutput) discard() {
	o.ended = true
	o.pending -= len(o.queue)
	o.queue = nil
}

func (o *diagnosticOutput) run(done chan struct{}) {
	for {
		o.mu.Lock()
		if o.ended || len(o.queue) == 0 {
			o.running = false
			close(done)
			o.mu.Unlock()
			return
		}
		record := o.queue[0]
		o.queue[0] = nil
		o.queue = o.queue[1:]
		o.mu.Unlock()
		_, err := o.writer.Write(record)
		o.mu.Lock()
		o.pending--
		if err != nil {
			o.discard()
		}
		o.mu.Unlock()
	}
}

func (o *diagnosticOutput) Close() error {
	o.mu.Lock()
	o.closing = true
	done, running := o.done, o.running
	o.mu.Unlock()
	if running {
		timer := time.NewTimer(diagnosticFlush)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
		}
	}
	o.mu.Lock()
	o.discard()
	o.mu.Unlock()
	return nil
}
