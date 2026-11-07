#!/usr/bin/env python3
"""One bounded PTY client for an existing private tmux session, never a task owner."""
import base64
import collections
from contextlib import contextmanager
import fcntl
import json
import os
import select
import re
import signal
import stat
import struct
import subprocess
import sys
import termios
import time

SESSIONS = {'main': 'codex', **{f'aux{number}': f'codex-aux{number}' for number in range(1, 8)}}
HISTORY_BYTES = 1024 * 1024
HISTORY_CHUNK = 8192
HISTORY_ROWS = 10000
HISTORY_SCAN_BYTES = 32 * 1024 * 1024


def history_snapshot(socket, pane, styled=False, limit=HISTORY_BYTES):
    """Read only a fixed pane, retaining a bounded tail without a disk log."""
    alternate = subprocess.run(['tmux', '-S', socket, 'display-message', '-p', '-t', pane, '#{alternate_on}'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1).stdout.strip() == b'1'
    child = subprocess.Popen(['tmux', '-S', socket, 'capture-pane', '-p', '-t', pane, '-S', '-' + str(HISTORY_ROWS)] + (['-e'] if styled else []),
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    chunks = collections.deque()
    retained = 0
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
            if total > HISTORY_SCAN_BYTES:
                raise ValueError('history scan limit')
            chunks.append(chunk)
            retained += len(chunk)
            while chunks and retained - len(chunks[0]) >= limit:
                retained -= len(chunks.popleft())
        if child.wait(timeout=0.5) != 0:
            raise ValueError('history unavailable')
        tail = b''.join(chunks)[-limit:]
        # tmux starts each captured row with its own attributes. Drop a partial
        # leading row when clipping styled output, so neither UTF-8 nor SGR
        # sequences start halfway through and the first complete row is faithful.
        if styled and total > limit:
            boundary = tail.find(b'\n')
            if 0 <= boundary < len(tail) - 1:
                tail = tail[boundary + 1:]
        return tail.decode('utf8', errors='ignore').encode('utf8'), alternate, total > limit
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill()
            child.wait(timeout=0.5)


def client_list(socket, session):
    # tmux 2.6 sizes a shared window to its smallest attached client. Read the
    # other clients, so the browser can fit that width without detaching Xterm.
    child = subprocess.Popen(['tmux', '-S', socket, 'list-clients', '-t', '=' + session,
                              '-F', '#{client_tty}\t#{client_width}\t#{client_pid}\t#{pane_id}:#{pane_pid}'],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    data = bytearray()
    deadline = time.monotonic() + 1
    try:
        os.set_blocking(child.stdout.fileno(), False)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([child.stdout], [], [], remaining)[0]:
                raise ValueError('client size deadline')
            chunk = os.read(child.stdout.fileno(), 8193 - len(data))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 8192:
                raise ValueError('client size limit')
        if child.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
            raise ValueError('client sizes unavailable')
        clients = []
        for line in data.decode().splitlines():
            client_tty, cols, pid, target = line.split('\t')
            if not re.fullmatch(r'/dev/pts/\d{1,10}', client_tty) or not pid.isdecimal() or int(pid) <= 1:
                raise ValueError('invalid client')
            clients.append((client_tty, int(cols), int(pid), target))
        return clients
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill()
            child.wait(timeout=0.5)


def tmux_action(socket, args):
    subprocess.run(['tmux', '-S', socket] + args, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)


def view_session(slot):
    return 'codex-view-' + slot


@contextmanager
def viewer_lock(socket, slot):
    # At most eight empty 0600 lock files in the private runtime directory. A
    # kernel lock also survives races between reconnecting PTYs and the guardian.
    path = os.path.join(os.path.dirname(socket), 'view-' + slot + '.lock')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size != 0:
            raise ValueError('invalid viewer lock')
        os.fchmod(fd, 0o600)
        deadline = time.monotonic() + 1
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError('viewer lock deadline')
                time.sleep(0.02)
        yield
    finally:
        os.close(fd)


def restore_view_unlocked(socket, slot):
    try:
        clients = client_list(socket, view_session(slot))
    except (ValueError, OSError, subprocess.SubprocessError):
        return
    for tty, _, _, _ in clients:
        tmux_action(socket, ['switch-client', '-c', tty, '-t', '=' + SESSIONS[slot]])


def restore_view(socket, slot):
    if os.environ.get('DEPLOY_MODE') == 'terminal':
        return
    with viewer_lock(socket, slot):
        restore_view_unlocked(socket, slot)


def yield_desktop(socket, slot, own_tty):
    if os.environ.get('DEPLOY_MODE') == 'terminal':
        return
    # Move only this virtual desktop's Xterm viewer to a fixed waiting session.
    # Its process stays alive; the original task and pane never move or restart.
    class_name = 'codex-on-cloud-terminal' + ('' if slot == 'main' else '-' + slot)
    found = subprocess.run(['xdotool', 'search', '--class', '^' + class_name + '$'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1)
    if found.returncode != 0:
        return
    if len(found.stdout) > 1024:
        raise ValueError('window limit')
    windows = found.stdout.decode().split()
    if len(windows) > 1 or any(not window.isdecimal() for window in windows):
        raise ValueError('ambiguous desktop viewer')
    if not windows:
        return
    result = subprocess.run(['xdotool', 'getwindowpid', windows[0]], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=True, timeout=1)
    window_pid = result.stdout.decode().strip()
    if not window_pid.isdecimal():
        raise ValueError('invalid viewer process')
    for tty, _, pid, _ in client_list(socket, SESSIONS[slot]):
        if tty == own_tty:
            continue
        try:
            with open('/proc/' + str(pid) + '/status', 'rb') as source:
                status = source.read(8193)
            if len(status) > 8192 or not re.search(rb'^PPid:\s*' + window_pid.encode() + rb'\s*$', status, re.M):
                continue
        except OSError:
            continue
        with viewer_lock(socket, slot):
            parked = view_session(slot)
            # Eight fixed sessions at most. Multiple argv items execute directly;
            # no shell command is constructed from terminal or browser text.
            exists = subprocess.run(['tmux', '-S', socket, 'has-session', '-t', '=' + parked],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
            if exists.returncode != 0:
                tmux_action(socket, ['new-session', '-d', '-s', parked, 'python3',
                                     os.path.abspath(__file__), '--view', socket, slot])
            tmux_action(socket, ['switch-client', '-c', tty, '-t', '=' + parked])


def waiting_view(socket, slot):
    sys.stdout.write('\x1b[2J\x1b[H网页终端正在使用。返回桌面后会恢复原终端，任务继续运行。\r\n')
    sys.stdout.flush()
    while True:
        # Owned by the desktop's tmux server, not the panel. This also restores
        # the viewer after a helper SIGKILL or a panel crash.
        try:
            with viewer_lock(socket, slot):
                if not client_list(socket, SESSIONS[slot]):
                    restore_view_unlocked(socket, slot)
                if not client_list(socket, view_session(slot)):
                    tmux_action(socket, ['kill-session', '-t', '=' + view_session(slot)])
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
        time.sleep(0.5)


def main():
    socket, slot, token = sys.argv[1:4]
    geometry_enabled = sys.argv[4:] == ['--geometry']
    if sys.argv[4:] and not geometry_enabled:
        raise ValueError('invalid capability')
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
    history_styled = False
    history_limit = HISTORY_BYTES
    viewport_layout = False

    def emit(value):
        sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
        sys.stdout.flush()

    def verify():
        return any(client_tty == tty and target == token for client_tty, _, _, target in client_list(socket, session))

    try:
        deadline = time.monotonic() + 3
        while not verify():
            if child.poll() is not None or time.monotonic() >= deadline:
                raise ValueError('terminal target unavailable')
            time.sleep(0.03)
        emit({'type': 'ready'})
        last_id = 0
        last_width = None
        width_at = 0
        while child.poll() is None:
            if geometry_enabled and time.monotonic() >= width_at:
                if not verify():
                    return
                if viewport_layout:
                    yield_desktop(socket, slot, tty)
                limit = min([500] + [max(2, cols) for client_tty, cols, _, _ in client_list(socket, session) if client_tty != tty])
                if not verify():
                    return
                if limit != last_width:
                    emit({'type': 'geometry', 'maxCols': limit})
                    last_width = limit
                width_at = time.monotonic() + 2
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
                        viewport_layout = value.get('viewport') is True
                        if viewport_layout:
                            yield_desktop(socket, slot, tty)
                        else:
                            restore_view(socket, slot)
                        width_at = 0
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
                        limit = value.get('limit', 64 * 1024)
                        if type(limit) is not int or limit not in (64 * 1024, HISTORY_BYTES):
                            raise ValueError('invalid history limit')
                        if type(offset) is not int or offset < 0 or offset > limit or offset % HISTORY_CHUNK:
                            raise ValueError('invalid history offset')
                        styled = value.get('styled', False)
                        if type(styled) is not bool:
                            raise ValueError('invalid history format')
                        try:
                            if offset == 0:
                                history, history_alternate, history_truncated = history_snapshot(socket, token.split(':', 1)[0], styled, limit)
                                history_styled = styled
                                history_limit = limit
                                history_offset = 0
                            if offset != history_offset or (offset and not history) or styled != history_styled or limit != history_limit:
                                raise ValueError('expired history')
                            if not verify():
                                raise ValueError('history target changed')
                            data = history[offset:offset + HISTORY_CHUNK]
                            history_offset += len(data)
                            history_at = time.monotonic()
                            emit({'type': 'history', 'id': ident, 'offset': offset, 'data': base64.b64encode(data).decode(),
                                  'next': history_offset, 'done': history_offset == len(history),
                                  'alternate': history_alternate, 'truncated': history_truncated, 'styled': history_styled, 'ok': True})
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
        if len(sys.argv) == 4 and sys.argv[1] == '--view' and sys.argv[3] in SESSIONS:
            waiting_view(sys.argv[2], sys.argv[3])
        else:
            main()
    except Exception:
        # Never log terminal bytes, commands, environment or auth material.
        sys.exit(1)
