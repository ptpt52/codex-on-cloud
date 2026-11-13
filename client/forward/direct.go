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
var specialFour = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/3"),
}
var carrierFour = netip.MustParsePrefix("100.64.0.0/10")
var directFingerprint = regexp.MustCompile(`^a=fingerprint:sha-256 (?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$`)

func directIP(ip net.IP, ipv6 bool) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	if address.Is4() {
		for _, prefix := range specialFour {
			if prefix.Contains(address) {
				return false
			}
		}
		return true
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

// A carrier-assigned local interface can discover a public NAT mapping; its
// shared address still cannot be offered as a routable remote candidate.
func directLocalIP(ip net.IP, ipv6 bool) bool {
	address, ok := netip.AddrFromSlice(ip)
	return directIP(ip, ipv6) || ok && carrierFour.Contains(address.Unmap())
}
func directSDP(sdp string, ipv6 bool) (string, error) {
	if len(sdp) > 32768 || strings.ContainsRune(sdp, 0) {
		return "", failure("protocol_error")
	}
	lines := strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n")
	result := make([]string, 0, len(lines))
	// Four slots per group, eight automatic candidates in total, plus four hints.
	// Many LAN interfaces must not displace every NAT mapping learned through STUN.
	var groups [3][]string
	hints := []string{}
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
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(strings.TrimPrefix(line, "a=candidate:"))
		if len(fields) < 8 || fields[1] != "1" || strings.ToLower(fields[2]) != "udp" || !directIP(net.ParseIP(fields[4]), ipv6) || (fields[7] != "host" && fields[7] != "srflx") {
			continue
		}
		port, err := strconv.Atoi(fields[5])
		address, parseErr := netip.ParseAddr(fields[4])
		if err != nil || port < 1024 || port > 65535 || parseErr != nil || address.Is4In6() || fields[6] != "typ" {
			continue
		}
		if strings.HasPrefix(fields[0], "hint") && fields[7] == "host" {
			if len(hints) < 4 {
				hints = append(hints, line)
			}
			continue
		}
		group := 0
		if address.Is6() {
			group = 2
		} else if fields[7] == "srflx" {
			group = 1
		}
		if len(groups[group]) < 4 {
			groups[group] = append(groups[group], line)
		}
	}
	if media != 1 || !fingerprint {
		return "", failure("protocol_error")
	}
	selected := map[string]int{}
	slots := 0
	for round := 0; round < 4 && slots < 8; round++ {
		for _, group := range groups {
			if round < len(group) && slots < 8 {
				selected[group[round]]++
				slots++
			}
		}
	}
	// Preserve the original SDP order, including end-of-candidates.
	hintCount := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "a=remote-candidates:") {
			continue
		}
		if strings.HasPrefix(line, "a=candidate:") {
			keep := selected[line] > 0
			if !keep && hintCount < len(hints) && line == hints[hintCount] {
				keep = true
				hintCount++
			}
			if !keep {
				continue
			}
			// Duplicate lines consume the same finite slots as in earlier helpers.
			if selected[line] > 0 {
				selected[line]--
			}
		}
		result = append(result, line)
	}
	return strings.Join(result, "\r\n"), nil
}

type directSignal struct {
	Type         string `json:"type"`
	ID           uint32 `json:"id"`
	SDP          string `json:"sdp"`
	Enabled      bool   `json:"enabled"`
	IPv6         bool   `json:"ipv6"`
	STUN         string `json:"stun"`
	HintRevision string `json:"hintRevision"`
	Window       int    `json:"window"`
	Preflight    int    `json:"preflight"`
	Hints        struct {
		Server  string `json:"server"`
		Browser string `json:"browser"`
	} `json:"hints"`
	Available bool   `json:"available"`
	Healthy   bool   `json:"healthy"`
	Family    string `json:"family"`
	Route     string `json:"route"`
	RTT       *int   `json:"rttMs"`
	Reason    string `json:"reason"`
}

func directReady(data []byte, offered, offeredPreflight int) (int, bool, bool) {
	var record struct {
		Type      string `json:"type"`
		Window    int    `json:"window"`
		PeerBytes int    `json:"peerWindowBytes"`
		Preflight int    `json:"preflight"`
	}
	var fields map[string]json.RawMessage
	if len(data) > 2048 || json.Unmarshal(data, &record) != nil || json.Unmarshal(data, &fields) != nil || record.Type != "ready" || fields["type"] == nil {
		return 0, false, false
	}
	if len(fields) == 1 {
		return directWindowLegacy, false, true
	}
	preflight := fields["preflight"] != nil
	if len(fields) != 3 && !(len(fields) == 4 && preflight) || preflight && (record.Preflight != 1 || offeredPreflight != 1) || fields["window"] == nil || fields["peerWindowBytes"] == nil || !validWindow(record.Window) || !validWindow(offered) || record.Window > offered || record.PeerBytes != directPeerBytes {
		return 0, false, false
	}
	return record.Window, preflight, true
}

