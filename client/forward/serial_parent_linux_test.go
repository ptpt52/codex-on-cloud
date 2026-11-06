//go:build linux

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestSerialParentWatchFixture(t *testing.T) {
	mode := os.Getenv("CODEX_TEST_PARENT_CHILD")
	if mode == "" {
		return
	}
	if mode == "worker" {
		if watchSerialParent(os.Getppid()) != nil {
			os.Exit(3)
		}
		fmt.Println(os.Getpid())
		time.Sleep(time.Minute)
		os.Exit(3)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestSerialParentWatchFixture$")
	child.Env = append(os.Environ(), "CODEX_TEST_PARENT_CHILD=worker")
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if child.Start() != nil {
		os.Exit(3)
	}
	time.Sleep(time.Minute)
	os.Exit(3)
}

// The Python supervisor is a child subreaper confined to this test. It reaps
// both its killed helper and the orphaned simulated worker, leaving no zombies.
func TestSerialWorkerExitsWhenParentIsKilled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-c", `import ctypes,os,select,signal,subprocess,sys,time
if ctypes.CDLL(None).prctl(36,1,0,0,0)!=0: raise RuntimeError('subreaper failed')
env=dict(os.environ,CODEX_TEST_PARENT_CHILD='controller')
p=subprocess.Popen([sys.argv[1],'-test.run=^TestSerialParentWatchFixture$'],stdout=subprocess.PIPE,env=env,start_new_session=True)
try:
 if not select.select([p.stdout],[],[],3)[0]: raise RuntimeError('no worker readiness')
 worker=int(p.stdout.readline())
 p.kill();p.wait()
 deadline=time.monotonic()+3
 while time.monotonic()<deadline:
  pid,status=os.waitpid(worker,os.WNOHANG)
  if pid:
   if os.waitstatus_to_exitcode(status)!=1: raise RuntimeError('unexpected worker exit')
   break
  time.sleep(.02)
 else: raise RuntimeError('orphaned worker survived parent death')
finally:
 try: os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError: pass
 p.wait()
 while True:
  try: os.waitpid(-1,0)
  except ChildProcessError: break
`, os.Args[0])
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Parent death cleanup failed: %v %s", err, output)
	}
}
