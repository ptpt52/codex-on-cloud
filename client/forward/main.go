package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"go.bug.st/serial"
)

var defaultServer = ""
var version = "dev"

const dataConnectTimeout = 15 * time.Second
const dataReadyTimeout = 10 * time.Second

//go:embed THIRD_PARTY_NOTICES.txt
var licenses string
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

const chunkSize = 16384
const connectionLimit = 8

func serverURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/" && !regexp.MustCompile(`^/node/[a-z0-9-]{1,48}/$`).MatchString(u.Path)) || u.RawPath != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("服务器地址需为根地址或节点路径，例如 https://example.com/node/my-node/")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || (u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
			return nil, errors.New("服务器必须使用 HTTPS；仅本机回环测试允许 HTTP")
		}
	}
	if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
		u.Host = u.Hostname()
		if strings.Contains(u.Host, ":") {
			u.Host = "[" + u.Host + "]"
		}
	}
	if u.Path == "/" {
		u.Path = ""
	}
	u.Host = strings.ToLower(u.Host)
	return u, nil
}

func dial(ctx context.Context, server *url.URL, path, token string) (*websocket.Conn, error) {
	return dialHeaders(ctx, server, path, token, nil)
}
func dialHeaders(ctx context.Context, server *url.URL, path, token string, extra http.Header) (*websocket.Conn, error) {
	u := *server
	u.Path = strings.TrimSuffix(server.Path, "/") + path
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	handshakeTimeout := 5 * time.Second
	if path == "/forward/data" {
		handshakeTimeout = dataConnectTimeout
	}
	protocol := "codex-forward-v1"
	if path == "/forward/agent" {
		protocol = "codex-agent-v2"
	}
	if path == "/forward/transport" {
		protocol = "codex-forward-pool-v1"
	}
	d := websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: handshakeTimeout, ReadBufferSize: chunkSize, WriteBufferSize: chunkSize, Subprotocols: []string{protocol}}
	origin := *server
	origin.Path = ""
	headers := http.Header{"Authorization": {"Bearer " + token}, "Origin": {origin.String()}}
	if node, ok := ctx.Value(forwardNodeContext{}).(string); ok && node != "" {
		headers.Set("X-Codex-Forward-Node", node)
	}
	if path == "/forward/helper" || path == "/forward/resume" {
		headers.Set("X-Codex-Forward-Resume", "1")
		headers.Set("X-Codex-Forward-Reverse", "1")
		headers.Set("X-Codex-Forward-Serial", "1")
		headers.Set("X-Codex-Forward-Keep-Streams", "1")
		if pool, ok := ctx.Value(forwardPoolContext{}).(*transportPool); ok {
			headers.Set("X-Codex-Forward-Pool", "1")
			headers.Set("X-Codex-Agent-Instance", pool.instance)
		}
	}
	for key, values := range extra {
		for _, value := range values {
			headers.Add(key, value)
		}
	}
	c, response, err := d.DialContext(ctx, u.String(), headers)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return nil, dialFailure(err, response, path)
	}
	if c.Subprotocol() != protocol {
		c.Close()
		return nil, errors.New("服务器转发协议不兼容")
	}
	c.SetReadLimit(chunkSize)
	if path == "/forward/helper" || path == "/forward/resume" || path == "/forward/agent" || path == "/forward/transport" {
		c.SetReadLimit(48 * 1024)
	}
	readTimeout := 5 * time.Second
	if path == "/forward/data" {
		readTimeout = dataReadyTimeout
	}
	c.SetReadDeadline(time.Now().Add(readTimeout))
	c.SetPingHandler(func(data string) error {
		c.SetReadDeadline(time.Now().Add(45 * time.Second))
		return c.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(5*time.Second))
	})
	return c, nil
}

