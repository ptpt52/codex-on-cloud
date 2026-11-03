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
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var defaultServer = ""
var version = "dev"

//go:embed THIRD_PARTY_NOTICES.txt
var licenses string
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

const chunkSize = 16384
const connectionLimit = 8

func serverURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("服务器地址需为网站根地址，例如 https://example.com")
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
	u.Path = ""
	u.Host = strings.ToLower(u.Host)
	return u, nil
}

func dial(ctx context.Context, server *url.URL, path, token string) (*websocket.Conn, error) {
	u := *server
	u.Path = path
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	d := websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: 5 * time.Second, ReadBufferSize: chunkSize, WriteBufferSize: chunkSize, Subprotocols: []string{"codex-forward-v1"}}
	c, response, err := d.DialContext(ctx, u.String(), http.Header{"Authorization": {"Bearer " + token}, "Origin": {server.String()}})
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return nil, errors.New("无法建立授权连接，请检查服务器地址、配对码和外层访问认证")
	}
	if c.Subprotocol() != "codex-forward-v1" {
		c.Close()
		return nil, errors.New("服务器转发协议不兼容")
	}
	c.SetReadLimit(chunkSize)
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	c.SetPingHandler(func(data string) error {
		c.SetReadDeadline(time.Now().Add(45 * time.Second))
		return c.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(5*time.Second))
	})
	return c, nil
}

type readyMessage struct {
	Type           string `json:"type"`
	Version        int    `json:"version"`
	ID             string `json:"id"`
	StreamToken    string `json:"streamToken"`
	LocalPort      int    `json:"localPort"`
	TargetPort     int    `json:"targetPort"`
	MaxConnections int    `json:"maxConnections"`
}

type connections struct {
	sync.Mutex
	closed bool
	items  map[*net.TCPConn]*websocket.Conn
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
func (s *connections) attach(tcp *net.TCPConn, ws *websocket.Conn) bool {
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

func proxy(ctx context.Context, server *url.URL, token string, tcp *net.TCPConn, active *connections) {
	defer tcp.Close()
	defer active.remove(tcp)
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	ws, err := dial(dialCtx, server, "/forward/data", token)
	cancel()
	if err != nil {
		return
	}
	defer ws.Close()
	if !active.attach(tcp, ws) {
		return
	}
	kind, first, err := ws.ReadMessage()
	if err != nil || kind != websocket.TextMessage || string(first) != "{\"type\":\"ready\"}" {
		return
	}
	ws.SetReadDeadline(time.Now().Add(45 * time.Second))
	results := make(chan error, 2)
	go func() {
		buf := make([]byte, chunkSize)
		for {
			n, readErr := tcp.Read(buf)
			if n > 0 {
				ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
				if err := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
					results <- err
					return
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
					results <- ws.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"fin\"}"))
				} else {
					results <- readErr
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
				results <- err
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
				results <- errors.New("forwarding ended")
				return
			}
			if kind != websocket.BinaryMessage || remoteFin {
				results <- errors.New("invalid frame")
				return
			}
			tcp.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if _, err := tcp.Write(data); err != nil {
				results <- err
				return
			}
		}
	}()
	if err := <-results; err != nil {
		tcp.Close()
		ws.Close()
	}
	<-results
}

func run(ctx context.Context, server *url.URL, code string, output io.Writer) error {
	if !tokenPattern.MatchString(code) {
		return errors.New("配对码格式不正确，请重新从网页复制")
	}
	control, err := dial(ctx, server, "/forward/helper", code)
	if err != nil {
		return err
	}
	defer control.Close()
	kind, data, err := control.ReadMessage()
	var ready readyMessage
	if err != nil || kind != websocket.TextMessage || len(data) > 512 || json.Unmarshal(data, &ready) != nil || ready.Type != "ready" || ready.Version != 1 ||
		!tokenPattern.MatchString(ready.StreamToken) || ready.LocalPort < 1024 || ready.LocalPort > 65535 || ready.TargetPort < 1 || ready.TargetPort > 65535 || ready.MaxConnections != connectionLimit {
		return errors.New("服务器未返回有效映射授权")
	}
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: ready.LocalPort})
	if err != nil {
		return errors.New("本机端口无法监听，可能已被占用，请停止此映射并换一个本机端口")
	}
	defer listener.Close()
	control.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := control.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"listening\"}")); err != nil {
		return errors.New("映射启用失败")
	}
	kind, data, err = control.ReadMessage()
	if err != nil || kind != websocket.TextMessage || string(data) != "{\"type\":\"listening\"}" {
		return errors.New("服务器未确认映射启用")
	}
	control.SetReadDeadline(time.Now().Add(45 * time.Second))
	active := &connections{items: make(map[*net.TCPConn]*websocket.Conn)}
	var workers sync.WaitGroup
	acceptDone, watchDone := make(chan struct{}), make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			control.Close()
		case <-watchDone:
		}
	}()
	defer close(watchDone)
	go func() {
		defer close(acceptDone)
		for {
			tcp, err := listener.AcceptTCP()
			if err != nil {
				return
			}
			if !active.add(tcp) {
				tcp.Close()
				continue
			}
			workers.Add(1)
			go func() { defer workers.Done(); proxy(ctx, server, ready.StreamToken, tcp, active) }()
		}
	}()
	defer func() { listener.Close(); <-acceptDone; active.close(); workers.Wait() }()
	transport := "WSS 加密中转"
	if server.Scheme == "http" {
		transport = "本机 WS 测试"
	}
	fmt.Fprintf(output, "映射已开启：127.0.0.1:%d -> 服务器 127.0.0.1:%d（%s；最多 %d 条连接）\n", ready.LocalPort, ready.TargetPort, transport, connectionLimit)
	fmt.Fprintln(output, "保持助手运行，Ctrl+C 停止。网页关闭后仍可使用；网页停止、退出登录或接管会撤销授权。")
	for {
		_, _, err := control.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("映射已停止或连接中断。不会自动重连，请在网页重新生成配对码")
		}
		return errors.New("服务器返回了不支持的控制消息")
	}
}

func main() {
	server := flag.String("server", defaultServer, "服务器 HTTPS 根地址")
	showVersion := flag.Bool("version", false, "显示版本后退出")
	showLicenses := flag.Bool("licenses", false, "显示依赖许可证后退出")
	flag.Parse()
	if *showLicenses {
		fmt.Print(licenses)
		return
	}
	if *showVersion {
		fmt.Println("Codex Cloud Forward " + version)
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
	if *server == "" {
		fmt.Print("服务器地址（https://...）：")
		*server, _ = readLine()
	}
	u, err := serverURL(*server)
	if err == nil {
		fmt.Println("服务器：" + u.String())
		fmt.Print("请在网页生成映射并粘贴配对码：")
		var code string
		code, err = readLine()
		if err == nil {
			ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
			defer cancel()
			err = run(ctx, u, code, os.Stdout)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "无法继续："+err.Error())
		if info, statErr := os.Stdin.Stat(); runtime.GOOS == "windows" && statErr == nil && info.Mode()&os.ModeCharDevice != 0 {
			fmt.Print("按 Enter 退出…")
			readLine()
		}
		os.Exit(1)
	}
}
