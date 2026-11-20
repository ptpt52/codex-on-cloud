import importlib.util
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import quote
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('desktop_agent', Path(__file__).parents[1] / 'desktop' / 'agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.desktop = agent.Desktop.__new__(agent.Desktop)
        self.desktop.secret = 'a_private_test_secret'
        self.desktop.terminal_only = False
        self.desktop.files_only = False
        self.desktop.transfer_dir = Path(self.temp.name) / 'transfer'
        self.desktop.transfer_dir.mkdir()
        self.desktop.input_lock = threading.Lock()
        self.desktop.upload_lock = threading.Lock()
        self.desktop.version = 'test'
        self.server = agent.AgentServer(('127.0.0.1', 0), self.desktop)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, method, path, body=None, auth=True, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        request_headers = {'Authorization': 'Bearer ' + self.desktop.secret} if auth else {}
        if headers:
            request_headers.update(headers)
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            request_headers['Content-Type'] = 'application/json'
        connection.request(method, path, body, request_headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_requires_internal_secret(self):
        self.assertEqual(self.request('GET', '/files', auth=False)[0], 401)

    def test_download_checks_the_open_file_against_the_listed_version(self):
        target = self.desktop.transfer_dir / 'data.bin'
        target.write_bytes(b'old')
        version = agent.file_version(target.stat())
        headers = {'If-Match': '"' + version + '"'}
        self.assertEqual(self.request('GET', '/files/data.bin', headers=headers), (200, b'old'))
        replacement = self.desktop.transfer_dir / 'next.bin'
        replacement.write_bytes(b'new')
        replacement.replace(target)
        self.assertEqual(self.request('GET', '/files/data.bin', headers=headers)[0], 412)

    def test_a_download_changed_after_headers_ends_as_incomplete(self):
        block = 64 * 1024
        target = self.desktop.transfer_dir / 'data.bin'
        target.write_bytes(b'a' * (2 * block))
        send_headers = agent.Handler.end_headers

        def change_after_headers(handler):
            send_headers(handler)
            with target.open('r+b') as contents:
                contents.seek(block)
                contents.write(b'b' * block)

        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        with patch.object(agent.Handler, 'end_headers', change_after_headers):
            connection.request('GET', '/files/data.bin', headers={'Authorization': 'Bearer ' + self.desktop.secret})
            with connection.getresponse() as response:
                self.assertEqual(response.status, 200)
                with self.assertRaises(http.client.IncompleteRead) as interrupted:
                    response.read()
                self.assertEqual(interrupted.exception.partial, b'a' * block)

    def test_disconnected_error_responses_do_not_escape_request_dispatch(self):
        for failure in [agent.AgentError(400, '上传未完成'), OSError('storage unavailable')]:
            handler = agent.Handler.__new__(agent.Handler)
            handler.command, handler.path = 'PUT', '/files/test'
            handler.handle_request = Mock(side_effect=failure)
            handler.json = Mock(side_effect=BrokenPipeError())
            handler.dispatch()
            self.assertTrue(handler.close_connection)
            self.assertEqual(handler.json.call_count, 1)

    def test_listing_skips_deleted_entries_and_keeps_other_files(self):
        path = self.desktop.transfer_dir / 'keep'
        path.write_bytes(b'keep')
        keep = Mock(); keep.name = 'keep'; keep.is_file.return_value = True; keep.stat.return_value = path.stat()
        gone = Mock(); gone.name = 'gone'; gone.is_file.return_value = True; gone.stat.side_effect = FileNotFoundError()
        with patch.object(agent.os, 'scandir') as scan:
            scan.return_value.__enter__.return_value = [gone, keep]
            status, body = self.request('GET', '/files')
        self.assertEqual(status, 200)
        listing = json.loads(body)
        self.assertEqual([entry['name'] for entry in listing['files']], ['keep'])
        self.assertFalse(listing['truncated'])

    def test_unreadable_entry_preserves_listing_but_blocks_temporary_uploads(self):
        broken = Mock(); broken.name = 'unreadable'; broken.is_file.return_value = True; broken.stat.side_effect = PermissionError()
        with patch.object(agent.os, 'scandir') as scan:
            scan.return_value.__enter__.return_value = [broken]
            status, body = self.request('GET', '/files')
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)['truncated'])
            self.assertEqual(self.request('PUT', '/files/new', b'new', headers={'X-Codex-Upload-Quota': 'temporary-v1'})[0], 413)
        self.assertFalse((self.desktop.transfer_dir / 'new').exists())

    def test_terminal_mode_starts_without_codex_or_when_version_query_times_out(self):
        with patch.dict(os.environ, {'DEPLOY_MODE': 'terminal'}):
            for error in (FileNotFoundError('codex'), PermissionError('codex'), agent.subprocess.TimeoutExpired(['codex', '--version'], 10)):
                with self.subTest(error=type(error).__name__):
                    with patch.object(agent.subprocess, 'run', side_effect=error):
                        desktop = agent.Desktop('private-test-secret', Path(self.temp.name) / 'optional-codex')
                        self.assertEqual(desktop.version, '')
                        self.assertTrue(desktop.terminal_only)

    def test_desktop_mode_still_requires_codex(self):
        with patch.dict(os.environ, {'DEPLOY_MODE': 'desktop'}):
            with patch.object(agent.subprocess, 'run', side_effect=FileNotFoundError('codex')):
                with self.assertRaises(FileNotFoundError):
                    agent.Desktop('private-test-secret', Path(self.temp.name) / 'required-codex')

    def test_terminal_mode_rejects_desktop_actions_without_executing_graphical_commands(self):
        self.desktop.terminal_only = True
        with patch.object(agent.subprocess, 'run') as run:
            for path in ('/key', '/paste', '/terminal'):
                self.assertEqual(self.request('POST', path, {'key': 'Enter', 'text': 'test'})[0], 501)
            run.assert_not_called()

    def test_file_service_requires_no_codex_or_x11_and_has_no_desktop_actions(self):
        with patch.dict(os.environ, {'FILE_AGENT_ONLY': '1', 'DEPLOY_MODE': 'desktop'}):
            with patch.object(agent.subprocess, 'run') as run:
                desktop = agent.Desktop('private-test-secret', Path(self.temp.name) / 'files-only')
                self.assertTrue(desktop.files_only)
                self.desktop.files_only = True
                status, body = self.request('GET', '/health')
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {'ready': True, 'uploadProtocol': 1, 'quotaProtocol': 1})
                self.assertEqual(self.request('POST', '/paste', {'text': 'not sent'})[0], 501)
                run.assert_not_called()

    def test_terminal_health_uses_only_the_private_keeper_session_and_still_authenticates(self):
        self.desktop.terminal_only = True
        with patch.dict(os.environ, {'TMUX_SOCKET': '/tmp/isolated-terminal-test.sock'}):
            with patch.object(agent.subprocess, 'run') as run:
                run.return_value.returncode = 0
                self.assertEqual(self.request('GET', '/health', auth=False)[0], 401)
                run.assert_not_called()
                status, body = self.request('GET', '/health')
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(body)['ready'])
                self.assertEqual(run.call_args.args[0], ['tmux', '-S', '/tmp/isolated-terminal-test.sock', 'has-session', '-t', '=codex-host'])

    def test_unicode_upload_and_download(self):
        contents = '中文\n原样 `$(not-a-command)`'.encode()
        self.assertEqual(self.request('PUT', '/files/%E8%B5%84%E6%96%99.txt', contents)[0], 200)
        self.assertEqual(self.request('GET', '/files/%E8%B5%84%E6%96%99.txt'), (200, contents))
        data = json.loads(self.request('GET', '/files')[1])
        self.assertEqual(data['files'][0]['name'], '资料.txt')

    def test_existing_unix_names_download_without_relaxing_upload_names(self):
        for name in ['中' * 81 + '.txt', 'x' * 255, 'literal\\backslash']:
            with self.subTest(name=name):
                (self.desktop.transfer_dir / name).write_bytes(b'kept')
                path = '/files/' + quote(name, safe='')
                self.assertEqual(self.request('GET', path), (200, b'kept'))
                self.assertEqual(self.request('PUT', path, b'changed')[0], 400)
                self.assertEqual((self.desktop.transfer_dir / name).read_bytes(), b'kept')
        self.assertEqual(len(json.loads(self.request('GET', '/files')[1])['files']), 3)

    def test_undecodable_names_do_not_break_the_directory_listing(self):
        directory = self.desktop.directory()
        try:
            fd = os.open(b'bad-\xff', os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=directory)
            os.close(fd)
        finally:
            os.close(directory)
        status, body = self.request('GET', '/files')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['files'][0]['name'], 'bad-\udcff')

    def test_upload_is_atomic_and_does_not_follow_destination_symlink(self):
        external = Path(self.temp.name) / 'outside'
        external.write_text('do not change')
        (self.desktop.transfer_dir / 'link').symlink_to(external)
        self.assertEqual(self.request('GET', '/files/link')[0], 404)
        self.assertEqual(self.request('PUT', '/files/link', b'new file')[0], 409)
        self.assertEqual(external.read_text(), 'do not change')
        self.assertTrue((self.desktop.transfer_dir / 'link').is_symlink())
        self.assertEqual(self.request('PUT', '/files/link', b'new', headers={'X-Codex-Upload-Mode': 'replace', 'If-Match': '"' + 'a' * 64 + '"'})[0], 412)
        self.assertEqual(list(self.desktop.transfer_dir.glob('.upload-*')), [])

    def version(self, name):
        listing = json.loads(self.request('GET', '/files')[1])
        self.assertEqual(listing['uploadProtocol'], 1)
        return next(file['version'] for file in listing['files'] if file['name'] == name)

    def test_delete_requires_auth_and_exact_version_and_preserves_changed_files(self):
        name = '资料.txt'
        target = self.desktop.transfer_dir / name
        target.write_bytes(b'original')
        path = '/files/' + quote(name)
        version = self.version(name)
        headers = {'If-Match': '"' + version + '"'}
        self.assertEqual(json.loads(self.request('GET', '/files')[1])['deleteProtocol'], 1)
        self.assertEqual(self.request('DELETE', path, auth=False, headers=headers)[0], 401)
        self.assertEqual(self.request('DELETE', path)[0], 400)
        self.assertEqual(self.request('DELETE', path, headers={'If-Match': '*'})[0], 400)
        target.write_bytes(b'changed')
        self.assertEqual(self.request('DELETE', path, headers=headers)[0], 412)
        self.assertEqual(target.read_bytes(), b'changed')
        headers['If-Match'] = '"' + self.version(name) + '"'
        status, body = self.request('DELETE', path, headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'ok': True, 'name': name})
        self.assertFalse(target.exists())
        self.assertEqual(self.request('DELETE', path, headers=headers)[0], 412)

    def test_delete_rejects_non_regular_entries_and_serializes_with_uploads(self):
        target = self.desktop.transfer_dir / 'keep'
        target.write_bytes(b'keep')
        headers = {'If-Match': '"' + self.version('keep') + '"'}
        self.desktop.upload_lock.acquire()
        try:
            status, body = self.request('DELETE', '/files/keep', headers=headers)
            self.assertEqual(status, 409)
            self.assertEqual(json.loads(body)['fileCode'], 'file_busy')
            self.assertEqual(json.loads(body)['outcome'], 'rejected')
        finally:
            self.desktop.upload_lock.release()
        directory = self.desktop.directory()
        try:
            agent.fcntl.flock(directory, agent.fcntl.LOCK_EX | agent.fcntl.LOCK_NB)
            self.assertEqual(self.request('DELETE', '/files/keep', headers=headers)[0], 409)
        finally:
            os.close(directory)
        (self.desktop.transfer_dir / 'link').symlink_to(target)
        (self.desktop.transfer_dir / 'dir').mkdir()
        os.mkfifo(str(self.desktop.transfer_dir / 'pipe'))
        for name in ['link', 'dir', 'pipe']:
            self.assertEqual(self.request('DELETE', '/files/' + name, headers=headers)[0], 412)
        self.assertEqual(target.read_bytes(), b'keep')
        self.assertEqual(self.request('DELETE', '/files/.upload-private', headers=headers)[0], 400)
        for name in ['literal\\backslash', '中' * 81 + '.txt', 'x' * 255]:
            (self.desktop.transfer_dir / name).write_bytes(b'delete')
            match = {'If-Match': '"' + self.version(name) + '"'}
            self.assertEqual(self.request('DELETE', '/files/' + quote(name), headers=match)[0], 200)

    def test_default_create_and_versioned_replace(self):
        self.assertEqual(self.request('PUT', '/files/keep', b'original')[0], 200)
        version = self.version('keep')
        self.assertRegex(version, r'^[a-f0-9]{64}$')
        self.assertEqual(self.request('PUT', '/files/keep', b'unconfirmed')[0], 409)
        conflict = json.loads(self.request('PUT', '/files/keep', b'unconfirmed')[1])
        self.assertEqual(conflict['fileCode'], 'file_exists')
        self.assertEqual(conflict['outcome'], 'rejected')
        self.assertEqual(self.request('GET', '/files/keep')[1], b'original')
        headers = {'X-Codex-Upload-Mode': 'replace', 'If-Match': '"' + version + '"'}
        self.assertEqual(self.request('PUT', '/files/keep', b'confirmed', headers=headers)[0], 200)
        self.assertNotEqual(self.version('keep'), version)
        self.assertEqual(self.request('PUT', '/files/keep', b'stale', headers=headers)[0], 412)
        self.assertEqual(self.request('GET', '/files/keep')[1], b'confirmed')
        self.assertEqual(self.request('PUT', '/files/missing', b'new', headers=headers)[0], 412)

    def test_guest_quota_rejects_truncated_directories_and_rescans_before_commit(self):
        target = self.desktop.transfer_dir / 'keep'
        target.write_bytes(b'original')
        for number in range(1000):
            (self.desktop.transfer_dir / ('item-' + str(number))).touch()
        listing = json.loads(self.request('GET', '/files')[1])
        self.assertTrue(listing['truncated'])
        self.assertEqual(listing['quotaProtocol'], 1)
        self.assertEqual(len(listing['files']), 1000)
        headers = {'X-Codex-Upload-Mode': 'replace', 'If-Match': '"' + agent.file_version(target.stat()) + '"', 'X-Codex-Upload-Quota': 'temporary-v1'}
        self.assertEqual(self.request('PUT', '/files/keep', b'new', headers=headers)[0], 413)
        (self.desktop.transfer_dir / 'item-999').unlink()
        self.assertEqual(self.request('PUT', '/files/keep', b'new', headers=headers)[0], 200)
        self.assertEqual(self.request('PUT', '/files/new', b'new', headers={'X-Codex-Upload-Quota': 'temporary-v1'})[0], 413)

    def test_guest_quota_rechecks_external_growth_during_upload(self):
        target = self.desktop.transfer_dir / 'keep'
        target.write_bytes(b'original')
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        connection.putrequest('PUT', '/files/keep')
        for key, value in {'Authorization': 'Bearer ' + self.desktop.secret, 'Content-Length': '4', 'X-Codex-Upload-Mode': 'replace', 'If-Match': '"' + self.version('keep') + '"', 'X-Codex-Upload-Quota': 'temporary-v1'}.items():
            connection.putheader(key, value)
        connection.endheaders()
        try:
            for _ in range(100):
                if list(self.desktop.transfer_dir.glob('.upload-*')):
                    break
                time.sleep(0.01)
            self.assertTrue(list(self.desktop.transfer_dir.glob('.upload-*')))
            with (self.desktop.transfer_dir / 'large').open('wb') as sparse:
                sparse.truncate(agent.MAX_SHARED_BYTES)
            connection.send(b'data')
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            response.read()
            self.assertEqual(target.read_bytes(), b'original')
            self.assertEqual(list(self.desktop.transfer_dir.glob('.upload-*')), [])
        finally:
            connection.close()

    def test_rename_is_bounded_and_preserves_extension_and_utf8(self):
        name = '资' * 78 + '.txt'  # 238 UTF-8 bytes; suffix must truncate safely.
        path = '/files/' + quote(name)
        self.assertEqual(self.request('PUT', path, b'original')[0], 200)
        renamed = json.loads(self.request('PUT', path, b'new', headers={'X-Codex-Upload-Mode': 'rename'})[1])['name']
        self.assertTrue(renamed.endswith(' (2).txt'))
        self.assertLessEqual(len(renamed.encode()), 240)
        self.assertEqual((self.desktop.transfer_dir / name).read_bytes(), b'original')
        self.assertEqual((self.desktop.transfer_dir / renamed).read_bytes(), b'new')
        for index in range(1, 101):
            (self.desktop.transfer_dir / agent.rename_candidate('full.txt', index)).write_bytes(b'keep')
        self.assertEqual(self.request('PUT', '/files/full.txt', b'new', headers={'X-Codex-Upload-Mode': 'rename'})[0], 409)
        self.assertEqual(list(self.desktop.transfer_dir.glob('.upload-*')), [])

    def test_upload_rechecks_target_after_receiving_body(self):
        for replacing in (False, True):
            name = 'replacement' if replacing else 'created-during-upload'
            target = self.desktop.transfer_dir / name
            headers = {'Authorization': 'Bearer ' + self.desktop.secret, 'Content-Length': '4'}
            if replacing:
                target.write_bytes(b'original')
                headers.update({'X-Codex-Upload-Mode': 'replace', 'If-Match': '"' + self.version(name) + '"'})
            connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
            connection.putrequest('PUT', '/files/' + name)
            for key, value in headers.items():
                connection.putheader(key, value)
            connection.endheaders()
            try:
                for _ in range(100):
                    if list(self.desktop.transfer_dir.glob('.upload-*')):
                        break
                    time.sleep(0.01)
                self.assertTrue(list(self.desktop.transfer_dir.glob('.upload-*')))
                # Another API writer cannot pass the upload lock.
                self.assertEqual(self.request('PUT', '/files/busy', b'x')[0], 409)
                target.write_bytes(b'newer external content')
                connection.send(b'data')
                response = connection.getresponse()
                self.assertEqual(response.status, 412 if replacing else 409)
                response.read()
                self.assertEqual(target.read_bytes(), b'newer external content')
                self.assertEqual(list(self.desktop.transfer_dir.glob('.upload-*')), [])
            finally:
                connection.close()

    def test_invalid_upload_conditions_do_not_change_files(self):
        for headers in ({'X-Codex-Upload-Mode': 'replace'}, {'X-Codex-Upload-Mode': 'replace', 'If-Match': '*'}, {'If-Match': '"' + 'a' * 64 + '"'}, {'X-Codex-Upload-Mode': 'rename', 'If-None-Match': '*'}):
            self.assertEqual(self.request('PUT', '/files/invalid', b'bad', headers=headers)[0], 400)
        self.assertFalse((self.desktop.transfer_dir / 'invalid').exists())

    def test_rejects_traversal_and_symlink_directory(self):
        for path in ['/files/..%2Foutside', '/files/%2Fetc%2Fpasswd', '/files/a%5Cb', '/files/.upload-secret']:
            self.assertEqual(self.request('PUT', path, b'bad')[0], 400)
        self.desktop.transfer_dir.rmdir()
        self.desktop.transfer_dir.symlink_to(self.temp.name)
        self.assertEqual(self.request('GET', '/files')[0], 503)

    def test_rejects_oversize_without_consuming_body(self):
        self.assertEqual(self.request('PUT', '/files/large', b'', headers={'Content-Length': str(agent.MAX_FILE + 1)})[0], 413)
        self.assertFalse((self.desktop.transfer_dir / 'large').exists())

    @patch.object(agent.subprocess, 'run')
    def test_paste_uses_utf8_stdin_and_terminal_shortcut_without_enter(self, run):
        text = '你好\n`touch /tmp/not-executed` $(id)'
        self.assertEqual(self.request('POST', '/paste', {'text': text, 'target': 'terminal'})[0], 200)
        self.assertEqual(run.call_args_list[0].kwargs['input'], text.encode())
        self.assertEqual(run.call_args_list[1].args[0], ['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+v'])
        self.assertEqual(run.call_count, 2)

    @patch.object(agent.subprocess, 'run')
    def test_only_fixed_keys_are_allowed(self, run):
        self.assertEqual(self.request('POST', '/key', {'key': '; rm -rf /'})[0], 400)
        run.assert_not_called()
        self.assertEqual(self.request('POST', '/key', {'key': 'Ctrl+C'})[0], 200)
        self.assertEqual(run.call_args.args[0][-1], 'ctrl+c')


