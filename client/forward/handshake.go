package main

import (
	"time"

	"github.com/gorilla/websocket"
)

// A protocol phase has an absolute budget. Native Ping still receives its
// bounded asynchronous Pong, but must not replace that budget with idle time.
// Only the reader owns PingHandler and SetReadDeadline, as gorilla requires.
func readHandshake(conn messageSocket, deadline time.Time) (int, []byte, error) {
	if native, ok := conn.(*websocket.Conn); ok {
		ping := native.PingHandler()
		native.SetPingHandler(func(data string) error {
			if err := ping(data); err != nil {
				return err
			}
			return native.SetReadDeadline(deadline)
		})
		defer native.SetPingHandler(ping)
	}
	if err := conn.SetReadDeadline(deadline); err != nil {
		return 0, nil, err
	}
	return conn.ReadMessage()
}
