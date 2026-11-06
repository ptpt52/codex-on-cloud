//go:build !windows

package main

import (
	"os"
	"time"
)

// SIGKILL bypasses the helper's cleanup. Reparenting still lets the isolated
// worker exit even when a separate goroutine is blocked inside a device driver.
func watchSerialParent(parent int) error {
	if parent < 1 || os.Getppid() != parent {
		return failure("serial_open_failed")
	}
	go func() {
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for range timer.C {
			if os.Getppid() != parent {
				os.Exit(1)
			}
		}
	}()
	return nil
}
