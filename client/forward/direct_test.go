package main

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestDirectCandidatesRequireEncryptedDataAndKeepOnlyBoundedLANOrGlobalIPv6(t *testing.T) {
	base := "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 " + strings.Repeat("AB:", 31) + "AB\r\n"
	candidates := ""
	for _, host := range []string{"127.0.0.1", "192.168.1.2", "10.0.0.1", "172.16.1.1", "10.0.0.2", "8.8.8.8", "169.254.1.1", "2001:db8::1", "2606:4700::1", "fe80::1", "::ffff:127.0.0.1"} {
		candidates += "a=candidate:1 1 udp 123 " + host + " 40048 typ host\r\n"
	}
	result, err := directSDP(base+candidates, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(result, "a=candidate:") != 5 || strings.Contains(result, "8.8.8.8") || strings.Contains(result, "2001:db8") || strings.Contains(result, "::ffff:") {
		t.Fatal("Candidate filter admitted a forbidden address or exceeded bounds")
	}
	for _, sdp := range []string{strings.Repeat("a", 32769), strings.ReplaceAll(base, "sha-256", "sha-1"), base + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", base + "\x00"} {
		if _, err := directSDP(sdp, true); err == nil {
			t.Fatal("Accepted unencrypted, oversized or non-data SDP")
		}
	}
	for _, host := range []string{"8.8.8.8", "169.254.1.1", "fe80::1", "fc00::1", "2001:db8::1", "2002::1", "3fff::1"} {
		if directIP(net.ParseIP(host), true) {
			t.Fatalf("Allowed forbidden peer: %s", host)
		}
	}
}

func TestPeerRotationDoesNotCloseExistingStreamsOrOpenANewTarget(t *testing.T) {
	existing := &directChannel{}
	peer := &directPeer{id: 1, channels: 128, available: true, streams: map[*directChannel]struct{}{existing: {}}}
	records := []any{}
	manager := &directManager{peer: peer, write: func(value any) error { records = append(records, value); return nil }}
	if manager.Open(context.Background()) != nil || !peer.draining || peer.available || len(peer.streams) != 1 || len(records) != 1 {
		t.Fatal("Exhausted peer failed to preserve its existing stream and choose relay")
	}
	manager.Open(context.Background())
	if len(records) != 1 {
		t.Fatal("Repeated preflight queued duplicate drain commands")
	}
}

func TestDirectReceiveWindowRejectsExcessDataAndForgedAcknowledgments(t *testing.T) {
	for _, badACK := range []bool{false, true} {
		pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		dc, err := pc.CreateDataChannel("test", nil)
		if err != nil {
			t.Fatal(err)
		}
		wire := newDirectChannel(dc, func() bool { return false })
		if badACK {
			wire.receive(webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"ack","id":99}`)})
		} else {
			for i := 0; i < 5; i++ {
				wire.receive(webrtc.DataChannelMessage{Data: []byte("bounded")})
			}
		}
		select {
		case <-wire.done:
		default:
			t.Fatal("Unbounded receive or forged ACK remained open")
		}
		pc.Close()
	}
}

func TestDrainingPeerKeepsIdleExistingConnectionsHealthy(t *testing.T) {
	p := &directPeer{id: 1, ready: true, available: true, healthy: true, draining: true, updated: time.Now(), healthAt: time.Now()}
	m := &directManager{peer: p, report: func(string) {}}
	m.accept(directSignal{Type: "rtc_status", ID: 1, Healthy: true, Available: false, Reason: "rtc_draining"})
	if p.available || !m.peerAlive(p) {
		t.Fatal("Draining preference incorrectly marked an existing connection unhealthy")
	}
	probed := make(chan bool, 1)
	wire := &directChannel{done: make(chan struct{}), wake: make(chan struct{}, 1), queue: make(chan directRecord, 4), readDeadline: time.Now().Add(10 * time.Millisecond), longRead: true, alive: func() bool {
		healthy := m.peerAlive(p)
		select {
		case probed <- healthy:
		default:
		}
		return healthy
	}}
	type result struct {
		data []byte
		err  error
	}
	received := make(chan result, 1)
	go func() { _, bytes, err := wire.ReadMessage(); received <- result{bytes, err} }()
	select {
	case healthy := <-probed:
		if !healthy {
			t.Fatal("Draining peer lost its old connection health")
		}
	case <-time.After(time.Second):
		t.Fatal("Idle deadline was not checked")
	}
	wire.receive(webrtc.DataChannelMessage{Data: []byte("old connection remains usable")})
	select {
	case value := <-received:
		if value.err != nil || string(value.data) != "old connection remains usable" {
			t.Fatalf("Idle draining connection expired: %v", value.err)
		}
	case <-time.After(time.Second):
		t.Fatal("Idle draining connection did not resume")
	}
}

func TestExistingPeerHealthDoesNotDependOnManagementStatus(t *testing.T) {
	p := &directPeer{ready: true, healthy: true, updated: time.Now().Add(-20 * time.Second), healthAt: time.Now()}
	m := &directManager{peer: p}
	if !m.peerAlive(p) {
		t.Fatal("Fresh data-channel health was lost with stale management status")
	}
	p.healthAt = time.Now().Add(-11 * time.Second)
	p.updated = time.Now()
	if m.peerAlive(p) {
		t.Fatal("Management status kept a silent direct peer alive")
	}
	if m.peerAlive(&directPeer{ready: true, healthAt: time.Now()}) {
		t.Fatal("A different peer authorized an old stream")
	}
}

func TestRenegotiationCannotReplaceAnAdmittedStreamOrAnOfflinePeer(t *testing.T) {
	for _, offline := range []bool{false, true} {
		p := &directPeer{streams: make(map[*directChannel]struct{})}
		if !offline {
			p.streams[&directChannel{}] = struct{}{}
		}
		m := &directManager{peer: p, online: func() bool { return !offline }}
		m.negotiate()
		if m.peer != p {
			t.Fatal("Peer was detached after stream admission or management loss")
		}
	}
}

func TestHintCandidatesHaveSeparateBoundAndConfigUpdatesPreservePeer(t *testing.T) {
	base := "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 " + strings.Repeat("AB:", 31) + "AB\r\n"
	for i := 0; i < 5; i++ {
		base += "a=candidate:1 1 udp 123 127.0.0.1 40048 typ host\r\n"
	}
	for i := 0; i < 5; i++ {
		base += "a=candidate:hint1 1 udp 122 10.0.0.1 40048 typ host\r\n"
	}
	result, err := directSDP(base, false)
	if err != nil || strings.Count(result, "a=candidate:") != 8 {
		t.Fatal("hint candidate bounds", err)
	}
	p := &directPeer{id: 1, ready: true, available: true, streams: map[*directChannel]struct{}{nil: {}}}
	m := &directManager{peer: p, configured: true, wake: make(chan struct{}, 1), write: func(any) error { return nil }}
	cfg := directSignal{Type: "rtc_config", Enabled: true}
	cfg.Hints.Browser = "10.0.0.1"
	m.accept(cfg)
	if m.peer != p || !p.draining || p.available || len(p.streams) != 1 || !m.hintsChanged {
		t.Fatal("config update interrupted old streams")
	}
}
