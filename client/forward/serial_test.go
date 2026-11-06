package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/gorilla/websocket"
	"go.bug.st/serial"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testSerialConfig() *serialConfig {
	path := "/dev/ttyUSB0"
	if runtime.GOOS == "windows" {
		path = "COM3"
	}
	return &serialConfig{Path: path, Baud: 115200, DataBits: 8, Parity: "none", StopBits: 1}
}
func TestSerialConfigAndRecoveryScope(t *testing.T) {
	config := testSerialConfig()
	if !config.valid(runtime.GOOS) {
		t.Fatal("valid config rejected")
	}
	for _, path := range []string{"/etc/passwd", "/dev/zero", "COM0", "/dev/ttyUSB0/../../etc/passwd", "/dev/cu.x\nYES", "/dev/pts/2"} {
		copy := *config
		copy.Path = path
		if copy.valid(runtime.GOOS) {
			t.Fatal("unsafe device accepted", path)
		}
	}
	for _, mutate := range []func(*serialConfig){func(c *serialConfig) { c.Baud = 99 }, func(c *serialConfig) { c.DataBits = 9 }, func(c *serialConfig) { c.Parity = "mark" }, func(c *serialConfig) { c.StopBits = 3 }} {
		copy := *config
		mutate(&copy)
		if copy.valid(runtime.GOOS) {
			t.Fatal("invalid serial mode accepted")
		}
	}
	first := readyMessage{ID: strings.Repeat("a", 32), LocalPort: 22001, Direction: "reverse", DeviceName: "console", Protocol: "serial", SerialProtocol: 1, Serial: config, MaxConnections: 1, ResumeProtocol: 1, ResumeToken: strings.Repeat("b", 43), ResumeMs: 30000}
	if !first.validTarget() {
		t.Fatal("serial authorization rejected")
	}
	state := &resumeState{}
	if err := state.accept(first); err != nil {
		t.Fatal(err)
	}
	state.deadline = time.Now().Add(10 * time.Second)
	next := first
	next.ResumeToken = ""
	if state.accept(next) != nil {
		t.Fatal("same serial grant rejected")
	}
	for _, mutate := range []func(*serialConfig){func(c *serialConfig) { c.Path = "COM4" }, func(c *serialConfig) { c.Baud = 9600 }, func(c *serialConfig) { c.DTR = true }, func(c *serialConfig) { c.RTS = true }, func(c *serialConfig) { c.StopBits = 2 }, func(c *serialConfig) { c.Parity = "odd" }} {
		copy := *config
		mutate(&copy)
		changed := next
		changed.Serial = &copy
		if state.accept(changed) == nil {
			t.Fatal("serial grant changed without consent")
		}
	}
	copy := first
	copy.TargetHost = "127.0.0.1"
	copy.TargetPort = 22
	if copy.validTarget() {
		t.Fatal("hybrid serial/TCP target accepted")
	}
	mode := config.mode()
	if mode.InitialStatusBits == nil || mode.InitialStatusBits.DTR || mode.InitialStatusBits.RTS {
		t.Fatal("unexpected asserted modem bits")
	}
}

type fakeSerialPort struct {
	serial.Port
	net.Conn
}

func (p *fakeSerialPort) SetReadTimeout(time.Duration) error { return nil }
func (p *fakeSerialPort) Read(b []byte) (int, error)         { return p.Conn.Read(b) }
func (p *fakeSerialPort) Write(b []byte) (int, error)        { return p.Conn.Write(b) }
func (p *fakeSerialPort) Close() error                       { return p.Conn.Close() }
func TestSerialWorkerValidatesBeforeOpeningAndCopiesExactBytes(t *testing.T) {
	config := testSerialConfig()
	jsonBytes, _ := json.Marshal(config)
	for _, input := range []string{`{"path":"/etc/passwd"}` + "\n", strings.Repeat("a", 2049) + "\n", strings.TrimSuffix(string(jsonBytes), "}") + `,"extra":true}` + "\n"} {
		called := false
		err := runSerialWorker(strings.NewReader(input), io.Discard, func(*serialConfig) (serial.Port, error) { called = true; return nil, io.EOF })
		if err == nil || called {
			t.Fatal("worker opened device for invalid config")
		}
	}
	input, send := io.Pipe()
	received, output := io.Pipe()
	device, peer := net.Pipe()
	defer peer.Close()
	defer input.Close()
	defer received.Close()
	done := make(chan error, 1)
	go func() {
		done <- runSerialWorker(input, output, func(actual *serialConfig) (serial.Port, error) {
			if !sameSerial(actual, config) {
				return nil, io.ErrUnexpectedEOF
			}
			return &fakeSerialPort{Conn: device}, nil
		})
		output.Close()
	}()
	send.Write(append(jsonBytes, '\n'))
	reader := bufio.NewReader(received)
	line, err := reader.ReadString('\n')
	if err != nil || line != "{\"type\":\"ready\"}\n" {
		t.Fatal("worker readiness lost", err)
	}
	payload := []byte{0, 255, 27, 13, 10, 65}
	go send.Write(payload)
	actual := make([]byte, len(payload))
	if _, err = io.ReadFull(peer, actual); err != nil || !bytes.Equal(actual, payload) {
		t.Fatal("device input changed", err)
	}
	go peer.Write(payload)
	if _, err = io.ReadFull(reader, actual); err != nil || !bytes.Equal(actual, payload) {
		t.Fatal("device output changed", err)
	}
	send.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop on stdin EOF")
	}
}

