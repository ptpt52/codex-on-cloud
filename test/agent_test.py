import importlib.util
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.parse import quote
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('desktop_agent', Path(__file__).parents[1] / 'desktop' / 'agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.desktop = agent.Desktop.__new__(agent.Desktop)
        self.desktop.secret = 'a_private_test_secret'
        self.desktop.terminal_only = False
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

    def test_default_create_and_versioned_replace(self):
        self.assertEqual(self.request('PUT', '/files/keep', b'original')[0], 200)
        version = self.version('keep')
        self.assertRegex(version, r'^[a-f0-9]{64}$')
        self.assertEqual(self.request('PUT', '/files/keep', b'unconfirmed')[0], 409)
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


if __name__ == '__main__':
    unittest.main()