type readyMessage struct {
	Serial              *serialConfig `json:"serial"`
	SerialProtocol      int           `json:"serialProtocol"`
	Protocol            string        `json:"protocol"`
	Type                string        `json:"type"`
	Version             int           `json:"version"`
	ID                  string        `json:"id"`
	StreamToken         string        `json:"streamToken"`
	LocalPort           int           `json:"localPort"`
	TargetHost          string        `json:"targetHost"`
	TargetPort          int           `json:"targetPort"`
	MaxConnections      int           `json:"maxConnections"`
	DirectProtocol      int           `json:"directProtocol"`
	PoolProtocol        int           `json:"poolProtocol"`
	ResumeProtocol      int           `json:"resumeProtocol"`
	ResumeToken         string        `json:"resumeToken"`
	ResumeMs            int           `json:"resumeMs"`
	KeepStreamsProtocol int           `json:"keepStreamsProtocol"`
	Direction           string        `json:"direction"`
	ReverseProtocol     int           `json:"reverseProtocol"`
	DeviceName          string        `json:"deviceName"`
}

func (r readyMessage) targetIP() string {
	if r.TargetHost == "" {
		return "127.0.0.1" // Servers before custom targets omit this field.
	}
	if len(r.TargetHost) > 64 {
		return ""
	}
	ip := net.ParseIP(r.TargetHost)
	if ip == nil {
		return ""
	}
	return ip.String()
}

type connections struct {
	serialMu sync.Mutex
	sync.Mutex
	closed bool
	items  map[*net.TCPConn]messageSocket
}

func (s *connections) add(tcp *net.TCPConn) bool {
	s.Lock()
	defer s.Unlock()
	if s.closed || len(s.items) >= connectionLimit {
		return false
	}
	s.items[tcp] = nil
	return true
}
func (s *connections) attach(tcp *net.TCPConn, ws messageSocket) bool {
	s.Lock()
	defer s.Unlock()
	if s.closed {
		return false
	}
	s.items[tcp] = ws
	return true
}
func (s *connections) remove(tcp *net.TCPConn) {
	s.Lock()
	defer s.Unlock()
	delete(s.items, tcp)
}
func (s *connections) close() {
	s.Lock()
	defer s.Unlock()
	s.closed = true
	for tcp, ws := range s.items {
		tcp.Close()
		if ws != nil {
			ws.Close()
		}
	}
}

func proxy(ctx context.Context, server *url.URL, token string, tcp *net.TCPConn, active *connections, direct *directManager) error {
	defer tcp.Close()
	defer active.remove(tcp)
	dialCtx, cancel := context.WithTimeout(ctx, dataConnectTimeout)
	var ws messageSocket
	var err error
	pooled, shared := ctx.Value(forwardPoolRuleContext{}).(pooledRule)
	if shared {
		ws, err = pooled.pool.Open(dialCtx, pooled.mapping, token, "")
	} else if direct != nil {
		if channel := direct.Open(dialCtx); channel != nil {
			ws = channel
		}
	}
	usingDirect := ws != nil && !shared
	if ws == nil && !shared {
		ws, err = dial(dialCtx, server, "/forward/data", token)
	}
	cancel()
	if err != nil {
		return streamFailure(err, "relay_connect_timeout")
	}
	defer ws.Close()
	if !active.attach(tcp, ws) {
		return nil
	}
	if usingDirect {
		ws.SetReadDeadline(time.Now().Add(dataReadyTimeout))
		ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
		// The target-open record ends preflight. Failure after this point never
		// reconnects the same TCP stream through another transport.
		if err := ws.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"open\"}")); err != nil {
			return streamFailure(err, "relay_ready_timeout")
		}
	}
	kind, first, err := ws.ReadMessage()
	if err != nil {
		return streamFailure(err, "relay_ready_timeout")
	}
	if kind != websocket.TextMessage || string(first) != "{\"type\":\"ready\"}" {
		return recordFailure(first)
	}
	return copyStream(tcp, ws)
}

