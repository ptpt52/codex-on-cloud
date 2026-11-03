package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

var globalSix = netip.MustParsePrefix("2000::/3")
var specialSix = []netip.Prefix{netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20")}
var directFingerprint = regexp.MustCompile(`^a=fingerprint:sha-256 (?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$`)

func directIP(ip net.IP, ipv6 bool) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	if address.Is4() {
		return address.IsLoopback() || address.IsPrivate()
	}
	if !ipv6 || !globalSix.Contains(address) {
		return false
	}
	for _, prefix := range specialSix {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}
func directSDP(sdp string, ipv6 bool) (string, error) {
	if len(sdp) > 32768 || strings.ContainsRune(sdp, 0) {
		return "", failure("protocol_error")
	}
	lines := strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n")
	result := make([]string, 0, len(lines))
	v4, v6 := 0, 0
	media, fingerprint := 0, false
	for _, line := range lines {
		if strings.HasPrefix(line, "m=") {
			media++
			fields := strings.Fields(line)
			if len(fields) != 4 || fields[0] != "m=application" || fields[2] != "UDP/DTLS/SCTP" || fields[3] != "webrtc-datachannel" {
				return "", failure("protocol_error")
			}
		}
		if directFingerprint.MatchString(line) {
			fingerprint = true
		}
		if strings.HasPrefix(line, "a=remote-candidates:") {
			continue
		}
		if strings.HasPrefix(line, "a=candidate:") {
			fields := strings.Fields(strings.TrimPrefix(line, "a=candidate:"))
			if len(fields) < 8 || fields[1] != "1" || strings.ToLower(fields[2]) != "udp" || !directIP(net.ParseIP(fields[4]), ipv6) || (fields[7] != "host" && fields[7] != "srflx") {
				continue
			}
			port, err := strconv.Atoi(fields[5])
			address, parseErr := netip.ParseAddr(fields[4])
			if err != nil || port < 1024 || port > 65535 || parseErr != nil || address.Is4In6() || fields[6] != "typ" {
				continue
			}
			if strings.Contains(fields[4], ":") {
				if v6 >= 4 {
					continue
				}
				v6++
			} else {
				if fields[7] != "host" || v4 >= 4 {
					continue
				}
				v4++
			}
		}
		result = append(result, line)
	}
	if media != 1 || !fingerprint {
		return "", failure("protocol_error")
	}
	return strings.Join(result, "\r\n"), nil
}

type directSignal struct {
	Type      string `json:"type"`
	ID        uint32 `json:"id"`
	SDP       string `json:"sdp"`
	Enabled   bool   `json:"enabled"`
	IPv6      bool   `json:"ipv6"`
	STUN      string `json:"stun"`
	Available bool   `json:"available"`
	Healthy   bool   `json:"healthy"`
	Family    string `json:"family"`
	RTT       *int   `json:"rttMs"`
	Reason    string `json:"reason"`
}
type directPeer struct {
	pc               *webrtc.PeerConnection
	health           *webrtc.DataChannel
	id               uint32
	ready, available bool
	healthy          bool
	updated          time.Time
	streams          map[*directChannel]struct{}
	channels         int
	draining         bool
}
type directManager struct {
	mu         sync.Mutex
	ctx        context.Context
	cancel     context.CancelFunc
	write      func(any) error
	report     func(string)
	token      string
	peer       *directPeer
	config     directSignal
	configured bool
	id         uint32
	answers    chan directSignal
	wake       chan struct{}
	done       chan struct{}
	lastStatus string
}

func newDirectManager(ctx context.Context, token string, write func(any) error, report func(string)) *directManager {
	ctx, cancel := context.WithCancel(ctx)
	m := &directManager{ctx: ctx, cancel: cancel, token: token, write: write, report: report, answers: make(chan directSignal, 1), wake: make(chan struct{}, 1), done: make(chan struct{})}
	go m.run()
	return m
}
func (m *directManager) accept(value directSignal) {
	m.mu.Lock()
	switch value.Type {
	case "rtc_config":
		if m.configured {
			m.mu.Unlock()
			return
		}
		m.config = value
		m.configured = true
	case "rtc_answer":
		if m.peer != nil && value.ID == m.peer.id {
			select {
			case m.answers <- value:
			default:
			}
		}
	case "rtc_status":
		if m.peer == nil || value.ID != m.peer.id {
			m.mu.Unlock()
			return
		}
		if value.Family != "IPv4" && value.Family != "IPv6" {
			value.Available = false
			value.Family = ""
		}
		if value.RTT != nil && (*value.RTT < 0 || *value.RTT > 60000) {
			value.RTT = nil
		}
		if value.Reason != "" && failureMessages[value.Reason] == "" {
			value.Reason = "rtc_unavailable"
		}
		m.peer.available = value.Available && m.peer.ready && !m.peer.draining
		m.peer.healthy = value.Healthy && m.peer.ready
		m.peer.updated = time.Now()
		label := "新连接使用 WSS 中转"
		if m.peer.available {
			label = "新连接优先使用 " + value.Family + " / UDP 加密直连"
			if value.RTT != nil {
				label += "（往返延迟 " + strconv.Itoa(*value.RTT) + " ms）"
			}
		} else if message := failureMessages[value.Reason]; message != "" {
			label += "：" + message
		}
		key := value.Reason + value.Family
		if m.peer.available {
			key = "direct" + value.Family
		}
		if key != m.lastStatus {
			m.lastStatus = key
			m.report(label)
		}
	}
	m.mu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}
func networkSignature() [32]byte {
	interfaces, _ := net.Interfaces()
	addresses := make([]string, 0, 64)
	for _, item := range interfaces {
		if len(addresses) >= 64 {
			break
		}
		rows, _ := item.Addrs()
		for _, address := range rows {
			if len(addresses) >= 64 {
				break
			}
			addresses = append(addresses, address.String())
		}
	}
	sort.Strings(addresses)
	return sha256.Sum256([]byte(strings.Join(addresses, "\n")))
}
func (m *directManager) run() {
	defer close(m.done)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	next := time.Now()
	delay := 15 * time.Second
	signature := networkSignature()
	for {
		m.mu.Lock()
		enabled := m.configured && m.config.Enabled
		p := m.peer
		healthy := p != nil && p.ready && p.available && time.Since(p.updated) < 10*time.Second
		busy := p != nil && len(p.streams) > 0
		m.mu.Unlock()
		if enabled && !healthy && !busy && !time.Now().Before(next) {
			m.negotiate()
			next = time.Now().Add(delay)
			delay = min(delay*2, 60*time.Second)
		}
		if healthy {
			delay = 15 * time.Second
			next = time.Now().Add(delay)
		}
		select {
		case <-m.ctx.Done():
			m.destroy()
			return
		case <-m.wake:
		case <-ticker.C:
			changed := networkSignature()
			if changed != signature {
				signature = changed
				next = time.Now()
				delay = 15 * time.Second
			}
		}
	}
}
func (m *directManager) destroy() {
	m.mu.Lock()
	p := m.peer
	m.peer = nil
	m.mu.Unlock()
	if p != nil {
		p.pc.Close()
	}
}
func (m *directManager) Close() { m.cancel(); <-m.done }
func (m *directManager) negotiate() {
	m.destroy()
	select {
	case <-m.answers:
	default:
	}
	m.mu.Lock()
	config := m.config
	m.id++
	id := m.id
	m.mu.Unlock()
	if id > 2147483647 {
		return
	}
	var settings webrtc.SettingEngine
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return directIP(ip, config.IPv6) })
	settings.SetRemoteIPFilter(func(ip net.IP) bool { return directIP(ip, config.IPv6) })
	settings.SetSCTPMaxReceiveBufferSize(1024 * 1024)
	settings.SetSCTPMaxMessageSize(chunkSize)
	settings.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	if settings.SetEphemeralUDPPortRange(40048, 40111) != nil {
		return
	}
	logger := logging.NewDefaultLoggerFactory()
	logger.DefaultLogLevel = logging.LogLevelDisabled
	logger.Writer = io.Discard
	settings.LoggerFactory = logger
	servers := []webrtc.ICEServer{}
	if strings.HasPrefix(config.STUN, "stun:") && len(config.STUN) <= 256 && !strings.ContainsAny(config.STUN, "@/?#\r\n") {
		servers = append(servers, webrtc.ICEServer{URLs: []string{config.STUN}})
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return
	}
	p := &directPeer{pc: pc, id: id, streams: make(map[*directChannel]struct{})}
	m.mu.Lock()
	m.peer = p
	m.mu.Unlock()
	pc.OnDataChannel(func(*webrtc.DataChannel) { go pc.Close() })
	failed := true
	defer func() {
		if failed {
			m.mu.Lock()
			if m.peer == p {
				p.available = false
			}
			m.mu.Unlock()
			pc.Close()
		}
	}()
	protocol := "forward-health-v1"
	ordered := true
	health, err := pc.CreateDataChannel("codex-forward-health", &webrtc.DataChannelInit{Protocol: &protocol, Ordered: &ordered})
	if err != nil {
		return
	}
	p.health = health
	health.OnOpen(func() {
		bytes, _ := json.Marshal(map[string]any{"type": "auth", "id": id, "token": m.token})
		if health.SendText(string(bytes)) != nil {
			pc.Close()
		}
	})
	health.OnMessage(func(message webrtc.DataChannelMessage) {
		if !message.IsString && len(message.Data) == 4 {
			if health.BufferedAmount() > 4096 || health.Send(message.Data) != nil {
				pc.Close()
			}
			return
		}
		if !message.IsString || string(message.Data) != "{\"type\":\"ready\"}" {
			pc.Close()
			return
		}
		m.mu.Lock()
		if m.peer == p {
			p.ready = true
		}
		m.mu.Unlock()
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateDisconnected {
			m.mu.Lock()
			if m.peer == p {
				p.available = false
				p.healthy = false
			}
			m.mu.Unlock()
			if state == webrtc.PeerConnectionStateFailed {
				go pc.Close()
			}
		}
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if pc.SetLocalDescription(offer) != nil {
		return
	}
	timer := time.NewTimer(1500 * time.Millisecond)
	select {
	case <-gathered:
		timer.Stop()
	case <-timer.C:
	case <-m.ctx.Done():
		timer.Stop()
		return
	}
	sdp, err := directSDP(pc.LocalDescription().SDP, config.IPv6)
	if err != nil {
		return
	}
	if m.write(map[string]any{"type": "rtc_offer", "id": id, "sdp": sdp}) != nil {
		return
	}
	timer = time.NewTimer(12 * time.Second)
	defer timer.Stop()
	for {
		select {
		case answer := <-m.answers:
			if answer.ID != id {
				continue
			}
			sdp, err = directSDP(answer.SDP, config.IPv6)
			if err != nil {
				return
			}
			if pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}) != nil {
				return
			}
			failed = false
			return
		case <-timer.C:
			return
		case <-m.ctx.Done():
			return
		}
	}
}

