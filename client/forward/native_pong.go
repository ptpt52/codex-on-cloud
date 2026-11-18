package main

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const nativePongLimit = 16
const nativePongTimeout = 5 * time.Second

type nativeControlSocket interface {
	WriteControl(int, []byte, time.Time) error
	Close() error
}
type nativePong struct {
	data     []byte
	deadline time.Time
}

// A reader must not wait for Gorilla's write lock to answer Ping. Keep at most
// sixteen Pongs (including the native write), with one worker only while busy.
// The captured socket and original deadline fence every queued response.
type nativePongWriter struct {
	mu             sync.Mutex
	conn           nativeControlSocket
	queue          []nativePong
	pending        int
	running, ended bool
}

func (w *nativePongWriter) enqueue(data string) error {
	w.mu.Lock()
	if w.ended || len(data) > 125 || w.pending >= nativePongLimit {
		w.ended = true
		w.queue = nil
		w.mu.Unlock()
		w.conn.Close()
		return failure("buffer_limit")
	}
	w.queue = append(w.queue, nativePong{data: []byte(data), deadline: time.Now().Add(nativePongTimeout)})
	w.pending++
	if !w.running {
		w.running = true
		go w.run()
	}
	w.mu.Unlock()
	return nil
}

func (w *nativePongWriter) run() {
	for {
		w.mu.Lock()
		if w.ended || len(w.queue) == 0 {
			w.running = false
			w.mu.Unlock()
			return
		}
		record := w.queue[0]
		w.queue[0] = nativePong{}
		w.queue = w.queue[1:]
		w.mu.Unlock()
		err := w.conn.WriteControl(websocket.PongMessage, record.data, record.deadline)
		w.mu.Lock()
		w.pending--
		if err != nil {
			w.ended = true
			w.queue = nil
		}
		w.mu.Unlock()
		if err != nil {
			w.conn.Close()
		}
	}
}
