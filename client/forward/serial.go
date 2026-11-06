package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"github.com/gorilla/websocket"
	"go.bug.st/serial"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type serialConfig struct {
	Path     string `json:"path"`
	Baud     int    `json:"baud"`
	DataBits int    `json:"dataBits"`
	Parity   string `json:"parity"`
	StopBits int    `json:"stopBits"`
	DTR      bool   `json:"dtr"`
	RTS      bool   `json:"rts"`
}

var serialPath = regexp.MustCompile(`^(COM[1-9][0-9]{0,3}|/dev/(cu\.[A-Za-z0-9._-]+|tty(USB|ACM|S)[0-9]+|tty\.[A-Za-z0-9._-]+|serial/by-id/[A-Za-z0-9._:-]+))$`)

func (s *serialConfig) valid(platform string) bool {
	if s == nil || len(s.Path) > 192 || !serialPath.MatchString(s.Path) {
		return false
	}
	if platform == "windows" && !strings.HasPrefix(s.Path, "COM") || platform != "windows" && strings.HasPrefix(s.Path, "COM") {
		return false
	}
	baudOK := false
	for _, b := range []int{1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600} {
		if b == s.Baud {
			baudOK = true
		}
	}
	return baudOK && s.DataBits >= 5 && s.DataBits <= 8 && (s.Parity == "none" || s.Parity == "odd" || s.Parity == "even") && (s.StopBits == 1 || s.StopBits == 2)
}
func (s *serialConfig) mode() *serial.Mode {
	parity := serial.NoParity
	if s.Parity == "odd" {
		parity = serial.OddParity
	}
	if s.Parity == "even" {
		parity = serial.EvenParity
	}
	stop := serial.OneStopBit
	if s.StopBits == 2 {
		stop = serial.TwoStopBits
	}
	return &serial.Mode{BaudRate: s.Baud, DataBits: s.DataBits, Parity: parity, StopBits: stop, InitialStatusBits: &serial.ModemOutputBits{DTR: s.DTR, RTS: s.RTS}}
}
func (s *serialConfig) label() string {
	return fmt.Sprintf("%s @ %d %d/%s/%d DTR=%t RTS=%t", s.Path, s.Baud, s.DataBits, s.Parity, s.StopBits, s.DTR, s.RTS)
}
func sameSerial(a, b *serialConfig) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

// Device syscalls live in a dedicated child. Killing a stalled driver operation
// releases the whole worker instead of leaking a goroutine in the network helper.
type serialProcess struct {
	cmd    *exec.Cmd
	input  io.WriteCloser
	output io.ReadCloser
	reader *bufio.Reader
	once   sync.Once
	done   chan error
}

func (p *serialProcess) Read(b []byte) (int, error)  { return p.reader.Read(b) }
func (p *serialProcess) Write(b []byte) (int, error) { return p.input.Write(b) }
func (p *serialProcess) Close() error {
	p.once.Do(func() {
		p.input.Close()
		p.output.Close()
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		<-p.done
	})
	return nil
}
func startSerialCommand(ctx context.Context, cmd *exec.Cmd, config *serialConfig) (*serialProcess, error) {
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, failure("serial_open_failed")
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, failure("serial_open_failed")
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		input.Close()
		output.Close()
		return nil, failure("serial_open_failed")
	}
	p := &serialProcess{cmd: cmd, input: input, output: output, reader: bufio.NewReaderSize(output, 2048), done: make(chan error, 1)}
	go func() { p.done <- cmd.Wait() }()
	stop := context.AfterFunc(ctx, func() { p.Close() })
	defer stop()
	first := make(chan error, 1)
	go func() {
		bytes, err := json.Marshal(config)
		if err == nil {
			_, err = input.Write(append(bytes, '\n'))
		}
		if err != nil {
			first <- err
			return
		}
		line, err := p.reader.ReadSlice('\n')
		if err == nil && string(line) != "{\"type\":\"ready\"}\n" {
			err = failure("serial_open_failed")
		}
		first <- err
	}()
	select {
	case err = <-first:
		if err != nil {
			p.Close()
			return nil, failure("serial_open_failed")
		}
		return p, nil
	case <-ctx.Done():
		p.Close()
		<-first
		return nil, failure("serial_open_failed")
	}
}
func startSerialProcess(ctx context.Context, config *serialConfig) (*serialProcess, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, failure("serial_open_failed")
	}
	return startSerialCommand(ctx, exec.Command(executable, "--serial-worker", strconv.Itoa(os.Getpid())), config)
}

