"""One command at a time under the file lease; no shell or persisted queue."""
import json
import os
import selectors
import signal
import subprocess
import sys
import time
import ctypes

WIRE = 131072
OUTPUT = 16384


def reap(process):
    if process is None:
        return
    # Do this before wait(), while the leader PID cannot be reused. Every
    # compiler/packager descendant remains in this private process group.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    # Linux adopts compiler grandchildren here even if their Go parent was
    # killed. Reap them before the lease helper closes its lock descriptor.
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if not pid:
            time.sleep(0.01)


def serve(lock_fd):
    if not sys.platform.startswith('linux') or ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('native Linux child supervision required')
    selector = selectors.DefaultSelector()
    os.set_blocking(0, False)
    selector.register(0, selectors.EVENT_READ, 'parent')
    buffer = b''
    process = None
    request = None
    streams = {}
    output = {}
    count = 0
    try:
        while True:
            for key, _events in selector.select(0.05):
                if key.data == 'parent':
                    chunk = os.read(0, WIRE + 1)
                    if not chunk:
                        return  # finally reaps the group before unlocking.
                    buffer += chunk
                    if len(buffer) > WIRE:
                        raise ValueError('request limit')
                    if b'\n' not in buffer:
                        continue
                    line, buffer = buffer.split(b'\n', 1)
                    if process or buffer or count >= 32:
                        raise ValueError('no command queue')
                    request = json.loads(line)
                    command, args, env = request['command'], request['args'], request['env']
                    if command not in ('go', 'git', 'python3') or not isinstance(args, list) or len(args) > 32 or any(not isinstance(a, str) or '\0' in a for a in args):
                        raise ValueError('fixed tool required')
                    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) or '\0' in k + v or '=' in k for k, v in env.items()):
                        raise ValueError('invalid tool environment')
                    timeout = request['timeout']
                    if not isinstance(timeout, int) or not 1 <= timeout <= 180000:
                        raise ValueError('invalid deadline')
                    count += 1
                    try:
                        process = subprocess.Popen([command] + args, cwd=request['cwd'], env=env, stdin=subprocess.DEVNULL,
                                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                                   pass_fds=(lock_fd,))
                    except OSError:
                        print(json.dumps({'id': request['id'], 'code': 127, 'stdout': '', 'stderr': ''}), flush=True)
                        continue
                    output = {'stdout': bytearray(), 'stderr': bytearray()}
                    streams = {}
                    for name in output:
                        stream = getattr(process, name)
                        os.set_blocking(stream.fileno(), False)
                        selector.register(stream, selectors.EVENT_READ, name)
                        streams[name] = stream
                    deadline = time.monotonic() + timeout / 1000
                else:
                    chunk = os.read(key.fileobj.fileno(), OUTPUT + 1)
                    if chunk:
                        output[key.data].extend(chunk)
                    else:
                        selector.unregister(key.fileobj)
                        streams.pop(key.data).close()
            if process is None:
                continue
            limited = sum(len(value) for value in output.values()) > OUTPUT
            expired = time.monotonic() >= deadline
            exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
            if not limited and not expired and (not exited or streams):
                continue
            reap(process)
            code = 125 if limited else 124 if expired else process.returncode
            for stream in streams.values():
                selector.unregister(stream)
                stream.close()
            streams = {}
            response = {'id': request['id'], 'code': code}
            remaining = OUTPUT
            for name, value in output.items():
                response[name] = bytes(value[:remaining]).decode('utf-8', errors='replace')
                remaining -= min(remaining, len(value))
            process = None
            print(json.dumps(response), flush=True)
    finally:
        reap(process)
        for stream in streams.values():
            stream.close()
        selector.close()