func copyStream(tcp *net.TCPConn, ws messageSocket) error {
	ws.SetReadDeadline(time.Now().Add(45 * time.Second))
	results := make(chan error, 2)
	go func() {
		buf := make([]byte, chunkSize)
		for {
			n, readErr := tcp.Read(buf)
			if n > 0 {
				ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
				if err := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
					results <- streamFailure(err, "relay_stream_timeout")
					return
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
					err := ws.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"fin\"}"))
					if err != nil {
						err = streamFailure(err, "relay_stream_timeout")
					}
					results <- err
				} else {
					results <- failure("tcp_peer_disconnected")
				}
				return
			}
		}
	}()
	go func() {
		remoteFin := false
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				if remoteFin && websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived) {
					results <- io.EOF
				} else {
					results <- streamFailure(err, "relay_stream_timeout")
				}
				return
			}
			if kind == websocket.TextMessage {
				if string(data) == "{\"type\":\"fin\"}" && !remoteFin {
					remoteFin = true
					if err := tcp.CloseWrite(); err != nil {
						results <- err
						return
					}
					// Keep reading ping/control frames while the local peer can
					// still upload after the remote peer's TCP half-close.
					continue
				}
				results <- recordFailure(data)
				return
			}
			if kind != websocket.BinaryMessage || remoteFin {
				results <- failure("protocol_error")
				return
			}
			tcp.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if _, err := tcp.Write(data); err != nil {
				results <- tcpFailure(err)
				return
			}
		}
	}()
	firstErr := <-results
	if firstErr != nil {
		tcp.Close()
		ws.Close()
	}
	secondErr := <-results
	if firstErr == io.EOF {
		return nil
	}
	if firstErr != nil && firstErr != io.EOF {
		return connectionFailure(firstErr)
	}
	if secondErr != nil && secondErr != io.EOF {
		return connectionFailure(secondErr)
	}
	return nil
}

func recordFailure(data []byte) error {
	var record struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	if json.Unmarshal(data, &record) == nil && record.Type == "error" {
		return failure(record.Code)
	}
	return failure("protocol_error")
}

