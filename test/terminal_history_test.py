"""Real isolated tmux history checks; no X11, Codex or production session."""
import importlib.util
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('web_terminal', ROOT / 'desktop' / 'web-terminal.py')
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)


class TerminalCapabilitiesTests(unittest.TestCase):
    def test_even_columns_are_only_requested_for_tmux_26(self):
        for version in ['2.6', '2.6a']:
            self.assertEqual(terminal.column_alignment(version), 2)
        for version in ['2.5', '2.7', '3.4', '3.6a', '', 'invalid']:
            self.assertEqual(terminal.column_alignment(version), 1)


@unittest.skipUnless(shutil.which('tmux'), 'requires tmux')
class TerminalHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='codex-history-test-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.socket = str(Path(cls.temp.name) / 'tmux.sock')
        cls.env = {**os.environ, 'HOME': cls.temp.name, 'HISTFILE': '/dev/null', 'DBUS_SESSION_BUS_ADDRESS': 'disabled:'}
        cls.env.pop('TMUX', None)
        cls.addClassCleanup(lambda: cls.run_tmux('kill-server', check=False))
        script = Path(cls.temp.name) / 'output.py'
        script.write_text("import time\nfor i in range(12500):\n    print(f'ROW-{i:05d} 中文😀 ' + 'x' * 90, flush=True)\ntime.sleep(60)\n")
        cls.run_tmux('-f', str(ROOT / 'desktop' / 'tmux.conf'), 'new-session', '-d', '-s', 'history-test',
                     '-x', '500', '-y', '24', shlex.join([sys.executable, str(script)]))
        cls.pane = cls.run_tmux('display-message', '-p', '-t', 'history-test', '#{pane_id}').stdout.strip()
        deadline = time.monotonic() + 5
        while 'ROW-12499' not in cls.run_tmux('capture-pane', '-p', '-t', cls.pane).stdout:
            if time.monotonic() >= deadline:
                raise RuntimeError('isolated tmux output deadline')
            time.sleep(0.01)

    @classmethod
    def run_tmux(cls, *args, check=True):
        return subprocess.run(['tmux', '-S', cls.socket, *args], env=cls.env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3, check=check)

    def test_new_panes_keep_more_than_2000_rows_with_a_10000_row_bound(self):
        values = self.run_tmux('display-message', '-p', '-t', self.pane, '#{history_limit}:#{history_size}').stdout.strip()
        limit, size = map(int, values.split(':'))
        self.assertEqual(limit, 10000)
        self.assertGreater(size, 2000)
        self.assertLessEqual(size, 10000)

    def test_snapshots_keep_valid_utf8_and_bound_plain_styled_and_legacy_reads(self):
        identity = self.run_tmux('display-message', '-p', '-t', self.pane, '#{pane_id}:#{pane_pid}').stdout
        for styled, limit in [(False, 1048576), (True, 1048576), (False, 65536)]:
            with self.subTest(styled=styled, limit=limit):
                data, alternate, truncated = terminal.history_snapshot(self.socket, self.pane, styled, limit)
                text = data.decode('utf8')
                self.assertLessEqual(len(data), limit)
                self.assertGreater(len(data), limit - 1000)
                self.assertIn('ROW-12499 中文😀', text)
                self.assertNotIn('\ufffd', text)
                self.assertFalse(alternate)
                self.assertTrue(truncated)
                if styled:
                    self.assertRegex(text, r'^(?:\x1b\[[\d;]*m)*ROW-\d{5} ')
        self.assertEqual(identity, self.run_tmux('display-message', '-p', '-t', self.pane, '#{pane_id}:#{pane_pid}').stdout)

    def test_scan_overflow_fails_without_ending_the_pane(self):
        with patch.object(terminal, 'HISTORY_SCAN_BYTES', 1024):
            with self.assertRaisesRegex(ValueError, 'scan limit'):
                terminal.history_snapshot(self.socket, self.pane)
        self.assertEqual(self.run_tmux('display-message', '-p', '-t', self.pane, '#{pane_dead}').stdout.strip(), '0')

    def test_joined_snapshot_keeps_wrapped_commands_and_real_newlines(self):
        source = 'WRAPPED-' + 'ABC中文123' * 20
        script = 'import time; print(' + repr(source + '\nHARD\nBREAK') + ', flush=True); time.sleep(30)'
        self.run_tmux('new-session', '-d', '-s', 'wrapped', '-x', '20', '-y', '8', shlex.join([sys.executable, '-c', script]))
        try:
            deadline = time.monotonic() + 3
            while 'BREAK' not in self.run_tmux('capture-pane', '-p', '-t', 'wrapped').stdout:
                if time.monotonic() >= deadline:
                    self.fail('wrapped output deadline')
                time.sleep(0.01)
            pane = self.run_tmux('display-message', '-p', '-t', 'wrapped', '#{pane_id}').stdout.strip()
            physical, _, _ = terminal.history_snapshot(self.socket, pane)
            logical, _, _ = terminal.history_snapshot(self.socket, pane, joined=True)
            self.assertNotIn(source, physical.decode())
            self.assertIn(source, logical.decode())
            self.assertIn('\nHARD\nBREAK', '\n'.join(row.rstrip() for row in logical.decode().split('\n')))
        finally:
            self.run_tmux('kill-session', '-t', '=wrapped', check=False)
