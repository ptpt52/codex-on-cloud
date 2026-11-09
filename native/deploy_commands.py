"""Run one interactive deployment command while the file lease remains held."""
import ctypes
import json
import os
import selectors
import signal
import subprocess
import sys
import termios
import time

WIRE = 131072
MAX_TIMEOUT = 1800000
COMMANDS = {'sudo', 'npm', 'systemctl', 'apt-get', 'loginctl'}


def child_pids():
    try:
        with open('/proc/self/task/%d/children' % os.getpid(), 'rb') as source:
            data = source.read(4096)
            # A bounded read can end in the middle of a PID. Never signal that
            # partial number; remaining children are picked up in later passes.
            fields = data.split() if not data or data[-1:].isspace() else data.split()[:-1]
            return [int(value) for value in fields if value.isdigit()]
    except OSError:
        return []


def reap(process):
    if process is not None and process.returncode is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    # As a Linux child subreaper, separators and double-forked children become
    # our direct children. Kill and reap them before the caller can release the
    # lock, so a new deployment cannot overlap a surviving installer process.
    while True:
        while True:
            try:
                pid, _status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return process.returncode if process is not None and process.returncode is not None else 137
            if not pid:
                break
        children = child_pids()
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                # Elevated descendants may reject a user signal. Keep the
                # lease until waitpid confirms their exit, never fail open.
                pass
        time.sleep(0.01)


def terminal_state():
    try:
        fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        foreground = os.tcgetpgrp(fd)
        if foreground == os.getpgrp():
            return fd, foreground, termios.tcgetattr(fd)
    except OSError:
        os.close(fd)
        raise
    os.close(fd)
    return None


def command_group():
    # A separate group remains killable, while sharing the caller's session
    # preserves /dev/tty. The parent hands it foreground ownership after spawn;
    # an early terminal read may stop with SIGTTIN and is resumed after handoff.
    os.setpgrp()
    for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGTTOU):
        signal.signal(name, signal.SIG_DFL)


def restore_terminal(terminal, process, flush=False):
    if terminal is None:
        return
    fd, foreground, attributes = terminal
    try:
        # A shell may have reclaimed the terminal after its deployment parent
        # died. Never take it away from a different foreground job.
        current = os.tcgetpgrp(fd)
        if current == foreground or process is not None and current == process.pid:
            os.tcsetpgrp(fd, foreground)
            termios.tcsetattr(fd, termios.TCSAFLUSH if flush else termios.TCSANOW, attributes)
    except OSError:
        pass  # The caller's terminal may have hung up.
    finally:
        os.close(fd)


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
    terminal = None
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    previous_signals = {name: signal.getsignal(name) for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGTTOU)}
    for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(name, stop)
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    try:
        while not stopping:
            parent_closed = False
            for key, _events in selector.select(0.05):
                chunk = os.read(0, WIRE + 1)
                if not chunk:
                    parent_closed = True
                    break
                if process is not None or count >= 32:
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
                    terminal = terminal_state()
                    process = subprocess.Popen([request['command']] + request['args'], cwd=request['cwd'],
                                               stdin=3, stdout=4, stderr=5, start_new_session=terminal is None,
                                               preexec_fn=command_group if terminal else None)
                except OSError:
                    restore_terminal(terminal, None)
                    terminal = None
                    print(json.dumps({'id': request['id'], 'code': 127}), flush=True)
                    process = None
                    request = None
                    continue
                if terminal:
                    os.tcsetpgrp(terminal[0], process.pid)
                    try:
                        os.killpg(process.pid, signal.SIGCONT)
                    except ProcessLookupError:
                        pass
                deadline = time.monotonic() + request['timeout'] / 1000
            if parent_closed:
                return
            if process is None:
                continue
            expired = time.monotonic() >= deadline
            exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
            if not expired and not exited:
                continue
            # The response is a cleanup barrier on success AND timeout. Do not
            # clear process before its group and adopted descendants are gone.
            code = reap(process)
            restore_terminal(terminal, process, flush=expired or code < 0)
            terminal = None
            code = 124 if expired else 128 - code if code < 0 else code
            print(json.dumps({'id': request['id'], 'code': code}), flush=True)
            process = None
            request = None
    finally:
        try:
            reap(process)
        finally:
            restore_terminal(terminal, process, flush=True)
            selector.close()
            for name, handler in previous_signals.items():
                signal.signal(name, handler)


if __name__ == '__main__':
    raise SystemExit(74)
