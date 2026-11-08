#!/usr/bin/env python3
"""Private desktop helper: fixed input actions and a bounded transfer directory.

Runs as the desktop user, on loopback, and accepts no shell commands.
"""
import hmac
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

MAX_FILE = 50 * 1024 * 1024
MAX_TEXT = 32 * 1024
UPLOAD_PROTOCOL = 1
MAX_RENAME = 100
MAX_DIRECTORY_ENTRIES = 4096
MAX_SHARED_FILES = 1000
MAX_SHARED_BYTES = 1024 * 1024 * 1024


def scan_files(directory):
    entries, truncated, scanned = [], False, 0
    with os.scandir(directory) as files:
        for item in files:
            scanned += 1
            if scanned > MAX_DIRECTORY_ENTRIES:
                truncated = True
                break
            if not item.name.startswith('.upload-') and item.is_file(follow_symlinks=False):
                if len(entries) >= MAX_SHARED_FILES:
                    truncated = True
                    break
                info = item.stat(follow_symlinks=False)
                entries.append({'name': item.name, 'size': info.st_size, 'modified': info.st_mtime, 'version': file_version(info)})
    return entries, truncated


def file_version(info):
    value = ':'.join(str(item) for item in (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
    return hashlib.sha256(value.encode()).hexdigest()


def upload_policy(headers):
    mode = headers.get('X-Codex-Upload-Mode', 'create')
    match, absent = headers.get('If-Match'), headers.get('If-None-Match')
    if mode == 'replace':
        if absent is not None or not match or not re.fullmatch(r'"[a-f0-9]{64}"', match):
            raise AgentError(400, '替换文件需要有效的原文件版本')
        return mode, match[1:-1]
    if mode not in ('create', 'rename') or match is not None or absent is not None and (mode != 'create' or absent != '*'):
        raise AgentError(400, '上传处理方式无效')
    return mode, None


def rename_candidate(name, index):
    if index == 1:
        return name
    stem, extension = os.path.splitext(name)
    if len(extension.encode()) > 64:
        stem, extension = name, ''
    suffix = ' (' + str(index) + ')'
    budget = 240 - len((suffix + extension).encode())
    stem = stem.encode()[:budget].decode('utf-8', errors='ignore')
    return stem + suffix + extension
KEYS = {
    'Enter': 'Return', 'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'BackSpace',
    'Ctrl+C': 'ctrl+c', 'Ctrl+D': 'ctrl+d', 'Ctrl+L': 'ctrl+l',
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
}


class AgentError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Desktop:
    def __init__(self, secret, transfer_dir):
        self.secret = secret
        self.files_only = os.environ.get('FILE_AGENT_ONLY') == '1'
        self.terminal_only = os.environ.get('DEPLOY_MODE', 'desktop') == 'terminal'
        self.transfer_dir = Path(transfer_dir)
        self.transfer_dir.mkdir(parents=True, exist_ok=True)
        if self.transfer_dir.is_symlink():
            raise RuntimeError('文件中转目录不能是符号链接')
        self.input_lock = threading.Lock()
        self.upload_lock = threading.Lock()
        self.version = ''
        if not self.files_only:
            try:
                self.version = subprocess.run(['codex', '--version'], capture_output=True, text=True, timeout=10).stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                if not self.terminal_only:
                    raise

    def directory(self):
        return os.open(str(self.transfer_dir), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def run(self, args):
        try:
            subprocess.run(args, check=True, timeout=8, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.SubprocessError, OSError):
            raise AgentError(503, '桌面尚未就绪，或没有可接收输入的窗口')

    def action(self, path, body):
        if self.terminal_only or self.files_only:
            raise AgentError(501, '纯终端部署未启用桌面操作')
        with self.input_lock:
            if path == '/paste':
                text = body.get('text')
                if not isinstance(text, str) or not text or '\0' in text or len(text.encode('utf-8')) > MAX_TEXT:
                    raise AgentError(400, '请输入不超过 32 KiB 的文字')
                target = body.get('target', 'terminal')
                if target not in ('terminal', 'application'):
                    raise AgentError(400, '粘贴目标无效')
                try:
                    # xclip forks to own the selection; close inherited streams.
                    subprocess.run(['xclip', '-selection', 'clipboard', '-i'], input=text.encode('utf-8'),
                                   check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except (subprocess.SubprocessError, OSError):
                    raise AgentError(503, '剪贴板暂时不可用，请等待桌面就绪')
                self.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+shift+v' if target == 'terminal' else 'ctrl+v'])
            elif path == '/key':
                key = KEYS.get(body.get('key'))
                if not key:
                    raise AgentError(400, '不支持的按键')
                self.run(['xdotool', 'key', '--clearmodifiers', key])
            elif path == '/terminal':
                # Opening a terminal attaches the existing tmux session; it never
                # resubmits the last Codex prompt or restarts an active task.
                subprocess.Popen([str(Path(__file__).with_name('open-codex-terminal'))],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
            else:
                raise AgentError(404, '操作不存在')
        return {'ok': True}


class Handler(BaseHTTPRequestHandler):
    server_version = 'DesktopAgent'
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def log_message(self, *_args):
        pass  # Do not log input text, filenames or Authorization headers.

    def json(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def authenticated(self):
        actual = self.headers.get('Authorization', '')
        expected = 'Bearer ' + self.server.desktop.secret
        return hmac.compare_digest(actual.encode(), expected.encode())

    def filename(self, path):
        try:
            name = unquote(path[len('/files/'):], errors='strict')
        except (ValueError, UnicodeError):
            raise AgentError(400, '文件名无效')
        if not name or name in ('.', '..') or name.startswith('.upload-') or any(c in name for c in '/\\') or any(ord(c) < 32 or ord(c) == 127 for c in name) or len(name.encode()) > 240:
            raise AgentError(400, '文件名无效')
        return name

    def handle_request(self):
        if not self.authenticated():
            raise AgentError(401, '内部接口认证失败')
        path = urlsplit(self.path).path
        desktop = self.server.desktop
        if self.command == 'GET' and path == '/health':
            if desktop.files_only:
                return self.json(200, {'ready': True, 'uploadProtocol': UPLOAD_PROTOCOL, 'quotaProtocol': 1})
            command = ['tmux', '-S', os.environ['TMUX_SOCKET'], 'has-session', '-t', '=codex-host'] if desktop.terminal_only else ['xdotool', 'getdisplaygeometry']
            probe = subprocess.run(command, timeout=2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self.json(200, {'ready': probe.returncode == 0, 'version': desktop.version, 'uploadProtocol': UPLOAD_PROTOCOL, 'quotaProtocol': 1})
        if self.command == 'GET' and path == '/files':
            directory = desktop.directory()
            try:
                entries, truncated = scan_files(directory)
                return self.json(200, {'files': sorted(entries, key=lambda item: item['modified'], reverse=True), 'uploadProtocol': UPLOAD_PROTOCOL, 'quotaProtocol': 1, 'truncated': truncated})
            finally:
                os.close(directory)
        if path.startswith('/files/') and self.command in ('GET', 'PUT'):
            name = self.filename(path)
            directory = desktop.directory()
            try:
                if self.command == 'GET':
                    try:
                        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                    except OSError:
                        raise AgentError(404, '文件不存在或不是普通文件')
                    with os.fdopen(fd, 'rb') as source:
                        info = os.fstat(source.fileno())
                        if not stat.S_ISREG(info.st_mode):
                            raise AgentError(400, '只允许下载普通文件')
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/octet-stream')
                        self.send_header('Content-Length', str(info.st_size))
                        self.send_header('ETag', '"' + file_version(info) + '"')
                        self.send_header('Connection', 'close')
                        self.end_headers()
                        shutil.copyfileobj(source, self.wfile, 64 * 1024)
                        self.close_connection = True
                    return
                try:
                    length = int(self.headers.get('Content-Length', '-1'))
                except ValueError:
                    length = -1
                if length < 0 or length > MAX_FILE:
                    raise AgentError(413, '文件不能超过 50 MiB')
                mode, expected = upload_policy(self.headers)
                quota = self.headers.get('X-Codex-Upload-Quota')
                if quota not in (None, 'temporary-v1'):
                    raise AgentError(400, '上传配额参数无效')
                if not desktop.upload_lock.acquire(blocking=False):
                    raise AgentError(409, '正在上传其他文件，请稍后重试')
                temp = '.upload-' + os.urandom(12).hex()
                try:
                    def check_target():
                        try:
                            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        except FileNotFoundError:
                            if mode == 'replace':
                                raise AgentError(412, '原文件已不存在，未替换；请刷新后重新选择')
                            return
                        if mode == 'create':
                            raise AgentError(409, '已有同名文件，未覆盖；请选择替换或自动改名')
                        if mode == 'replace' and (not stat.S_ISREG(info.st_mode) or file_version(info) != expected):
                            raise AgentError(412, '原文件已变化，未替换；请刷新后重新选择')

                    def check_quota():
                        if quota is None:
                            return
                        entries, truncated = scan_files(directory)
                        if truncated:
                            raise AgentError(413, '目录超过核算范围，临时上传已暂停；请管理员整理文件')
                        existing = next((entry for entry in entries if entry['name'] == name), None)
                        replacing = mode == 'replace' and existing is not None
                        if len(entries) >= MAX_SHARED_FILES and not replacing:
                            raise AgentError(413, '共享目录已达到临时上传文件数量上限')
                        total = sum(entry['size'] for entry in entries)
                        if total - (existing['size'] if replacing else 0) + length > MAX_SHARED_BYTES:
                            raise AgentError(413, '共享目录已达到临时上传的 1 GiB 容量上限')

                    check_target()
                    check_quota()
                    if shutil.disk_usage(desktop.transfer_dir).free < length + 64 * 1024 * 1024:
                        raise AgentError(507, '文件中转目录的剩余空间不足')
                    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
                    with os.fdopen(fd, 'wb') as target:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(64 * 1024, remaining))
                            if not chunk:
                                raise AgentError(400, '上传未完成')
                            target.write(chunk)
                            remaining -= len(chunk)
                        target.flush()
                        os.fsync(target.fileno())
                    check_quota()
                    if mode == 'replace':
                        # Serialize API writers and recheck after receiving the
                        # body. Shell writes do not share this advisory lock.
                        check_target()
                        os.replace(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
                    else:
                        # link is atomic and never replaces an existing entry,
                        # including a symlink or a file created after the check.
                        for index in range(1, MAX_RENAME + 1 if mode == 'rename' else 2):
                            candidate = rename_candidate(name, index)
                            try:
                                os.link(temp, candidate, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                                name = candidate
                                break
                            except FileExistsError:
                                if mode == 'create':
                                    raise AgentError(409, '已有同名文件，未覆盖；请选择替换或自动改名')
                        else:
                            raise AgentError(409, '自动改名已尝试100个名称，请修改文件名后重试')
                finally:
                    try:
                        os.unlink(temp, dir_fd=directory)
                    except FileNotFoundError:
                        pass
                    desktop.upload_lock.release()
                return self.json(200, {'ok': True, 'name': name, 'size': length})
            finally:
                os.close(directory)
        if self.command == 'POST' and path in ('/paste', '/key', '/terminal'):
            try:
                length = int(self.headers.get('Content-Length', '-1'))
            except ValueError:
                length = -1
            if length < 0 or length > 128 * 1024:
                raise AgentError(413, '请求过大')
            try:
                body = json.loads(self.rfile.read(length).decode('utf-8'))
                if not isinstance(body, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                raise AgentError(400, 'JSON 格式无效')
            return self.json(200, desktop.action(path, body))
        raise AgentError(404, '接口不存在')

    def dispatch(self):
        try:
            self.handle_request()
        except AgentError as error:
            self.json(error.status, {'error': error.message})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.json(503, {'error': '桌面操作暂时不可用'})

    do_GET = dispatch
    do_POST = dispatch
    do_PUT = dispatch


class AgentServer(ThreadingHTTPServer):
    daemon_threads = True
    # Bound worker count so slow uploads cannot spawn unbounded threads.
    def __init__(self, address, desktop):
        self.desktop = desktop
        self.workers = threading.BoundedSemaphore(12)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.workers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.workers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.workers.release()


if __name__ == '__main__':
    secret = Path(os.environ['AGENT_SECRET_FILE']).read_text().strip()
    if len(secret) < 16:
        raise SystemExit('内部接口密钥无效')
    desktop = Desktop(secret, os.environ['TRANSFER_DIR'])
    # Recover interrupted uploads left by process termination, bounded to this directory.
    for item in desktop.transfer_dir.glob('.upload-*'):
        if item.is_file() and not item.is_symlink():
            item.unlink()
    server = AgentServer(('127.0.0.1', int(os.environ.get('AGENT_PORT', '36902'))), desktop)
    if desktop.files_only:
        # A crashed wrapper closes the private pipe, including outside systemd.
        def parent_closed():
            sys.stdin.buffer.read(1)
            server.shutdown()
        threading.Thread(target=parent_closed, daemon=True).start()
    print('终端与文件内部接口已启动' if desktop.terminal_only else '桌面内部接口已启动', flush=True)
    server.serve_forever()