// Open only creates a data channel. No target request or TCP bytes have been
// sent, so a failed preflight may still choose WSS for this new connection.
func (m *directManager) Open(ctx context.Context) *directChannel {
	m.mu.Lock()
	p := m.peer
	if p != nil && p.channels >= 128 {
		drain := !p.draining
		p.draining = true
		p.available = false
		m.mu.Unlock()
		if drain {
			m.write(map[string]any{"type": "rtc_drain", "id": p.id})
		}
		return nil
	}
	usable := p != nil && p.ready && p.available && time.Since(p.updated) < 10*time.Second && p.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
	if usable {
		p.channels++
	}
	m.mu.Unlock()
	if !usable {
		return nil
	}
	protocol := "forward-data-v1"
	ordered := true
	dc, err := p.pc.CreateDataChannel("codex-forward-data", &webrtc.DataChannelInit{Protocol: &protocol, Ordered: &ordered})
	if err != nil {
		return nil
	}
	stream := newDirectChannel(dc, func() bool { return m.peerAlive(p) })
	m.mu.Lock()
	p.streams[stream] = struct{}{}
	m.mu.Unlock()
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	go func() {
		<-stream.done
		m.mu.Lock()
		delete(p.streams, stream)
		m.mu.Unlock()
		select {
		case m.wake <- struct{}{}:
		default:
		}
	}()
	timer := time.NewTimer(1500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-opened:
		stream.SetReadDeadline(time.Now().Add(5 * time.Second))
		return stream
	case <-ctx.Done():
	case <-stream.done:
	case <-timer.C:
	}
	stream.Close()
	m.mu.Lock()
	p.available = false
	m.mu.Unlock()
	m.write(map[string]any{"type": "rtc_failed", "id": p.id})
	return nil
}

func (m *directManager) peerAlive(p *directPeer) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.peer == p && p.ready && p.healthy && time.Since(p.updated) < 10*time.Second
}
