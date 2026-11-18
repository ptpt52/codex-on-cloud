package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type heldDiagnosticWriter struct {
	entered chan struct{}
	release chan struct{}
	writes  atomic.Int32
	bytes   atomic.Int32
}

func (w *heldDiagnosticWriter) Write(data []byte) (int, error) {
	if w.writes.Add(1) == 1 {
		close(w.entered)
	}
	w.bytes.Store(int32(len(data)))
	<-w.release
	return len(data), nil
}

func TestDiagnosticOutputBoundsBlockedWriterWithoutBlockingProducersOrClose(t *testing.T) {
	w := &heldDiagnosticWriter{entered: make(chan struct{}), release: make(chan struct{})}
	o := &diagnosticOutput{writer: w}
	defer close(w.release)
	data := bytes.Repeat([]byte("x"), 2*diagnosticBytes)
	o.Write(data)
	<-w.entered
	var workers sync.WaitGroup
	for n := 0; n < 8; n++ {
		workers.Go(func() {
			for n := 0; n < 1000; n++ {
				o.Write(data)
			}
		})
	}
	workers.Wait()
	o.mu.Lock()
	if o.pending != diagnosticRecords || len(o.queue) != diagnosticRecords-1 {
		t.Fatal("diagnostic admission lost its record bound", o.pending, len(o.queue))
	}
	for _, record := range o.queue {
		if len(record) > diagnosticBytes {
			t.Fatal("oversized retained diagnostic")
		}
	}
	done := o.done
	o.mu.Unlock()
	if w.writes.Load() != 1 || w.bytes.Load() != diagnosticBytes {
		t.Fatal("blocked output spawned another writer or exceeded its byte bound")
	}
	closed := make(chan struct{})
	go func() { o.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("shutdown waited on an uncooperative diagnostic consumer")
	}
	o.Write([]byte("after close"))
	o.mu.Lock()
	pending, queued := o.pending, len(o.queue)
	o.mu.Unlock()
	if queued != 0 || pending != 1 {
		t.Fatal("close retained queued diagnostics", queued, pending)
	}
	// Close must not close the external destination or wait for its current write.
	select {
	case <-done:
		t.Fatal("fixture did not retain its one blocked write")
	default:
	}
}

type failedDiagnosticWriter struct{ writes atomic.Int32 }

func (w *failedDiagnosticWriter) Write([]byte) (int, error) {
	w.writes.Add(1)
	return 0, errors.New("synthetic unavailable output")
}
func TestDiagnosticDestinationFailureCannotFailNetworkingOrRestartTheWriter(t *testing.T) {
	w := &failedDiagnosticWriter{}
	o := &diagnosticOutput{writer: w}
	if _, err := o.Write([]byte("diagnostic")); err != nil {
		t.Fatal(err)
	}
	o.mu.Lock()
	done := o.done
	o.mu.Unlock()
	<-done
	for n := 0; n < 100; n++ {
		o.Write([]byte("ignored"))
	}
	o.Close()
	if w.writes.Load() != 1 {
		t.Fatal("failed destination was retried")
	}
}

func TestStatusReportingRunsOutsidePeerLock(t *testing.T) {
	peer := &directPeer{id: 7, ready: true, healthAt: time.Now()}
	m := &directManager{ctx: context.Background(), peer: peer, wake: make(chan struct{}, 1)}
	reported := make(chan bool, 1)
	m.report = func(string) { reported <- m.peerAlive(peer) }
	go m.accept(directSignal{Type: "rtc_status", ID: 7, Available: true, Healthy: true, Family: "IPv4"})
	select {
	case alive := <-reported:
		if !alive {
			t.Fatal("wrong peer reported")
		}
	case <-time.After(time.Second):
		t.Fatal("report callback held the peer lock")
	}
}

func TestDiagnosticFlushPreservesOrderedShortOutputAndCategoryBounds(t *testing.T) {
	var writer bytes.Buffer
	o := &diagnosticOutput{writer: &writer}
	output := &runOutput{writer: o}
	for n := 0; n < 30; n++ {
		output.print(0, "record %d", n)
	}
	o.Close()
	if bytes.Count(writer.Bytes(), []byte("record ")) != 20 || bytes.Count(writer.Bytes(), []byte("20 条上限")) != 1 {
		t.Fatal("category bounds or healthy flush were lost")
	}
	for n := 0; n < 20; n++ {
		if !bytes.Contains(writer.Bytes(), []byte(fmt.Sprintf("record %d\n", n))) {
			t.Fatal("ordered output was dropped")
		}
	}
}