func runSerialWorker(input io.Reader, output io.Writer, open func(*serialConfig) (serial.Port, error)) error {
	reader := bufio.NewReaderSize(input, 2048)
	line, err := reader.ReadSlice('\n')
	if err != nil || len(line) > 2048 {
		return failure("protocol_error")
	}
	var config serialConfig
	decoder := json.NewDecoder(strings.NewReader(string(line)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || !config.valid(runtime.GOOS) {
		return failure("protocol_error")
	}
	port, err := open(&config)
	if err != nil {
		return failure("serial_open_failed")
	}
	defer port.Close()
	if err = port.SetReadTimeout(250 * time.Millisecond); err != nil {
		return failure("serial_open_failed")
	}
	if _, err = io.WriteString(output, "{\"type\":\"ready\"}\n"); err != nil {
		return err
	}
	done := make(chan error, 2)
	go func() {
		buf := make([]byte, chunkSize)
		for {
			n, err := port.Read(buf)
			if n > 0 {
				if _, e := output.Write(buf[:n]); e != nil {
					done <- e
					return
				}
			}
			if err != nil {
				done <- err
				return
			}
		}
	}()
	go func() {
		buf := make([]byte, chunkSize)
		for {
			n, err := reader.Read(buf)
			if n > 0 {
				for offset := 0; offset < n; {
					written, e := port.Write(buf[offset:n])
					if e != nil {
						done <- e
						return
					}
					if written < 1 {
						done <- io.ErrShortWrite
						return
					}
					offset += written
				}
			}
			if err != nil {
				done <- err
				return
			}
		}
	}()
	return <-done
}
func openSerial(config *serialConfig) (serial.Port, error) {
	if runtime.GOOS != "windows" {
		info, err := os.Stat(config.Path)
		if err != nil || info.Mode()&os.ModeCharDevice == 0 {
			return nil, failure("serial_open_failed")
		}
	}
	return serial.Open(config.Path, config.mode())
}

func copySerial(local io.ReadWriteCloser, ws messageSocket) error {
	return copySerialDeadline(local, ws, 15*time.Second)
}
func copySerialDeadline(local io.ReadWriteCloser, ws messageSocket, deadline time.Duration) error {
	var stalled, closing atomic.Bool
	ws.SetReadDeadline(time.Now().Add(45 * time.Second))
	results := make(chan error, 2)
	go func() {
		buf := make([]byte, chunkSize)
		for {
			n, err := local.Read(buf)
			if n > 0 {
				ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
				if e := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); e != nil {
					results <- streamFailure(e, "relay_stream_timeout")
					return
				}
			}
			if err != nil {
				ws.SetWriteDeadline(time.Now().Add(time.Second))
				code := "serial_disconnected"
				if stalled.Load() {
					code = "serial_stalled"
				}
				record, _ := json.Marshal(map[string]string{"type": "error", "code": code})
				if !closing.Load() {
					_ = ws.WriteMessage(websocket.TextMessage, record)
				}
				results <- failure("serial_disconnected")
				return
			}
		}
	}()
	go func() {
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				results <- streamFailure(err, "relay_stream_timeout")
				return
			}
			if kind == websocket.TextMessage && string(data) == "{\"type\":\"fin\"}" {
				results <- nil
				return
			}
			if kind != websocket.BinaryMessage || len(data) > chunkSize {
				results <- failure("protocol_error")
				return
			}
			timedOut := make(chan struct{})
			timer := time.AfterFunc(deadline, func() { stalled.Store(true); local.Close(); ws.Close(); close(timedOut) })
			offset := 0
			for offset < len(data) {
				n, e := local.Write(data[offset:])
				if e != nil {
					err = e
					break
				}
				if n < 1 {
					err = io.ErrShortWrite
					break
				}
				offset += n
			}
			if !timer.Stop() {
				<-timedOut
				results <- failure("serial_stalled")
				return
			}
			if err != nil {
				results <- failure("serial_disconnected")
				return
			}
		}
	}()
	first := <-results
	closing.Store(true)
	local.Close()
	ws.Close()
	<-results
	if stalled.Load() {
		return failure("serial_stalled")
	}
	if first != nil && first != io.EOF {
		return first
	}
	return nil
}

func (r readyMessage) validTarget() bool {
	if r.Serial != nil || r.Protocol == "serial" || r.SerialProtocol != 0 {
		return r.Direction == "reverse" && r.Protocol == "serial" && r.SerialProtocol == 1 && r.Serial.valid(runtime.GOOS) && r.TargetHost == "" && r.TargetPort == 0 && r.MaxConnections == 1
	}
	return r.Protocol == "" && r.targetIP() != "" && r.TargetPort >= 1 && r.TargetPort <= 65535 && r.MaxConnections == connectionLimit
}
func reverseSerial(ctx context.Context, ready readyMessage, active *connections, ws messageSocket) error {
	report := func(code string) error {
		record, _ := json.Marshal(map[string]string{"type": "error", "code": code})
		ws.SetWriteDeadline(time.Now().Add(time.Second))
		_ = ws.WriteMessage(websocket.TextMessage, record)
		return failure(code)
	}
	if !active.serialMu.TryLock() {
		return report("serial_busy")
	}
	defer active.serialMu.Unlock()
	openCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	local, err := startSerialProcess(openCtx, ready.Serial)
	cancel()
	if err != nil {
		return report("serial_open_failed")
	}
	defer local.Close()
	stop := context.AfterFunc(ctx, func() { local.Close(); ws.Close() })
	defer stop()
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err = ws.WriteMessage(websocket.TextMessage, []byte("{\"type\":\"target_ready\"}")); err != nil {
		return streamFailure(err, "relay_ready_timeout")
	}
	return copySerial(local, ws)
}
