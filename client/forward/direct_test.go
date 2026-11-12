package main

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestDirectCandidatesRequireEncryptedDataAndKeepBoundedUnicast(t *testing.T) {
	base := "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 " + strings.Repeat("AB:", 31) + "AB\r\n"
	candidates := ""
	for _, host := range []string{"127.0.0.1", "192.168.1.2", "10.0.0.1", "172.16.1.1", "10.0.0.2", "203.0.113.8", "169.254.1.1", "2001:db8::1", "2606:4700::1", "fe80::1", "::ffff:127.0.0.1"} {
		candidates += "a=candidate:1 1 udp 123 " + host + " 40048 typ host\r\n"
	}
	result, err := directSDP(base+candidates, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(result, "a=candidate:") != 5 || strings.Contains(result, "203.0.113.8") || strings.Contains(result, "2001:db8") || strings.Contains(result, "::ffff:") {
		t.Fatal("Candidate filter admitted a forbidden address or exceeded bounds")
	}
	for _, sdp := range []string{strings.Repeat("a", 32769), strings.ReplaceAll(base, "sha-256", "sha-1"), base + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", base + "\x00"} {
		if _, err := directSDP(sdp, true); err == nil {
			t.Fatal("Accepted unencrypted, oversized or non-data SDP")
		}
	}
	for _, host := range []string{"100.64.0.1", "169.254.1.1", "fe80::1", "fc00::1", "2001:db8::1", "2002::1", "3fff::1"} {
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

func TestNATCandidatesHaveReservedSlotsAndRejectSpecialIPv4(t *testing.T) {
	base := "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 " + strings.Repeat("AB:", 31) + "AB\r\n"
	for i := 0; i < 20; i++ {
		base += "a=candidate:1 1 udp 123 10.0.0.1 40048 typ host\r\n"
	}
	base += "a=candidate:2 1 udp 100 11.0.0.2 45000 typ srflx raddr 10.0.0.1 rport 40048\r\n"
	result, err := directSDP(base, false)
	if err != nil || !strings.Contains(result, "11.0.0.2 45000 typ srflx") || strings.Count(result, "a=candidate:") != 5 {
		t.Fatal("NAT mapping was displaced by local candidates", err)
	}
	for _, host := range []string{"8.8.8.8", "11.0.0.2", "192.168.1.1", "127.0.0.1"} {
		if !directIP(net.ParseIP(host), false) {
			t.Fatalf("Rejected unicast %s", host)
		}
	}
	for _, host := range []string{"0.0.0.0", "100.64.0.1", "169.254.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255"} {
		if directIP(net.ParseIP(host), false) {
			t.Fatalf("Accepted special address %s", host)
		}
	}
}

func TestNetworkConfigurationChangesDrainOnlyNewStreams(t *testing.T) {
	for _, change := range []func(*directSignal){
		func(v *directSignal) { v.STUN = "stun:new.example:3478" },
		func(v *directSignal) { v.IPv6 = true },
		func(v *directSignal) { v.Enabled = false },
	} {
		peer := &directPeer{id: 1, ready: true, available: true, streams: map[*directChannel]struct{}{nil: {}}}
		initial := directSignal{Type: "rtc_config", Enabled: true, STUN: "stun:old.example:3478"}
		writes := 0
		manager := &directManager{peer: peer, configured: true, config: initial, wake: make(chan struct{}, 1), write: func(any) error { writes++; return nil }}
		next := initial
		change(&next)
		manager.accept(next)
		if manager.config.STUN != next.STUN || manager.config.IPv6 != next.IPv6 || manager.config.Enabled != next.Enabled || manager.peer != peer || !peer.draining || peer.available || len(peer.streams) != 1 || writes != 1 {
			t.Fatal("Network configuration was ignored or interrupted an existing stream")
		}
		manager.accept(next)
		if writes != 1 {
			t.Fatal("An identical configuration was applied twice")
		}
	}
}

func TestBusyDirectRejectionDoesNotWaitForAnSDPAnswer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rejected, finished := make(chan struct{}), make(chan struct{})
	manager := &directManager{ctx: ctx, configured: true, config: directSignal{Enabled: true}, answers: make(chan directSignal, 1), wake: make(chan struct{}, 1), report: func(string) {}}
	manager.write = func(value any) error {
		record := value.(map[string]any)
		if record["type"] == "rtc_offer" {
			manager.accept(directSignal{Type: "rtc_status", ID: record["id"].(uint32), Reason: "rtc_busy"})
			close(rejected)
		}
		return nil
	}
	defer manager.destroy()
	go func() { manager.negotiate(); close(finished) }()
	select {
	case <-rejected:
	case <-time.After(10 * time.Second):
		cancel()
		<-finished
		t.Fatal("direct offer did not reach the synthetic busy responder")
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		cancel()
		<-finished
		t.Fatal("a definitive busy rejection kept waiting for an SDP answer")
	}
	if manager.peer.pc.ConnectionState() != webrtc.PeerConnectionStateClosed {
		t.Fatal("rejected negotiation retained its ICE sockets")
	}
}

func TestOnlyCurrentTerminalStatusesRejectDirectSignaling(t *testing.T) {
	peer := &directPeer{id: 7, ready: true, healthAt: time.Now(), streams: map[*directChannel]struct{}{nil: {}}}
	manager := &directManager{peer: peer, config: directSignal{Enabled: true}, answers: make(chan directSignal, 1), wake: make(chan struct{}, 1), report: func(string) {}}
	for _, value := range []directSignal{
		{Type: "rtc_status", ID: 6, Reason: "rtc_busy"},
		{Type: "rtc_status", ID: 7, Reason: "rtc_connecting"},
		{Type: "rtc_status", ID: 7, Reason: "rtc_health_timeout"},
	} {
		manager.accept(value)
		if len(manager.answers) != 0 {
			t.Fatal("stale or nonterminal status interrupted SDP signaling")
		}
	}
	for _, reason := range []string{"rtc_busy", "rtc_negotiation_failed", "rtc_disabled"} {
		manager.accept(directSignal{Type: "rtc_status", ID: 7, Reason: reason})
		manager.accept(directSignal{Type: "rtc_status", ID: 7, Reason: reason})
		if len(manager.answers) != 1 {
			t.Fatal("rejection mailbox is not bounded to one result")
		}
		if result := <-manager.answers; result.ID != 7 || result.Reason != reason {
			t.Fatal("rejection lost its negotiation identity or reason")
		}
		if manager.peer != peer || len(peer.streams) != 1 || !manager.peerAlive(peer) {
			t.Fatal("signaling rejection closed independently healthy TCP data")
		}
	}
	if manager.config.Enabled {
		t.Fatal("disabled signaling did not stop automatic probing until new configuration")
	}
}
