"""Actual controlling-terminal regression; never invokes sudo or real credentials."""
import ctypes
import errno
import fcntl
import json
import os
import select
import signal
import subprocess
import sys
import termios
import time


def authenticate(root):
    fd = os.open('/dev/tty', os.O_RDWR)
    original = termios.tcgetattr(fd)
    try:
        if os.tcgetpgrp(fd) != os.getpgrp():
            raise RuntimeError('command must own the foreground terminal')
        attributes = termios.tcgetattr(fd)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(fd, termios.TCSANOW, attributes)
        os.write(fd, b'FIXTURE-TTY-PROMPT\n')
        answer = os.read(fd, 64)
        with open(os.path.join(root, 'answer'), 'wb') as target:
            target.write(answer)
        os.write(1, b'FIXTURE-TTY-STDOUT\n')
        os.write(2, b'FIXTURE-TTY-STDERR\n')
    except KeyboardInterrupt:
        raise SystemExit(130)
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, original)
        os.close(fd)


def main():
    mode, root, node, module = sys.argv[1:]
    ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
    # The driver is a session leader with a genuine controlling PTY, as when
    # npm run deploy is launched from an SSH or local interactive terminal.
    master, slave = os.openpty()

    def controlling_terminal():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    command = 'const cp=require("child_process");const r=cp.spawnSync("python3",["-I",process.argv[1],"auth",process.argv[2]],{stdio:"inherit"});process.exitCode=r.status ?? 1;'
    probe = 'import json,os,termios;fd=os.open("/dev/tty",os.O_RDWR);print(json.dumps({"foregroundRestored":os.tcgetpgrp(fd)==os.getpgrp(),"echoRestored":bool(termios.tcgetattr(fd)[3]&termios.ECHO)}));os.close(fd)'
    source = ('import {acquireDeploymentLease} from ' + json.dumps(module) + ';'
              'import {execFileSync} from "node:child_process";'
              'const root=process.argv[1],lease=await acquireDeploymentLease(root);'
              'try{const result=await lease.runTerminal(process.execPath,["-e",' + json.dumps(command) + ',process.argv[2],root],'
              '{cwd:root,timeout:' + ('1000' if mode == 'timeout' else '5000') + '});'
              'const tty=JSON.parse(execFileSync("python3",["-I","-c",' + json.dumps(probe) + '],{encoding:"utf8"}));'
              'console.log("FIXTURE-RESULT:"+JSON.stringify({...result,...tty}));}'
              'finally{await lease.release();}')
    child = subprocess.Popen([node, '--input-type=module', '-e', source, root, os.path.abspath(__file__)],
                             stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
    os.close(slave)
    output = bytearray()
    answered = False
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    chunk = os.read(master, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 8192:
                    raise RuntimeError('terminal output bound')
            if b'FIXTURE-TTY-PROMPT' in output and not answered:
                answered = True
                if mode == 'answer':
                    os.write(master, b'fixture-answer\n')
                elif mode == 'interrupt':
                    os.write(master, b'\x03')
            # Drain the PTY through EOF, including output queued just before
            # the driver exits. Process exit alone does not drain terminal I/O.
        if child.wait(timeout=1) != 0:
            raise RuntimeError('terminal driver failed: ' + output.decode(errors='replace'))
        lines = output.decode(errors='replace').splitlines()
        result = next(json.loads(line.split('FIXTURE-RESULT:', 1)[1]) for line in lines if line.startswith('FIXTURE-RESULT:'))
        try:
            with open(os.path.join(root, 'answer'), 'rb') as source_file:
                answer = source_file.read(65)
        except FileNotFoundError:
            answer = b''
        result.update(answerReceived=answer == b'fixture-answer\n', answerEchoed=b'fixture-answer' in output)
        if mode == 'answer' and not all(value in output for value in (b'FIXTURE-TTY-STDOUT', b'FIXTURE-TTY-STDERR')):
            raise RuntimeError('terminal output missing')
        print(json.dumps(result))
    finally:
        os.close(master)
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)
        # If the regression breaks supervisor cleanup, own and remove only
        # this harness's orphaned descendants, without touching project units.
        for _ in range(200):
            try:
                pid, _status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid:
                continue
            with open('/proc/self/task/%d/children' % os.getpid(), 'rb') as source_file:
                pids = source_file.read(4096).split()
            for value in pids:
                try:
                    os.kill(int(value), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            time.sleep(0.01)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'auth':
        authenticate(sys.argv[2])
    else:
        main()
