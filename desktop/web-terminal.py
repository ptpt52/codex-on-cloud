#!/usr/bin/env python3
"""One bounded PTY client for an existing private tmux session, never a task owner."""
import base64
import collections
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

SESSIONS = {'main': 'codex', 'aux1': 'codex-aux1', 'aux2': 'codex-aux2', 'aux3': 'codex-aux3'}
HISTORY_BYTES = 64 * 1024
HISTORY_CHUNK = 8192


def history_snapshot(socket, pane):
    """Read only a fixed pane, retaining a bounded tail without a disk log."""
    alternate = subprocess.run(['tmux', '-S', socket, 'display-message', '-p', '-t', pane, '#{alternate_on}'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1).stdout.strip() == b'1'
    child = subprocess.Popen(['tmux', '-S', socket, 'capture-pane', '-p', '-t', pane, '-S', '-2000'],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    tail = bytearray()
    total = 0
    deadline = time.monotonic() + 1
    try:
        os.set_blocking(child.stdout.fileno(), False)
        while True:
            if time.monotonic() >= deadline:
                raise ValueError('history deadline')
            if not select.select([child.stdout], [], [], 0.05)[0]:
                continue
            chunk = os.read(child.stdout.fileno(), 8192)
            if not chunk:
                break
            total += len(chunk)
            if total > 4 * 1024 * 1024:
                raise ValueError('history scan limit')
            tail.extend(chunk)
            if len(tail) > HISTORY_BYTES:
                del tail[:-HISTORY_BYTES]
        if child.wait(timeout=0.5) != 0:
            raise ValueError('history unavailable')
        return bytes(tail).decode('utf8', errors='ignore').encode('utf8'), alternate, total > HISTORY_BYTES
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill()
            child.wait(timeout=0.5)


def main():
    socket, slot, token = sys.argv[1:]
    session = SESSIONS[slot]
    if not socket.startswith('/') or len(socket.encode()) > 100:
        raise ValueError('invalid socket')
    master, slave = os.openpty()
    tty = os.ttyname(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor')
    def controlling_terminal():
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    child = subprocess.Popen(['tmux', '-S', socket, 'attach-session', '-t', '=' + session],
                             stdin=slave, stdout=slave, stderr=slave, env=env,
                             start_new_session=True, preexec_fn=controlling_terminal)
    os.close(slave)
    os.set_blocking(master, False)
    pending = bytearray()
    writes = collections.deque()
    queued = 0
    history = b''
    history_offset = 0
    history_at = 0
    history_alternate = False
    history_truncated = False

    def emit(value):
        sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
        sys.stdout.flush()

    def verify():
        result = subprocess.run(['tmux', '-S', socket, 'display-message', '-p', '-c', tty,
                                 '#{session_name}\t#{pane_id}:#{pane_pid}'],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1)
        return result.returncode == 0 and len(result.stdout) <= 256 and result.stdout.decode().strip() == session + '\t' + token

    try:
        deadline = time.monotonic() + 3
        while not verify():
            if child.poll() is not None or time.monotonic() >= deadline:
                raise ValueError('terminal target unavailable')
            time.sleep(0.03)
        emit({'type': 'ready'})
        last_id = 0
        while child.poll() is None:
            if history and time.monotonic() - history_at > 15:
                history = b''
                history_offset = 0
            readable, writable, _ = select.select([0, master], [master] if writes else [], [], 0.5)
            if 0 in readable:
                data = os.read(0, 8192)
                if not data:
                    break
                pending.extend(data)
                if len(pending) > 96 * 1024:
                    raise ValueError('command buffer exceeded')
                while b'\n' in pending:
                    line, _, rest = pending.partition(b'\n')
                    pending = bytearray(rest)
                    if len(line) > 64 * 1024:
                        raise ValueError('command too large')
                    value = json.loads(line)
                    ident = value['id']
                    if not isinstance(ident, int) or ident <= last_id or ident > 2147483647:
                        raise ValueError('invalid command id')
                    last_id = ident
                    if not verify():
                        emit({'type': 'result', 'id': ident, 'ok': False, 'outcome': 'rejected'})
                        return
                    if value['action'] == 'resize':
                        cols, rows = value['cols'], value['rows']
                        if not isinstance(cols, int) or not isinstance(rows, int) or not (2 <= cols <= 500 and 1 <= rows <= 200):
                            raise ValueError('invalid size')
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                        emit({'type': 'result', 'id': ident, 'ok': True})
                    elif value['action'] == 'input':
                        content = base64.b64decode(value['data'], validate=True)
                        if not content or len(content) > 32 * 1024 + 12 or queued + len(content) > 64 * 1024 or len(writes) >= 64:
                            raise ValueError('input limit exceeded')
                        writes.append([ident, content, 0])
                        queued += len(content)
                    elif value['action'] == 'history':
                        offset = value['offset']
                        if type(offset) is not int or offset < 0 or offset > HISTORY_BYTES:
                            raise ValueError('invalid history offset')
                        try:
                            if offset == 0:
                                history, history_alternate, history_truncated = history_snapshot(socket, token.split(':', 1)[0])
                                history_offset = 0
                            if offset != history_offset or (offset and not history):
                                raise ValueError('expired history')
                            if not verify():
                                raise ValueError('history target changed')
                            data = history[offset:offset + HISTORY_CHUNK]
                            history_offset += len(data)
                            history_at = time.monotonic()
                            emit({'type': 'history', 'id': ident, 'offset': offset, 'data': base64.b64encode(data).decode(),
                                  'next': history_offset, 'done': history_offset == len(history),
                                  'alternate': history_alternate, 'truncated': history_truncated, 'ok': True})
                            if history_offset == len(history):
                                history = b''
                        except (ValueError, OSError, subprocess.SubprocessError):
                            history = b''
                            history_offset = 0
                            emit({'type': 'history', 'id': ident, 'ok': False})
                    else:
                        raise ValueError('invalid action')
            if master in readable:
                try:
                    data = os.read(master, 8192)
                except BlockingIOError:
                    data = b''
                except OSError:
                    break
                if data:
                    emit({'type': 'output', 'data': base64.b64encode(data).decode()})
            if master in writable and writes:
                ident, content, offset = writes[0]
                if not verify():
                    emit({'type': 'result', 'id': ident, 'ok': False, 'outcome': 'rejected'})
                    return
                try:
                    count = os.write(master, content[offset:])
                except BlockingIOError:
                    count = 0
                writes[0][2] += count
                queued -= count
                if writes[0][2] == len(content):
                    writes.popleft()
                    emit({'type': 'result', 'id': ident, 'ok': True})
    finally:
        os.close(master)
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=1)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        main()
    except Exception:
        # Never log terminal bytes, commands, environment or auth material.
        sys.exit(1)
