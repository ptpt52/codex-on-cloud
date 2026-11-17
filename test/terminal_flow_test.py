"""Real isolated tmux/PTy flow control; no X11 or production Codex."""
import base64
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).parents[1]


@unittest.skipUnless(shutil.which('tmux'), 'requires tmux')
class TerminalFlowTests(unittest.TestCase):
    def test_target_revoked_after_a_partial_pty_write_reports_unknown(self):
        with tempfile.TemporaryDirectory(prefix='codex-partial-input-') as directory:
            socket = str(Path(directory) / 'tmux.sock')
            env = dict(os.environ, TMUX='')
            def tmux(*args):
                return subprocess.run(['tmux', '-S', socket, *args], env=env, check=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3).stdout
            tmux('-f', str(ROOT / 'desktop/tmux.conf'), 'new-session', '-d', '-s', 'codex', 'sleep 30')
            token = tmux('display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}').decode().strip()
            # Real private PTY + tmux, with one forced short write and a
            # subsequent target revocation. No production session or input.
            wrapper = '''import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('terminal', sys.argv.pop(1))
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)
clients, write = terminal.client_list, os.write
revoked = False
def live(*args, **kwargs):
    return [] if revoked else clients(*args, **kwargs)
def short_write(fd, data):
    global revoked
    if data == b'partial-test':
        count = write(fd, data[:1])
        revoked = count > 0
        return count
    return write(fd, data)
terminal.client_list, terminal.os.write = live, short_write
terminal.main()
'''
            child = subprocess.Popen([sys.executable, '-c', wrapper, str(ROOT / 'desktop/web-terminal.py'), socket, 'main', token],
                                     env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 8
                pending, records, sent = bytearray(), [], False
                while child.poll() is None or select.select([child.stdout], [], [], 0)[0]:
                    self.assertLess(time.monotonic(), deadline, 'partial input response deadline')
                    if not select.select([child.stdout], [], [], .05)[0]:
                        continue
                    data = os.read(child.stdout.fileno(), 65536)
                    if not data:
                        break
                    pending.extend(data)
                    self.assertLess(len(pending), 128 * 1024)
                    while b'\n' in pending:
                        line, _, rest = pending.partition(b'\n'); pending = bytearray(rest)
                        value = json.loads(line); records.append(value)
                        if value['type'] == 'ready' and not sent:
                            child.stdin.write(json.dumps({'action': 'input', 'id': 1, 'data': base64.b64encode(b'partial-test').decode()}).encode() + b'\n')
                            child.stdin.flush(); sent = True
                self.assertEqual([value for value in records if value['type'] == 'result'],
                                 [{'type': 'result', 'id': 1, 'ok': False, 'outcome': 'unknown'}],
                                 (records, child.stderr.read().decode()))
            finally:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill(); child.wait(timeout=3)
                child.stdin.close(); child.stdout.close(); child.stderr.close()
                tmux('kill-server')

    def test_exhausted_output_credit_keeps_real_helper_controls_responsive(self):
        with tempfile.TemporaryDirectory(prefix='codex-flow-') as directory:
            socket = str(Path(directory) / 'tmux.sock')
            env = dict(os.environ, TMUX='')
            def tmux(*args):
                result = subprocess.run(['tmux', '-S', socket, *args], env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                return result.stdout
            script = Path(directory) / 'output.py'
            script.write_text("import time\nfor i in range(3000):\n print(str(i) + 'X' * 240, flush=True)\n time.sleep(.01)\ntime.sleep(30)\n")
            tmux('-f', str(ROOT / 'desktop/tmux.conf'), 'new-session', '-d', '-s', 'codex',
                 '-x', '80', '-y', '24', shlex.join([sys.executable, str(script)]))
            child = None
            try:
                token = tmux('display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}').decode().strip()
                child = subprocess.Popen([sys.executable, str(ROOT / 'desktop/web-terminal.py'), socket, 'main', token, '--geometry', '--output-flow'],
                                         env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                os.set_blocking(child.stdout.fileno(), False)
                pending = bytearray()
                records = []
                output_bytes = 0
                def read_until(predicate):
                    nonlocal output_bytes, pending
                    deadline = time.monotonic() + 8
                    while not predicate():
                        if time.monotonic() >= deadline:
                            self.fail('isolated helper response deadline')
                        if not select.select([child.stdout], [], [], .05)[0]:
                            continue
                        data = os.read(child.stdout.fileno(), 65536)
                        self.assertTrue(data, 'helper exited before responding')
                        pending.extend(data)
                        self.assertLess(len(pending), 128 * 1024)
                        while b'\n' in pending:
                            line, _, rest = pending.partition(b'\n'); pending = bytearray(rest)
                            value = json.loads(line); records.append(value)
                            self.assertLess(len(records), 2048)
                            if value['type'] == 'output':
                                output_bytes += len(base64.b64decode(value['data']))
                def send(value):
                    child.stdin.write(json.dumps(value).encode() + b'\n'); child.stdin.flush()
                read_until(lambda: output_bytes == 65536)
                self.assertEqual(next(v for v in records if v['type'] == 'ready')['outputWindow'], 65536)
                send({'action': 'resize', 'id': 1, 'cols': 90, 'rows': 25})
                send({'action': 'view', 'id': 2, 'standby': False})
                send({'action': 'input', 'id': 3, 'data': base64.b64encode(b'A').decode()})
                read_until(lambda: {v['id'] for v in records if v['type'] == 'result' and v.get('ok')} >= {1, 2, 3})
                self.assertEqual(output_bytes, 65536, 'control replies need no render credit')
                send({'action': 'output-ack', 'bytes': 16384})
                read_until(lambda: output_bytes > 65536)
                self.assertLessEqual(output_bytes, 81920)
                self.assertEqual(tmux('display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}').decode().strip(), token)
            finally:
                if child:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.wait(timeout=3)
                    child.stdin.close(); child.stdout.close(); child.stderr.close()
                tmux('kill-server')
