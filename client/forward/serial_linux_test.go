//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"go.bug.st/serial"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Real Linux pseudo terminal + pinned serial library, not physical serial
// hardware. PTYs have no DTR/RTS modem controls, so this checks raw I/O only.
func TestSerialLibraryLinuxPTY(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-c", `import os,pty,sys,select,tty
master,slave=pty.openpty()
tty.setraw(slave)
print(os.ttyname(slave),flush=True)
while True:
 ready,_,_=select.select([master,0],[],[])
 if 0 in ready and not os.read(0,1): break
 if master in ready:
  data=os.read(master,16384)
  if not data: break
  os.write(master,data)
`)
	input, _ := cmd.StdinPipe()
	output, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { input.Close(); cmd.Process.Kill(); cmd.Wait() }()
	path, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	config := testSerialConfig()
	mode := config.mode()
	mode.InitialStatusBits = nil
	port, err := serial.Open(strings.TrimSpace(path), mode)
	if err != nil {
		t.Fatal(err)
	}
	defer port.Close()
	port.SetReadTimeout(time.Second)
	payload := []byte{0, 255, 27, 13, 10, 65}
	if _, err = port.Write(payload); err != nil {
		t.Fatal(err)
	}
	actual := make([]byte, len(payload))
	if _, err = io.ReadFull(port, actual); err != nil || !bytes.Equal(actual, payload) {
		t.Fatal("real PTY serial bytes changed", err)
	}
}
