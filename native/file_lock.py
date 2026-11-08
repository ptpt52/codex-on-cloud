#!/usr/bin/env python3
"""Fixed private file lease. The parent pipe, never a PID timestamp, owns it."""
import fcntl
import json
import os
import stat
import sys


def legacy_alive(data):
    try:
        value = json.loads(data)
        pid, started = value['pid'], value['started']
        if not isinstance(pid, int) or pid < 1 or not isinstance(started, str) or not started.isdigit():
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        try:
            with open('/proc/' + str(pid) + '/stat', 'rb') as source:
                text = source.read(8193)
            if len(text) > 8192:
                return True
            return text[text.rfind(b')') + 2:].split()[19].decode() == started
        except (FileNotFoundError, IndexError, UnicodeError):
            return True  # Unknown live identity is never displaced.
    except (ValueError, KeyError, TypeError):
        return False


try:
    path = sys.argv[1]
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 256:
            raise ValueError('invalid lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = os.lstat(path)
        if (current.st_ino, current.st_dev) != (info.st_ino, info.st_dev):
            raise ValueError('changed lock')
        if len(sys.argv) > 2 and sys.argv[2] == 'legacy' and legacy_alive(os.read(fd, 257)):
            raise BlockingIOError()
        os.fchmod(fd, 0o600)
        os.ftruncate(fd, 0)  # Content has no ownership meaning in the new protocol.
        print('ready', flush=True)
        sys.stdin.buffer.read(1)  # Parent release/crash closes this private pipe.
    finally:
        os.close(fd)
except BlockingIOError:
    raise SystemExit(73)
except Exception:
    raise SystemExit(74)  # No paths, contents or credentials in diagnostics.
