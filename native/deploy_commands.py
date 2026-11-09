"""Run one interactive deployment command while the file lease remains held."""
import ctypes
import json
import os
import selectors
import signal
import subprocess
import sys
import time

WIRE = 131072
MAX_TIMEOUT = 1800000
COMMANDS = {'sudo', 'npm', 'systemctl', 'apt-get', 'loginctl'}


def child_pids():
    try:
        with open('/proc/self/task/%d/children' % os.getpid(), 'rb') as source:
            return [int(value) for value in source.read(4097).split() if value.isdigit()]
    except OSError:
        return []


def reap(process):
    if process is None:
        return 137
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    # As a Linux child subreaper, separators and double-forked children become
    # our direct children. Kill and reap them before the caller can release the
    # lock, so a new deployment cannot overlap a surviving installer process.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        while True:
            try:
                pid, _status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return process.returncode if process.returncode is not None else 137
            if not pid:
                break
        children = child_pids()
        if not children:
            return process.returncode if process.returncode is not None else 137
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.01)
    return 137


def allowed(command):
    name = os.path.basename(command)
    if name in COMMANDS:
        return True
    return name in ('node', 'nodejs') or name.startswith('node') and name[4:].replace('.', '').isdigit()


def valid_request(value):
    if not isinstance(value, dict) or sorted(value) != ['args', 'command', 'cwd', 'id', 'timeout']:
        return False
    args, command, cwd, ident, timeout = (value['args'], value['command'], value['cwd'], value['id'], value['timeout'])
    return (isinstance(ident, int) and not isinstance(ident, bool) and 0 < ident <= 2147483647 and
            isinstance(command, str) and command and allowed(command) and
            isinstance(args, list) and len(args) <= 64 and
            all(isinstance(item, str) and len(item) <= 8192 and '\0' not in item for item in args) and
            isinstance(cwd, str) and os.path.isabs(cwd) and '\0' not in cwd and
            isinstance(timeout, int) and not isinstance(timeout, bool) and 1 <= timeout <= MAX_TIMEOUT)


def serve(_lock_fd):
    if not sys.platform.startswith('linux') or ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('native Linux child supervision required')
    if any(not os.isatty(fd) for fd in (3, 4, 5)):
        # Pipes are valid in tests; descriptor presence is the actual contract.
        for fd in (3, 4, 5):
            try:
                os.fstat(fd)
            except OSError:
                raise RuntimeError('interactive command streams unavailable')
    selector = selectors.DefaultSelector()
    os.set_blocking(0, False)
    selector.register(0, selectors.EVENT_READ, 'parent')
    buffer = b''
    process = None
    request = None
    deadline = 0
    count = 0
    try:
        while True:
            parent_closed = False
            for key, _events in selector.select(0.05):
                chunk = os.read(0, WIRE + 1)
                if not chunk:
                    parent_closed = True
                    break
                if process is not None or buffer or count >= 32:
                    raise ValueError('no command queue')
                buffer += chunk
                if len(buffer) > WIRE:
                    raise ValueError('request limit')
                if b'\n' not in buffer:
                    continue
                line, buffer = buffer.split(b'\n', 1)
                if buffer:
                    raise ValueError('one request at a time')
                value = json.loads(line)
                if not valid_request(value):
                    raise ValueError('invalid command')
                request = value
                count += 1
                try:
                    process = subprocess.Popen([request['command']] + request['args'], cwd=request['cwd'],
                                               stdin=3, stdout=4, stderr=5, start_new_session=True)
                except OSError:
                    print(json.dumps({'id': request['id'], 'code': 127}), flush=True)
                    process = None
                    request = None
                    continue
                deadline = time.monotonic() + request['timeout'] / 1000
            if parent_closed:
                return
            if process is None:
                continue
            expired = time.monotonic() >= deadline
            exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
            if not expired and not exited:
                continue
            code = 124 if expired else reap(process)
            if not expired:
                # reap() also removes descendants that outlived the command leader.
                code = process.returncode if process.returncode is not None else code
            print(json.dumps({'id': request['id'], 'code': code}), flush=True)
            process = None
            request = None
    finally:
        reap(process)
        selector.close()


if __name__ == '__main__':
    raise SystemExit(74)
