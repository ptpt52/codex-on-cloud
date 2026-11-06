package main

import (
	"golang.org/x/sys/windows"
	"os"
)

// Windows preserves the original parent PID after it exits, so wait on a real
// process handle instead of polling the PID or relying on EOF during a write.
func watchSerialParent(parent int) error {
	if parent < 1 || os.Getppid() != parent {
		return failure("serial_open_failed")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(parent))
	if err != nil {
		return failure("serial_open_failed")
	}
	go func() {
		defer windows.CloseHandle(handle)
		_, _ = windows.WaitForSingleObject(handle, windows.INFINITE)
		os.Exit(1)
	}()
	return nil
}
