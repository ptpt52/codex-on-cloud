package main

import (
	"testing"
	"testing/synctest"
	"time"
)

func TestReconnectBackoffRecoversAfterStableSessionsWithoutResettingOnFlaps(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var backoff reconnectBackoff
		for cycle := 0; cycle < 3; cycle++ {
			for range 8 {
				if delay := backoff.next(); delay < 750*time.Millisecond || delay > 15*time.Second {
					t.Fatal("reconnect delay escaped its bounds", delay)
				}
			}
			backoff.ready()
			time.Sleep(29 * time.Second)
			if delay := backoff.next(); delay < 11*time.Second {
				t.Fatal("a short-lived validated session reset the backoff", delay)
			}
			time.Sleep(time.Hour)
			if delay := backoff.next(); delay < 11*time.Second {
				t.Fatal("offline time was counted as a stable session", delay)
			}
			backoff.ready()
			time.Sleep(30 * time.Second)
			if delay := backoff.next(); delay < 750*time.Millisecond || delay > time.Second {
				t.Fatal("historical disconnects delayed a recovered session", delay)
			}
		}
	})
}
