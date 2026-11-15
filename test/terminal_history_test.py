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
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('web_terminal', ROOT / 'desktop' / 'web-terminal.py')
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)


class TerminalCapabilitiesTests(unittest.TestCase):
    def test_output_credit_is_bounded_and_never_uses_operation_ids(self):
        credit = terminal.OutputCredit(True)
        for _ in range(8):
            credit.consume(credit.read_size)
        self.assertEqual(credit.read_size, 0)
        self.assertFalse(credit.acknowledge({'id': 1, 'action': 'resize'}))
        for value in [{'action': 'output-ack', 'bytes': 0}, {'action': 'output-ack', 'bytes': True},
                      {'action': 'output-ack', 'bytes': 65537}, {'action': 'output-ack', 'bytes': 1, 'id': 1}]:
            with self.assertRaises(ValueError):
                credit.acknowledge(value)
        self.assertTrue(credit.acknowledge({'action': 'output-ack', 'bytes': 123}))
        self.assertEqual(credit.read_size, 123)
        with self.assertRaises(ValueError):
            credit.consume(124)
        credit.consume(123)
        credit.acknowledge({'action': 'output-ack', 'bytes': 65536})
        with self.assertRaises(ValueError):
            credit.acknowledge({'action': 'output-ack', 'bytes': 1})

    def test_combining_cells_follow_the_running_server_version(self):
        for version, expected in [('2.6', 0), ('3.3a', 0), ('3.4', 21), ('3.5a', 21), ('3.6a', 32), ('invalid', 0)]:
            self.assertEqual(terminal.combining_limit(version), expected)

    def test_even_columns_are_only_requested_for_tmux_26(self):
        for version in ['2.6', '2.6a']:
            self.assertEqual(terminal.column_alignment(version), 2)
        for version in ['2.5', '2.7', '3.4', '3.6a', '', 'invalid']:
            self.assertEqual(terminal.column_alignment(version), 1)