class AgentProcessTests(unittest.TestCase):
    """Real helper processes and HTTP; no Codex or graphical commands."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.transfer = Path(self.temp.name) / 'transfer'
        self.transfer.mkdir()
        self.secret = Path(self.temp.name) / 'secret'
        self.secret.write_text('isolated-process-test-secret')
        self.secret.chmod(0o600)

    def start(self, port=None, ready=True):
        if port is None:
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
        env = dict(os.environ, FILE_AGENT_ONLY='1', AGENT_PORT=str(port),
                   AGENT_SECRET_FILE=str(self.secret), TRANSFER_DIR=str(self.transfer))
        child = subprocess.Popen([sys.executable, str(Path(agent.__file__))], env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop, child)
        if ready:
            for _ in range(100):
                self.assertIsNone(child.poll(), 'helper exited before becoming ready')
                try:
                    if self.request(port, 'GET', '/health')[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(0.02)
            else:
                self.fail('helper did not become ready')
        return child, port

    def stop(self, child):
        if child.poll() is None:
            child.terminate()
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate(timeout=3)

    def request(self, port, method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            connection.request(method, path, body, {'Authorization': 'Bearer ' + self.secret.read_text()})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def pending_upload(self, port):
        contents = b'preserved upload\n' * 4096
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        self.addCleanup(connection.close)
        connection.putrequest('PUT', '/files/in-progress')
        connection.putheader('Authorization', 'Bearer ' + self.secret.read_text())
        connection.putheader('Content-Length', str(len(contents)))
        connection.endheaders()
        connection.send(contents[:1024])
        for _ in range(100):
            pending = list(self.transfer.glob('.upload-*'))
            if pending:
                return connection, contents, pending[0]
            time.sleep(0.01)
        self.fail('upload did not create a temporary file')

    def finish_upload(self, connection, contents, port):
        connection.send(contents[1024:])
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        self.assertEqual(self.request(port, 'GET', '/files/in-progress'), (200, contents))
        self.assertEqual(list(self.transfer.glob('.upload-*')), [])

    def test_duplicate_listener_does_not_delete_an_active_upload(self):
        first, port = self.start()
        connection, contents, pending = self.pending_upload(port)
        second, _ = self.start(port, ready=False)
        second.communicate(timeout=4)
        self.assertNotEqual(second.returncode, 0)
        self.assertTrue(pending.exists(), 'rejected duplicate deleted another helper upload')
        self.assertIsNone(first.poll())
        self.finish_upload(connection, contents, port)

    def test_helpers_on_distinct_ports_share_one_upload_lock_and_preserve_pending_files(self):
        first, port = self.start()
        connection, contents, pending = self.pending_upload(port)
        second, other_port = self.start()
        self.assertTrue(pending.exists(), 'startup cleanup deleted a live upload on another port')
        self.assertEqual(self.request(other_port, 'PUT', '/files/concurrent', b'rejected')[0], 409)
        self.assertIsNone(first.poll())
        self.assertIsNone(second.poll())
        self.finish_upload(connection, contents, port)
        self.assertEqual(self.request(other_port, 'PUT', '/files/after', b'accepted')[0], 200)

    def test_crash_releases_upload_lock_and_recovery_preserves_other_directory_entries(self):
        child, port = self.start()
        connection, _, pending = self.pending_upload(port)
        child.kill()
        child.communicate(timeout=3)
        connection.close()
        self.assertTrue(pending.exists())
        target = self.transfer / 'committed'
        target.write_bytes(b'keep')
        link = self.transfer / ('.upload-' + 'b' * 24)
        link.symlink_to(target)
        unrelated = self.transfer / '.upload-user-file'
        unrelated.write_bytes(b'keep too')
        self.start(port)
        for _ in range(100):
            if not pending.exists():
                break
            time.sleep(0.01)
        self.assertFalse(pending.exists(), 'interrupted helper temporary file was not recovered')
        self.assertTrue(link.is_symlink())
        self.assertEqual(target.read_bytes(), b'keep')
        self.assertEqual(unrelated.read_bytes(), b'keep too')
        self.assertEqual(self.request(port, 'PUT', '/files/recovered', b'accepted')[0], 200)

    def test_cancelled_upload_releases_the_directory_for_another_helper(self):
        _, port = self.start()
        connection, _, pending = self.pending_upload(port)
        _, other_port = self.start()
        self.assertEqual(self.request(other_port, 'PUT', '/files/concurrent', b'rejected')[0], 409)
        connection.close()
        for _ in range(100):
            if not pending.exists():
                break
            time.sleep(0.01)
        self.assertFalse(pending.exists())
        self.assertEqual(self.request(other_port, 'PUT', '/files/after-cancel', b'accepted')[0], 200)

    def test_recovery_bounds_directory_enumeration(self):
        for index in range(5):
            (self.transfer / ('.upload-' + format(index, '024x'))).touch()
        with patch.dict(os.environ, {'FILE_AGENT_ONLY': '1'}):
            desktop = agent.Desktop(self.secret.read_text(), self.transfer)
        stop = Mock(); stop.is_set.return_value = False; stop.wait.return_value = True
        with patch.object(agent, 'MAX_DIRECTORY_ENTRIES', 3):
            agent.recover_uploads(desktop, stop)
        self.assertEqual(len(list(self.transfer.iterdir())), 2)
        stop.wait.assert_called_once_with(0.25)

    def test_recovery_continues_past_a_batch_and_waits_for_live_upload_lock(self):
        for index in range(10):
            (self.transfer / ('.upload-' + format(index, '024x'))).touch()
        (self.transfer / 'committed').write_bytes(b'keep')
        (self.transfer / '.upload-user-file').write_bytes(b'keep')
        (self.transfer / ('.upload-' + 'f' * 24)).symlink_to(self.transfer / 'committed')
        with patch.dict(os.environ, {'FILE_AGENT_ONLY': '1'}):
            desktop = agent.Desktop(self.secret.read_text(), self.transfer)
        stop = threading.Event()
        directory = desktop.directory()
        agent.fcntl.flock(directory, agent.fcntl.LOCK_EX | agent.fcntl.LOCK_NB)
        worker = threading.Thread(target=agent.recover_uploads, args=(desktop, stop))
        try:
            with patch.object(agent, 'MAX_DIRECTORY_ENTRIES', 3):
                worker.start()
                time.sleep(0.3)
                self.assertEqual(len(list(self.transfer.iterdir())), 13)
                os.close(directory); directory = None
                worker.join(timeout=4)
                self.assertFalse(worker.is_alive(), 'recovery did not finish later batches')
            self.assertEqual(sorted(path.name for path in self.transfer.iterdir()), ['.upload-' + 'f' * 24, '.upload-user-file', 'committed'])
            self.assertEqual((self.transfer / 'committed').read_bytes(), b'keep')
        finally:
            stop.set(); worker.join(timeout=2)
            if directory is not None:
                os.close(directory)

    def test_service_start_recovers_orphans_beyond_the_actual_directory_batch_limit(self):
        for index in range(agent.MAX_DIRECTORY_ENTRIES + 3):
            (self.transfer / ('.upload-' + format(index, '024x'))).touch()
        (self.transfer / 'keep').write_bytes(b'committed')
        _, port = self.start()
        for _ in range(200):
            if not list(self.transfer.glob('.upload-*')):
                break
            time.sleep(0.02)
        self.assertEqual(list(self.transfer.glob('.upload-*')), [])
        self.assertEqual(self.request(port, 'GET', '/files/keep'), (200, b'committed'))

    def test_interrupted_partial_replace_cleans_temporary_file_and_preserves_original(self):
        _, port = self.start()
        target = self.transfer / 'keep'
        target.write_bytes(b'original')
        version = agent.file_version(target.stat())
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        connection.putrequest('PUT', '/files/keep')
        connection.putheader('Authorization', 'Bearer ' + self.secret.read_text())
        connection.putheader('Content-Length', '65536')
        connection.putheader('X-Codex-Upload-Mode', 'replace')
        connection.putheader('If-Match', '"' + version + '"')
        connection.endheaders(); connection.send(b'incomplete' * 100)
        try:
            for _ in range(100):
                if list(self.transfer.glob('.upload-*')):
                    break
                time.sleep(0.01)
            else:
                self.fail('partial replacement did not reach file helper')
        finally:
            connection.close()
        for _ in range(100):
            if not list(self.transfer.glob('.upload-*')):
                break
            time.sleep(0.01)
        self.assertEqual(list(self.transfer.glob('.upload-*')), [])
        self.assertEqual(target.read_bytes(), b'original')
        self.assertEqual(agent.file_version(target.stat()), version)
        self.assertEqual(self.request(port, 'PUT', '/files/next', b'next')[0], 200)


if __name__ == '__main__':
    unittest.main()
