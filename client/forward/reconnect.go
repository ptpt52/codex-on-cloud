package main

import (
	"math/rand/v2"
	"time"
)

// Count consecutive failures, not lifetime disconnects. Only a validated session
// that survives thirty seconds resets the backoff; short flaps cannot hammer the
// entry. Jitter spreads independent helper reconnects without replaying streams.
type reconnectBackoff struct {
	failures     int
	healthySince time.Time
}

func (b *reconnectBackoff) ready() { b.healthySince = time.Now() }

func (b *reconnectBackoff) next() time.Duration {
	if !b.healthySince.IsZero() && time.Since(b.healthySince) >= 30*time.Second {
		b.failures = 0
	}
	b.healthySince = time.Time{}
	ceiling := min(time.Second*time.Duration(1<<b.failures), 15*time.Second)
	b.failures = min(b.failures+1, 4)
	floor := ceiling * 3 / 4
	return floor + time.Duration(rand.Int64N(int64(ceiling-floor)+1))
}