class TerminalResizeNoticeTests(unittest.TestCase):
    """Mock metadata to exercise cancellation; real signal delivery is tested in X11."""
    def setUp(self):
        self.now = 10
        self.token = '%1:4000'
        self.pane = (4000, 4000, 1234, 5000, 77)
        self.foreground = (5000, 4000, 1234, 5000, 88)
        self.client = ('/dev/pts/2', 120, 6000, self.token)
        self.clients = [self.client]
        self.size = (120, 40)
        self.states = {4000: self.pane, 5000: self.foreground}
        def mock(name, **options):
            value = patch.object(terminal, name, **options)
            result = value.start()
            self.addCleanup(value.stop)
            return result
        mock('pane_state', side_effect=lambda *_: (self.token, '/dev/pts/1', self.size))
        mock('process_state', side_effect=lambda pid: self.states[pid])
        mock('desktop_client', side_effect=lambda *_: self.client)
        mock('client_list', side_effect=lambda *_: self.clients)
        self.readers = []
        self.reader_discovery = mock('detached_readers', side_effect=lambda *_: self.readers)
        mock('detached_reader', side_effect=lambda pid, _: self.states.get(pid))
        clock = patch.object(terminal.time, 'monotonic', side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        for name, options in [('open', {'return_value': 99}), ('close', {}),
                              ('get_terminal_size', {'side_effect': lambda _: self.size}), ('killpg', {}), ('kill', {})]:
            value = patch.object(terminal.os, name, **options)
            result = value.start()
            self.addCleanup(value.stop)
            if name == 'killpg':
                self.signal = result
            if name == 'kill':
                self.process_signal = result
        self.redraw = terminal.TerminalResizeNotice('/isolated/tmux.sock', 'main', self.token)

    def test_final_notification_waits_for_a_stable_size_and_is_sent_only_once(self):
        self.redraw.request()
        self.now += .4
        self.redraw.poll()
        self.signal.assert_not_called()
        self.size = (160, 50)
        self.now += .2
        self.redraw.poll()
        self.signal.assert_not_called()
        self.now += .6
        self.redraw.poll()
        self.signal.assert_called_once_with(5000, terminal.signal.SIGWINCH)
        self.redraw.poll()
        self.signal.assert_called_once()
        self.assertIsNone(self.redraw.pending)

    def test_stale_pane_reused_process_and_parked_client_cancel_the_notification(self):
        for change in ['token', 'foreground', 'birth', 'client']:
            with self.subTest(change=change):
                self.reset_target()
                self.redraw.request()
                if change == 'token':
                    self.token = '%2:4000'
                elif change == 'foreground':
                    self.states[4000] = (4000, 4000, 1234, 4000, 77)
                elif change == 'birth':
                    self.states[5000] = (*self.foreground[:4], 99)
                else:
                    self.clients = []
                self.now += .6
                self.redraw.poll()
                self.signal.assert_not_called()
                self.assertIsNone(self.redraw.pending)

    def reset_target(self):
        self.token = '%1:4000'
        self.states = {4000: self.pane, 5000: self.foreground}
        self.clients = [self.client]

    def test_foreign_controlling_terminal_is_never_signalled(self):
        self.states[5000] = (5000, 9999, 5678, 5000, 88)
        self.redraw.request()
        self.assertIsNone(self.redraw.pending)
        self.signal.assert_not_called()

    def test_continuous_size_changes_expire_instead_of_retaining_an_intent(self):
        self.redraw.request()
        for number in range(1, 5):
            self.now += .6
            self.size = (120 + number, 40)
            self.redraw.poll()
        self.signal.assert_not_called()
        self.assertIsNone(self.redraw.pending)

    def test_detached_service_receives_resize_but_a_reused_pid_is_skipped(self):
        service = (7000, 7000, 0, -1, 99)
        self.readers = [(7000, service)]
        self.states[7000] = service
        self.redraw.request()
        self.now += .6
        self.redraw.poll()
        self.process_signal.assert_called_once_with(7000, terminal.signal.SIGWINCH)
        self.process_signal.reset_mock()
        self.redraw.request()
        self.states[7000] = (*service[:4], 100)
        self.now += .6
        self.redraw.poll()
        self.process_signal.assert_not_called()

    def test_pane_change_cancels_detached_service_notification_too(self):
        self.readers = [(7000, (7000, 7000, 0, -1, 99))]
        self.redraw.request()
        self.token = '%99:9999'
        self.now += .6
        self.redraw.poll()
        self.process_signal.assert_not_called()
        self.signal.assert_not_called()

    def test_web_resize_uses_its_own_client_and_coalesces_discovery(self):
        notice = terminal.TerminalResizeNotice('/isolated/tmux.sock', 'main', self.token, client=(self.client[0], self.client[2]))
        with patch.object(terminal, 'desktop_client', side_effect=AssertionError('web resize must not require X11')):
            for _ in range(4):
                notice.request()
                self.now += .02
            self.reader_discovery.assert_called_once()
            self.now += .2
            notice.poll()
            self.signal.assert_called_once_with(5000, terminal.signal.SIGWINCH)

    def test_standby_cancels_the_pending_web_notification(self):
        notice = terminal.TerminalResizeNotice('/isolated/tmux.sock', 'main', self.token, client=(self.client[0], self.client[2]))
        notice.request()
        notice.cancel()
        self.now += .6
        notice.poll()
        self.signal.assert_not_called()
        self.process_signal.assert_not_called()


class DetachedReaderTests(unittest.TestCase):
    def test_only_same_user_services_with_matching_terminal_stdio_qualify(self):
        state = (7000, 7000, 0, -1, 99)
        tty = '/dev/pts/123'
        paths = {'/proc/7000/fd/0': tty, '/proc/7000/fd/1': 'pipe:[123]', '/proc/7000/fd/2': tty}
        with patch.object(terminal.os, 'stat', return_value=SimpleNamespace(st_uid=1000)) as metadata, \
                patch.object(terminal.os, 'getuid', return_value=1000), \
                patch.object(terminal, 'process_state', return_value=state) as process, \
                patch.object(terminal.os, 'readlink', side_effect=paths.__getitem__):
            self.assertEqual(terminal.detached_reader(7000, tty), state, 'stderr TUI output also counts')
            paths['/proc/7000/fd/0'] = '/dev/pts/456'
            self.assertIsNone(terminal.detached_reader(7000, tty))
            paths['/proc/7000/fd/0'] = tty
            paths['/proc/7000/fd/2'] = 'pipe:[456]'
            self.assertIsNone(terminal.detached_reader(7000, tty))
            paths['/proc/7000/fd/2'] = tty
            metadata.return_value.st_uid = 2000
            self.assertIsNone(terminal.detached_reader(7000, tty))
            metadata.return_value.st_uid = 1000
            process.return_value = (7000, 7000, 9999, 7000, 99)
            self.assertIsNone(terminal.detached_reader(7000, tty), 'other controlling terminals are excluded')

    def test_discovery_has_recipient_entry_and_time_bounds(self):
        state = (7000, 7000, 0, -1, 99)
        with patch.object(terminal.os, 'scandir') as scan, \
                patch.object(terminal, 'detached_reader', return_value=state) as reader, \
                patch.object(terminal.time, 'monotonic', return_value=0) as clock:
            scan.return_value.__enter__.return_value = (SimpleNamespace(name=str(pid)) for pid in range(10, 100))
            self.assertEqual(len(terminal.detached_readers('/dev/pts/123')), 16)
            self.assertEqual(reader.call_count, 16)
            reader.reset_mock()
            reader.return_value = None
            scan.return_value.__enter__.return_value = (SimpleNamespace(name=str(pid)) for pid in range(10, 9000))
            self.assertEqual(terminal.detached_readers('/dev/pts/123'), [])
            self.assertEqual(reader.call_count, 8192)
            reader.reset_mock()
            clock.side_effect = [0, .3]
            scan.return_value.__enter__.return_value = iter([SimpleNamespace(name='7000')])
            self.assertEqual(terminal.detached_readers('/dev/pts/123'), [])
            reader.assert_not_called()


@unittest.skipUnless(shutil.which('tmux'), 'requires tmux')
class TerminalHistoryTests(unittest.TestCase):
    def test_waiting_redraw_marker_uses_exact_session_ids_across_tmux_versions(self):
        waiting, extra = 'codex-view-main', 'codex-view-main-extra'
        self.run_tmux('new-session', '-d', '-s', waiting, 'sleep 60')
        self.run_tmux('new-session', '-d', '-s', extra, 'sleep 60')
        try:
            terminal.view_redraw(self.socket, 'main', True)
            self.assertTrue(terminal.view_redraw(self.socket, 'main'))
            terminal.view_redraw(self.socket, 'main', False)
            self.assertFalse(terminal.view_redraw(self.socket, 'main'))
            self.assertEqual(self.run_tmux('show-options', '-qv', '-t', extra, '@codex_cloud_redraw').stdout.strip(), '')
            self.run_tmux('kill-session', '-t', '=' + waiting)
            with self.assertRaises((ValueError, OSError, subprocess.SubprocessError)):
                terminal.view_redraw(self.socket, 'main', True)
            self.assertEqual(self.run_tmux('show-options', '-qv', '-t', extra, '@codex_cloud_redraw').stdout.strip(), '')
        finally:
            self.run_tmux('kill-session', '-t', '=' + waiting, check=False)
            self.run_tmux('kill-session', '-t', '=' + extra, check=False)

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