// A separate test process simulates the device worker; no real serial hardware
// is opened. It exercises binary framing, the five-second-open budget and reap.
func TestSerialChildProcess(t *testing.T) {
	mode := os.Getenv("CODEX_TEST_SERIAL_CHILD")
	if mode == "" {
		return
	}
	reader := bufio.NewReader(os.Stdin)
	if _, err := reader.ReadString('\n'); err != nil {
		os.Exit(2)
	}
	if mode == "stall" {
		time.Sleep(time.Minute)
		os.Exit(2)
	}
	io.WriteString(os.Stdout, "{\"type\":\"ready\"}\n")
	io.Copy(os.Stdout, reader)
	os.Exit(0)
}
func TestSerialSubprocessHasBoundedOpenAndAlwaysReaps(t *testing.T) {
	command := func(mode string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestSerialChildProcess$")
		cmd.Env = append(os.Environ(), "CODEX_TEST_SERIAL_CHILD="+mode)
		return cmd
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	p, err := startSerialCommand(ctx, command("echo"), testSerialConfig())
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte{0, 255, 10, 13, 27}
	go p.Write(payload)
	actual := make([]byte, len(payload))
	if _, err = io.ReadFull(p, actual); err != nil || !bytes.Equal(actual, payload) {
		t.Fatal("child bytes changed", err)
	}
	p.Close()
	p.Close()
	if p.cmd.ProcessState == nil {
		t.Fatal("device process not reaped")
	}
	short, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer stop()
	cmd := command("stall")
	if _, err = startSerialCommand(short, cmd, testSerialConfig()); err == nil || cmd.ProcessState == nil {
		t.Fatal("stalled worker survived open budget")
	}
}
func TestSerialCopyUsesRawBytesAndFinClosesDevice(t *testing.T) {
	sockets := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			sockets <- ws
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	remote := <-sockets
	defer remote.Close()
	defer client.Close()
	local, device := net.Pipe()
	defer device.Close()
	done := make(chan error, 1)
	go func() { done <- copySerial(local, client) }()
	payload := []byte{0, 255, 13, 10}
	remote.WriteMessage(websocket.BinaryMessage, payload)
	buf := make([]byte, len(payload))
	if _, err = io.ReadFull(device, buf); err != nil || !bytes.Equal(buf, payload) {
		t.Fatal("serial write changed", err)
	}
	go device.Write(payload)
	kind, data, err := remote.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(data, payload) {
		t.Fatal("serial read changed", err)
	}
	remote.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"fin\"}"))
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("FIN left device open")
	}
	kind, data, err = remote.ReadMessage()
	if err == nil && kind == websocket.TextMessage && strings.Contains(string(data), "serial_disconnected") {
		t.Fatal("normal client FIN reported a device failure")
	}
}

func TestSerialStalledWriteClosesBothEndpointsAndReturns(t *testing.T) {
	sockets := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			sockets <- ws
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	remote := <-sockets
	defer remote.Close()
	defer client.Close()
	local, device := net.Pipe()
	defer device.Close()
	done := make(chan error, 1)
	go func() { done <- copySerialDeadline(local, client, 40*time.Millisecond) }()
	remote.WriteMessage(websocket.BinaryMessage, []byte("receiver-does-not-read"))
	select {
	case err = <-done:
		if err == nil || err.Error() != failure("serial_stalled").Error() {
			t.Fatal("lost stalled serial diagnosis", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serial write escaped deadline")
	}
}