type directPeer struct {
	pc               *webrtc.PeerConnection
	health           *webrtc.DataChannel
	id               uint32
	ready, available bool
	healthy          bool
	updated          time.Time
	healthAt         time.Time
	streams          map[*directChannel]struct{}
	channels         int
	opening          int
	draining         bool
	window           int
	preflight        bool
	writer           *directWriter
}

func (p *directPeer) close() {
	if p.writer != nil {
		p.writer.close()
	}
	p.pc.Close()
}

type directManager struct {
	mu           sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	write        func(any) error
	online       func() bool
	report       func(string)
	token        string
	peer         *directPeer
	config       directSignal
	configured   bool
	hintsChanged bool
	id           uint32
	answers      chan directSignal
	wake         chan struct{}
	done         chan struct{}
	lastStatus   string
	shared       bool
}

func newDirectManager(ctx context.Context, token string, write func(any) error, online func() bool, report func(string)) *directManager {
	return makeDirectManager(ctx, token, write, online, report, false)
}
func makeDirectManager(ctx context.Context, token string, write func(any) error, online func() bool, report func(string), shared bool) *directManager {
	ctx, cancel := context.WithCancel(ctx)
	m := &directManager{ctx: ctx, cancel: cancel, token: token, write: write, online: online, report: report, shared: shared, answers: make(chan directSignal, 1), wake: make(chan struct{}, 1), done: make(chan struct{})}
	go m.run()
	return m
}
func (m *directManager) accept(value directSignal) {
	var drainID uint32
	m.mu.Lock()
	switch value.Type {
	case "rtc_config":
		if m.configured && m.config.Hints == value.Hints && m.config.Enabled == value.Enabled && m.config.IPv6 == value.IPv6 && m.config.STUN == value.STUN && m.config.HintRevision == value.HintRevision && m.config.Window == value.Window && m.config.Preflight == value.Preflight {
			m.mu.Unlock()
			return
		}
		m.hintsChanged = m.configured
		if m.configured && m.peer != nil {
			m.peer.draining = true
			m.peer.available = false
			drainID = m.peer.id
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
		if value.Route != "lan" && value.Route != "nat" && value.Route != "ipv6" && value.Route != "public-ipv4" {
			value.Route = ""
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
		if !value.Available && (value.Reason == "rtc_busy" || value.Reason == "rtc_disabled" || value.Reason == "rtc_negotiation_failed") {
			// A correlated rejection is the final signaling result, not an SDP
			// answer that might still arrive. Keep this mailbox bounded to one.
			select {
			case m.answers <- value:
			default:
			}
			if value.Reason == "rtc_disabled" {
				m.config.Enabled = false
			}
		}
		m.peer.available = value.Available && m.peer.ready && !m.peer.draining
		m.peer.healthy = value.Healthy && m.peer.ready
		m.peer.updated = time.Now()
		label := "新连接使用 WSS 中转"
		if m.peer.available {
			kind := map[string]string{"lan": "局域网", "nat": "NAT 打洞", "ipv6": "IPv6", "public-ipv4": "公网 IPv4"}[value.Route]
			label = "新连接优先使用 " + value.Family + " / UDP 加密直连"
			if kind != "" {
				label += "（" + kind + "）"
			}
			if value.RTT != nil {
				label += "（往返延迟 " + strconv.Itoa(*value.RTT) + " ms）"
			}
		} else if message := failureMessages[value.Reason]; message != "" {
			label += "：" + message
		}
		key := value.Reason + value.Family
		if m.peer.available {
			key = "direct" + value.Family + value.Route
		}
		if key != m.lastStatus {
			m.lastStatus = key
			m.report(label)
		}
	}
	m.mu.Unlock()
	if drainID != 0 {
		_ = m.write(map[string]any{"type": "rtc_drain", "id": drainID})
	}
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
		online := m.online == nil || m.online()
		m.mu.Lock()
		enabled := m.configured && m.config.Enabled
		p := m.peer
			healthy := p != nil && p.ready && (p.healthy || p.available) && !p.draining && time.Since(p.updated) < 10*time.Second
		busy := p != nil && (len(p.streams) > 0 || p.opening > 0)
		var disabled *directPeer
		if !enabled && p != nil && !busy {
			disabled, m.peer = p, nil
		}
		probe := online && enabled && !busy && (m.hintsChanged || !healthy && !time.Now().Before(next))
		if probe {
			m.hintsChanged = false
		}
		m.mu.Unlock()
		if disabled != nil {
			disabled.close()
		}
		if probe {
			if m.negotiate() == "rtc_busy" {
				// Capacity contention is checked on the existing five-second
				// ticker; it must not consume network-failure backoff steps.
				next = time.Now().Add(2 * time.Second)
			} else {
				next = time.Now().Add(delay)
				delay = min(delay*2, 60*time.Second)
			}
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
		p.close()
	}
}
func (m *directManager) Close() { m.cancel(); <-m.done }
func (m *directManager) negotiate() (reason string) {
	reason = "rtc_negotiation_failed"
	if m.online != nil && !m.online() {
		return
	}
	// Recheck while detaching: Open may have admitted a stream after the run
	// loop inspected it. Never replace a peer carrying that stream.
	m.mu.Lock()
	if m.peer != nil && (len(m.peer.streams) > 0 || m.peer.opening > 0) {
		m.hintsChanged = true
		m.mu.Unlock()
		return
	}
	previous := m.peer
	m.peer = nil
	m.mu.Unlock()
	if previous != nil {
		previous.close()
	}
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
	settings.SetIPFilter(func(ip net.IP) bool { return directLocalIP(ip, config.IPv6) })
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
	p := &directPeer{pc: pc, id: id, streams: make(map[*directChannel]struct{}), window: 4, writer: newDirectWriter(m.ctx)}
	m.mu.Lock()
	m.peer = p
	m.mu.Unlock()
	pc.OnDataChannel(func(*webrtc.DataChannel) { go p.close() })
	failed := true
	defer func() {
		if failed {
			m.mu.Lock()
			if m.peer == p {
				p.available = false
			}
			m.mu.Unlock()
			p.close()
		}
	}()
	protocol := "forward-health-v1"
	ordered := true
	health, err := pc.CreateDataChannel("codex-forward-health", &webrtc.DataChannelInit{Protocol: &protocol, Ordered: &ordered})
	if err != nil {
		return
	}
	p.health = health
	healthWriter := p.writer.channel(health, true)
	if healthWriter == nil {
		return
	}
	health.OnOpen(func() {
		record := map[string]any{"type": "auth", "id": id, "token": m.token}
		if validWindow(config.Window) {
			record["window"] = config.Window
			if config.Preflight == 1 {
				record["preflight"] = 1
			}
		}
		bytes, _ := json.Marshal(record)
		if healthWriter.SendText(string(bytes)) != nil {
			p.close()
		}
	})
	health.OnMessage(func(message webrtc.DataChannelMessage) {
		if m.shared && message.IsString && len(message.Data) <= 2048 {
			var value directSignal
			if json.Unmarshal(message.Data, &value) == nil && value.Type == "rtc_status" && value.ID == id {
				m.accept(value)
				return
			}
		}
		if !message.IsString && len(message.Data) == 4 {
			if healthWriter.BufferedAmount() > 4096 || healthWriter.Send(message.Data) != nil {
				p.close()
			} else {
				m.mu.Lock()
				if m.peer == p {
					p.healthAt = time.Now()
				}
				m.mu.Unlock()
			}
			return
		}
		window, preflight, valid := directReady(message.Data, config.Window, config.Preflight)
		if !message.IsString || !valid {
			p.close()
			return
		}
		m.mu.Lock()
		if m.peer == p && !p.ready {
			p.window = window
			p.preflight = preflight
			p.ready = true
		}
		m.mu.Unlock()
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateFailed {
			p.writer.close()
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateDisconnected {
			m.mu.Lock()
			if m.peer == p {
				p.available = false
				p.healthy = false
			}
			m.mu.Unlock()
			if state == webrtc.PeerConnectionStateFailed {
				go p.close()
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
			if answer.Type == "rtc_status" {
				return answer.Reason
			}
			sdp, err = directSDP(answer.SDP, config.IPv6)
			if err != nil {
				return
			}
			if pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}) != nil {
				return
			}
			failed = false
			return ""
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
	if p != nil && p.writer != nil && !p.writer.budget.canOpen() {
		m.mu.Unlock()
		return nil
	}
	// Reserve before creating a DataChannel. Concurrent rules must neither
	// exceed the shared peer's 24-stream budget nor race idle peer replacement.
	if m.shared && p != nil && len(p.streams)+p.opening >= 24 {
		m.mu.Unlock()
		return nil
	}
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
		p.opening++
	}
	m.mu.Unlock()
	if !usable {
		return nil
	}
	protocol := "forward-data-v1"
	ordered := true
	dc, err := p.pc.CreateDataChannel("codex-forward-data", &webrtc.DataChannelInit{Protocol: &protocol, Ordered: &ordered})
	if err != nil {
		m.mu.Lock()
		p.opening--
		m.mu.Unlock()
		return nil
	}
	stream := newScheduledDirectChannel(dc, func() bool { return m.peerAlive(p) }, p.window, p.writer, p.preflight)
	m.mu.Lock()
	p.opening--
	if stream == nil {
		m.mu.Unlock()
		dc.Close()
		return nil
	}
	if m.peer != p || !p.available || p.draining {
		m.mu.Unlock()
		stream.Close()
		return nil
	}
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
		if !p.preflight {
			stream.SetReadDeadline(time.Now().Add(5 * time.Second))
			return stream
		}
		select {
		case ready := <-stream.preflight:
			if ready {
				stream.SetReadDeadline(time.Now().Add(5 * time.Second))
				return stream
			}
			stream.Close()
			return nil
		case <-ctx.Done():
		case <-stream.done:
			stream.Close()
			return nil
		case <-timer.C:
		}
	case <-ctx.Done():
	case <-stream.done:
		// A negotiated preflight can decline and close before OnOpen's
		// callback runs. No target was opened and the peer is still healthy.
		if p.preflight {
			stream.Close()
			return nil
		}
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
	return m.peer == p && p.ready && time.Since(p.healthAt) < 10*time.Second
}