func runSession(ctx context.Context, server *url.URL, token string, state *resumeState, output *runOutput) (result error) {
	parentCtx := ctx
	ctx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	path := "/forward/helper"
	if state.token != "" {
		path, token = "/forward/resume", state.token
	}
	dialCtx := ctx
	cancelDial := func() {}
	if !state.deadline.IsZero() {
		dialCtx, cancelDial = context.WithDeadline(ctx, state.deadline)
	}
	control, err := dial(dialCtx, server, path, token)
	cancelDial()
	if err != nil {
		return err
	}
	watchDone := make(chan struct{})
	link := &managementLink{ctx: ctx, conn: control}
	defer close(watchDone)
	go func() {
		select {
		case <-parentCtx.Done():
			link.close(true)
		case <-watchDone:
		}
	}()
	defer func() {
		link.close(parentCtx.Err() != nil || result == nil || !canResume(result))
	}()
	handshakeDeadline := time.Now().Add(5 * time.Second)
	if !state.deadline.IsZero() && state.deadline.Before(handshakeDeadline) {
		handshakeDeadline = state.deadline
	}
	control.SetReadDeadline(handshakeDeadline)
	ready, err := readForwardReady(control)
	if err != nil {
		return err
	}
	if state.expected != nil && !state.expected.matches(ready) {
		return failure("agent_rule_mismatch")
	}
	if err := state.accept(ready); err != nil {
		return err
	}
	if ready.PoolProtocol == 1 {
		pool, ok := ctx.Value(forwardPoolContext{}).(*transportPool)
		if !ok || state.expected == nil {
			return failure("protocol_error")
		}
		ctx = context.WithValue(ctx, forwardPoolRuleContext{}, pooledRule{pool: pool, mapping: ready.ID})
	}
	reversed := ready.Direction == "reverse"
	if reversed && !state.reverseApproved {
		var approvalError error
		if state.approve == nil {
			approvalError = failure("reverse_denied")
		} else {
			approvalError = state.approve(ctx, ready)
		}
		if approvalError != nil {
			control.SetWriteDeadline(time.Now().Add(time.Second))
			control.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"error\",\"code\":\"reverse_denied\"}"))
			return approvalError
		}
		state.reverseApproved = true
	}
	if !state.deadline.IsZero() && state.deadline.Before(handshakeDeadline) {
		control.SetReadDeadline(state.deadline)
	}
	var listener *net.TCPListener
	if !reversed {
		listener, err = net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: ready.LocalPort})
	}
	if err != nil {
		code := "local_listen_failed"
		// Windows reports Winsock WSAEADDRINUSE (10048), rather than Go's
		// synthetic POSIX-compatible syscall.EADDRINUSE value on Windows.
		if errors.Is(err, syscall.EADDRINUSE) || (runtime.GOOS == "windows" && errors.Is(err, syscall.Errno(10048))) {
			code = "local_port_in_use"
		}
		control.SetWriteDeadline(time.Now().Add(time.Second))
		record, _ := json.Marshal(map[string]string{"type": "error", "code": code})
		if control.WriteMessage(websocket.TextMessage, record) == nil {
			control.SetReadDeadline(time.Now().Add(time.Second))
			control.ReadMessage()
		}
		return failure(code)
	}
	if listener != nil {
		defer listener.Close()
	}
	if err := confirmListening(control, ready, state.deadline); err != nil {
		return err
	}
	if err := link.install(control); err != nil {
		return err
	}
	state.active = true
	active := &connections{items: make(map[*net.TCPConn]messageSocket)}
	var workers sync.WaitGroup
	var direct *directManager
	if ready.DirectProtocol == 1 {
		direct = newDirectManager(ctx, ready.StreamToken, link.write, link.available, func(text string) {
			output.print(1, "%s", text)
		})
	}
	acceptDone := make(chan struct{})
	if listener == nil {
		close(acceptDone)
	} else {
		go func() {
			defer close(acceptDone)
			for {
				tcp, err := listener.AcceptTCP()
				if err != nil {
					return
				}
				if !link.available() || !active.add(tcp) {
					tcp.Close()
					continue
				}
				workers.Add(1)
				go func() {
					defer workers.Done()
					if err := proxy(ctx, server, ready.StreamToken, tcp, active, direct); err != nil {
						output.print(0, "TCP 连接失败：%s", connectionFailure(err))
					}
				}()
			}
		}()
	}
	defer func() {
		cancelRun()
		if listener != nil {
			listener.Close()
		}
		<-acceptDone
		active.close()
		if direct != nil {
			direct.Close()
		}
		workers.Wait()
	}()
	transport := "WSS 加密中转"
	if server.Scheme == "http" {
		transport = "本机 WS 测试"
	}
	label := "映射已开启"
	if path == "/forward/resume" {
		label = "映射已恢复"
	} else if state.expected == nil {
		output.print(2, "保持助手运行，Ctrl+C 停止。短暂断网自动恢复映射；停止、退出原登录或授权过期后需重新配对。")
	}
	if ready.Serial != nil {
		output.print(2, "%s：服务器 127.0.0.1:%d -> 本地串口 %s（%s；单客户端）", label, ready.LocalPort, ready.Serial.label(), transport)
	} else if reversed {
		output.print(2, "%s：服务器 127.0.0.1:%d -> 本地设备 %s（%s；最多 %d 条连接）", label, ready.LocalPort, net.JoinHostPort(ready.TargetHost, fmt.Sprint(ready.TargetPort)), transport, connectionLimit)
	} else {
		output.print(2, "%s：127.0.0.1:%d -> 目标 %s（%s；最多 %d 条连接）", label, ready.LocalPort, net.JoinHostPort(ready.TargetHost, fmt.Sprint(ready.TargetPort)), transport, connectionLimit)
	}
	var reverseMu sync.Mutex
	reversePending := make(map[string]bool)
	for {
		kind, bytes, err := control.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if ready.KeepStreamsProtocol == 1 && state.token != "" && canResume(connectionFailure(err)) {
				link.offline(control)
				next, recoveryError := resumeManagement(ctx, server, state, ready, link, output)
				if recoveryError != nil {
					if ctx.Err() != nil {
						return nil
					}
					return recoveryError
				}
				control = next
				continue
			}
			return connectionFailure(err)
		}
		if reversed && kind == websocket.TextMessage {
			var request struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			}
			if json.Unmarshal(bytes, &request) == nil && request.Type == "reverse_open" {
				var fields map[string]json.RawMessage
				json.Unmarshal(bytes, &fields)
				reverseMu.Lock()
				valid := len(fields) == 2 && mappingPattern.MatchString(request.ID) && !reversePending[request.ID] && len(reversePending) < ready.MaxConnections
				if valid {
					reversePending[request.ID] = true
				}
				reverseMu.Unlock()
				if !valid {
					return failure("protocol_error")
				}
				workers.Add(1)
				go func(id string) {
					defer workers.Done()
					defer func() { reverseMu.Lock(); delete(reversePending, id); reverseMu.Unlock() }()
					if err := reverseProxy(ctx, server, ready, id, active, direct); err != nil {
						output.print(0, "反向 TCP 连接失败：%s", connectionFailure(err))
					}
				}(request.ID)
				continue
			}
		}
		var value directSignal
		if direct == nil || kind != websocket.TextMessage || json.Unmarshal(bytes, &value) != nil || !strings.HasPrefix(value.Type, "rtc_") {
			return errors.New("服务器返回了不支持的控制消息")
		}
		direct.accept(value)
	}
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--serial-list-worker" {
		parent, err := strconv.Atoi(os.Args[2])
		if err != nil || watchSerialParent(parent) != nil || runSerialListWorker(os.Stdout) != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "--serial-worker" {
		parent, err := strconv.Atoi(os.Args[2])
		if err != nil || watchSerialParent(parent) != nil {
			os.Exit(1)
		}
		if runSerialWorker(os.Stdin, os.Stdout, openSerial) != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	listSerial := flag.Bool("list-serial", false, "列出本机串口名称，不打开设备")
	showVersion := flag.Bool("version", false, "显示版本后退出")
	showLicenses := flag.Bool("licenses", false, "显示依赖许可证后退出")
	flag.Parse()
	if *listSerial {
		ports, err := serial.GetPortsList()
		if err != nil {
			fmt.Fprintln(os.Stderr, "无法列出串口，请检查设备驱动")
			os.Exit(1)
		}
		count := 0
		for _, name := range ports {
			if len(name) <= 192 && serialPath.MatchString(name) {
				fmt.Println(name)
				count++
				if count >= 128 {
					break
				}
			}
		}
		if count == 0 {
			fmt.Println("未发现串口")
		}
		return
	}
	if *showLicenses {
		fmt.Print(licenses)
		return
	}
	if *showVersion {
		fmt.Println("Codex Cloud Forward " + version + "\n下载入口：" + defaultServer)
		return
	}
	fmt.Println("Codex Cloud TCP 端口映射助手 " + version)
	reader := bufio.NewReaderSize(os.Stdin, 4096)
	readLine := func() (string, error) {
		line, err := reader.ReadSlice('\n')
		if err != nil && err != io.EOF {
			return "", err
		}
		return strings.TrimSpace(string(line)), nil
	}
	fmt.Print("请粘贴控制台助手1–8对应的授权 key：")
	key, err := readLine()
	if err == nil {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
		defer cancel()
		err = runAgent(ctx, key, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "无法继续："+err.Error())
		if info, statErr := os.Stdin.Stat(); (runtime.GOOS == "windows" || runtime.GOOS == "darwin") && statErr == nil && info.Mode()&os.ModeCharDevice != 0 {
			fmt.Print("按 Enter 退出…")
			readLine()
		}
		os.Exit(1)
	}
}
