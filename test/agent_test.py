import importlib.util
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('desktop_agent', Path(__file__).parents[1] / 'desktop' / 'agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.desktop = agent.Desktop.__new__(agent.Desktop)
        self.desktop.secret = 'a_private_test_secret'
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
        self.assertEqual(self.request('PUT', '/files/link', b'new file')[0], 200)
        self.assertEqual(external.read_text(), 'do not change')
        self.assertFalse((self.desktop.transfer_dir / 'link').is_symlink())
        self.assertEqual(self.request('GET', '/files/link')[1], b'new file')
        self.assertEqual(list(self.desktop.transfer_dir.glob('.upload-*')), [])

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
