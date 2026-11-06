package main

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestResumeAuthorizationKeepsMappingScopeAndCannotExtendDeadline(t *testing.T) {
	first := readyMessage{ID: strings.Repeat("a", 32), LocalPort: 2222, TargetPort: 22, ResumeProtocol: 1, ResumeToken: strings.Repeat("b", 43), ResumeMs: 30000}
	s := &resumeState{}
	if err := s.accept(first); err != nil {
		t.Fatal(err)
	}
	s.deadline = time.Now().Add(5 * time.Second)
	before := s.deadline
	resumed := first
	resumed.ResumeToken = ""
	if err := s.accept(resumed); err != nil {
		t.Fatal(err)
	}
	if !s.deadline.Equal(before) {
		t.Fatal("A repeated handshake extended the recovery deadline")
	}
	resumed.ResumeMs = 1000
	if err := s.accept(resumed); err != nil {
		t.Fatal(err)
	}
	if !s.deadline.Before(before) {
		t.Fatal("Server's shorter deadline was ignored")
	}
	for _, mutation := range []func(*readyMessage){
		func(r *readyMessage) { r.ID = strings.Repeat("c", 32) }, func(r *readyMessage) { r.LocalPort++ },
		func(r *readyMessage) { r.TargetHost = "192.168.1.10" },
		func(r *readyMessage) { r.TargetPort++ }, func(r *readyMessage) { r.ResumeProtocol = 0 },
		func(r *readyMessage) { r.ResumeToken = first.ResumeToken }, func(r *readyMessage) { r.ResumeMs = 30001 },
		func(r *readyMessage) { r.ResumeMs = 0 },
	} {
		r := resumed
		mutation(&r)
		if s.accept(r) == nil {
			t.Fatal("Changed resume scope was accepted")
		}
	}
	if err := (&resumeState{}).accept(readyMessage{}); err != nil {
		t.Fatal("Old server compatibility failed")
	}
	first.ResumeToken = "invalid"
	if (&resumeState{}).accept(first) == nil {
		t.Fatal("Invalid resume capability accepted")
	}
}

func TestCustomTargetRecoveryBindsIPv4AndIPv6AndKeepsOldServerCompatibility(t *testing.T) {
	for _, host := range []string{"192.168.1.10", "2001:db8::1", "::1"} {
		first := readyMessage{ID: strings.Repeat("a", 32), LocalPort: 2222, TargetHost: host, TargetPort: 5432, ResumeProtocol: 1, ResumeToken: strings.Repeat("b", 43), ResumeMs: 30000}
		s := &resumeState{}
		if err := s.accept(first); err != nil {
			t.Fatal(err)
		}
		resumed := first
		resumed.ResumeToken = ""
		if host == "2001:db8::1" {
			resumed.TargetHost = "2001:0DB8:0:0:0:0:0:1"
		}
		if err := s.accept(resumed); err != nil {
			t.Fatal("Equivalent target rejected", err)
		}
		resumed.TargetHost = ""
		if s.accept(resumed) == nil {
			t.Fatal("Missing target changed custom mapping to loopback")
		}
	}
	for _, host := range []string{"example.com", "127.0.0.1:22", "fe80::1%eth0", "1.2.3.4\ncommand", strings.Repeat("a", 65)} {
		if (&resumeState{}).accept(readyMessage{TargetHost: host}) == nil {
			t.Fatal("Invalid destination accepted")
		}
	}
}

func TestOnlyTransientManagementFailuresCanResume(t *testing.T) {
	for _, code := range []string{"helper_reconnecting", "resume_busy", "network_disconnected", "network_timeout", "network_failed", "dns_failed", "server_unavailable"} {
		if !canResume(failure(code)) {
			t.Fatalf("Transient %s did not allow recovery", code)
		}
	}
	for _, code := range []string{"stopped", "signed_out", "authorization_expired", "authorization_revoked", "helper_stopped", "resume_expired", "resume_authorization_invalid", "protocol_error", "local_port_in_use", "tls_certificate", "outer_auth_required", "server_stopping", "pair_used", "stream_authorization_invalid"} {
		if canResume(failure(code)) {
			t.Fatalf("Terminal %s allowed recovery", code)
		}
	}
	if canResume(errors.New("untrusted network error with secret")) {
		t.Fatal("Unclassified error allowed recovery")
	}
}

func TestDiagnosticsStayBoundedAcrossConcurrentSessionGenerations(t *testing.T) {
	var writer bytes.Buffer
	output := &runOutput{writer: &writer}
	var workers sync.WaitGroup
	for i := 0; i < 100; i++ {
		workers.Go(func() {
			for category := 0; category < 3; category++ {
				output.print(category, "record %d", category)
			}
		})
	}
	workers.Wait()
	for category := 0; category < 3; category++ {
		if strings.Count(writer.String(), "record "+string(rune('0'+category))) != 20 {
			t.Fatal("Diagnostic limit was reset across generations")
		}
	}
	if strings.Count(writer.String(), "20 条上限") != 3 {
		t.Fatal("Missing bounded output notices")
	}
	if strings.Count(writer.String(), "这不是连接数量限制，不影响转发") != 3 {
		t.Fatal("Output caps must not be described as connection caps")
	}
}
