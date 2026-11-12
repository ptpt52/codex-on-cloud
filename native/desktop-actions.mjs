import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { TERMINALS } from './terminals.mjs';

const exec = promisify(execFile);
const reject = (status, message) => Object.assign(new Error(message), { status, outcome: 'rejected' });

// Eight terminal children and one foreground selection owner. No action queue,
// shell strings, credentials on disk, or automatic clipboard reads.
export function createDesktopActions(config, env, { spawnProcess = spawn, run = async (command, args) => (await exec(command, args, { env, timeout: 1000, maxBuffer: 8192 })).stdout.trim() } = {}) {
  const windows = new Map(), owners = new Set(); let clipboard, stopped = false;
  const alive = child => child && child.exitCode === null && child.signalCode === null;
  function start(command, args, stderr = 'ignore') {
    const child = spawnProcess(command, args, { env, stdio: ['pipe', 'ignore', stderr] });
    child.on('error', () => {}); return child;
  }
  return {
    async perform(path, body) {
      if (stopped) throw reject(503, '桌面执行服务已停止');
      if (path === '/terminal') {
        const deadline = performance.now() + 2500;
        if (Object.keys(body).join(',') !== 'id') throw reject(400, '终端参数无效');
        const definition = TERMINALS.find(item => item.id === body.id);
        if (!definition) throw reject(400, '终端目标无效');
        // Only attach an existing session. A recovery must never create a task.
        await run('tmux', ['-S', env.TMUX_SOCKET, 'has-session', '-t', '=' + definition.session]);
        let existing = '';
        try { existing = await run('xdotool', ['search', '--class', '^' + definition.className + '$']); } catch {}
        if (existing) return { ok: true };
        // A font update closes the old window before its child has reaped.
        // Give that fixed child time to exit; never report a closed window as
        // successfully reopened or spawn a second still-starting terminal.
        const previous = windows.get(body.id);
        // Share a bounded budget with the probes above, leaving time to reply
        // before the 3-second action socket deadline even on a busy host.
        while (!stopped && alive(previous) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (stopped) throw reject(503, '桌面执行服务已停止');
        if (alive(previous)) throw reject(409, '终端窗口正在启动或关闭，请稍后查看');
        const child = start(join(config.root, 'desktop', 'open-codex-terminal'), [body.id]);
        windows.set(body.id, child); child.stdin.end();
        await new Promise((resolve, fail) => { child.once('spawn', resolve); child.once('error', fail); });
        child.once('exit', () => { if (windows.get(body.id) === child) windows.delete(body.id); });
        return { ok: true };
      }
      if (path !== '/clipboard' || Object.keys(body).join(',') !== 'text' || typeof body.text !== 'string' || !body.text || body.text.includes('\0') || Buffer.byteLength(body.text) > 32768) throw reject(400, '剪贴板文字无效');
      if (owners.size >= 2) throw reject(409, '剪贴板所有者正在退出，请稍后操作');
      const previous = clipboard, child = start('xclip', ['-quiet', '-selection', 'clipboard', '-in'], 'pipe');
      owners.add(child); child.once('close', () => owners.delete(child));
      clipboard = child; child.stdin.on('error', () => {});
      try {
        // xclip -quiet emits this fixed message after taking the X selection.
        // Drain stderr for its lifetime, retaining only a 256-byte startup tail.
        await new Promise((resolve, fail) => {
          let tail = '', pending = true;
          const finish = error => { if (!pending) return; pending = false; clearTimeout(timer); tail = ''; child.removeListener('error', failed); child.removeListener('exit', exited); error ? fail(error) : resolve(); };
          const failed = () => finish(Error('clipboard unavailable')), exited = () => finish(Error('clipboard owner exited'));
          const timer = setTimeout(() => finish(Error('clipboard ownership timed out')), 1800);
          child.on('error', failed); child.on('exit', exited);
          child.stderr.on('data', bytes => { if (pending) { tail = (tail + bytes.toString()).slice(-256); if (tail.includes('Waiting for selection requests, Control-C to quit')) finish(); } });
          child.stdin.end(body.text);
        });
        if (stopped || !alive(child)) throw Error('clipboard unavailable');
        if (alive(previous)) previous.kill('SIGKILL');
        return { ok: true };
      } catch (error) { child.kill('SIGKILL'); if (clipboard === child) clipboard = alive(previous) ? previous : undefined; throw error; }
    },
    close() { stopped = true; for (const child of owners) child.kill('SIGKILL'); for (const child of windows.values()) child.kill(); windows.clear(); },
  };
}

export function createDesktopActionServer(secret, actions) {
  const expected = Buffer.from('Bearer ' + secret); let active = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(body)); } };
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: '桌面执行接口认证失败', outcome: 'rejected' });
    if (req.method !== 'POST' || !['/terminal', '/clipboard'].includes(req.url)) return reply(404, { error: '动作不存在', outcome: 'rejected' });
    if (active) return reply(409, { error: '桌面执行服务繁忙，本次操作未发送', outcome: 'rejected' });
    active = true; req.setTimeout(3000, () => req.destroy());
    try {
      if (req.headers['content-type'] !== 'application/json') throw reject(415, '需要 JSON 请求');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 200 * 1024) throw reject(413, '动作内容过大'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error(); } catch { throw reject(400, 'JSON 格式无效'); }
      if (res.destroyed) return;
      reply(200, await actions.perform(req.url, body));
    } catch (error) { reply(error.status || 503, { error: error.status ? error.message : '桌面动作结果未知，请先查看桌面', outcome: error.outcome || 'unknown' }); }
    finally { active = false; }
  });
  server.maxConnections = 4; server.headersTimeout = 3000; server.requestTimeout = 3000; server.maxHeadersCount = 16;
  return server;
}

export function desktopActionClient(socketPath, secret) {
  return (path, body) => new Promise((resolve, fail) => {
    const payload = JSON.stringify(body);
    const req = http.request({ socketPath, path, method: 'POST', signal: AbortSignal.timeout(3500),
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2048) res.destroy(Error('response too large')); else chunks.push(chunk); });
      res.once('error', fail); res.once('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (res.statusCode !== 200) throw Object.assign(Error(value.error), { outcome: value.outcome, status: res.statusCode }); resolve(value); } catch (error) { fail(error); } });
    });
    req.once('error', () => fail(Object.assign(Error('桌面执行服务未就绪，本次操作未重试'), { outcome: 'unknown' }))); req.end(payload);
  });
}
