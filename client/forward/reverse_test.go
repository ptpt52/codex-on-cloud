package main

import (
	"strings"
	"testing"
	"time"
)

func TestReverseRecoveryCannotChangeDirectionOrLocallyApprovedName(t *testing.T) {
	first := readyMessage{ID: strings.Repeat("a", 32), LocalPort: 22001, TargetHost: "192.168.1.1", TargetPort: 22, Direction: "reverse", DeviceName: "家中路由器", ResumeProtocol: 1, ResumeToken: strings.Repeat("b", 43), ResumeMs: 30000}
	s := &resumeState{reverseApproved: true}
	if err := s.accept(first); err != nil {
		t.Fatal(err)
	}
	s.deadline = time.Now().Add(10 * time.Second)
	next := first
	next.ResumeToken = ""
	if err := s.accept(next); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*readyMessage){func(r *readyMessage) { r.Direction = "" }, func(r *readyMessage) { r.DeviceName = "不同的设备" }, func(r *readyMessage) { r.TargetHost = "192.168.1.2" }, func(r *readyMessage) { r.LocalPort++ }} {
		changed := next
		mutate(&changed)
		if s.accept(changed) == nil {
			t.Fatal("Changed reverse authorization scope was accepted")
		}
	}
}
func TestReverseDeviceLabelsCannotSpoofTheLocalConsentPrompt(t *testing.T) {
	if !validDeviceName("家中路由器 SSH") {
		t.Fatal("valid label rejected")
	}
	for _, name := range []string{"", "x\nYES", "\x1b[2J", "router\u202eexample", strings.Repeat("x", 193)} {
		if validDeviceName(name) {
			t.Fatal("Unsafe terminal label accepted")
		}
	}
}
