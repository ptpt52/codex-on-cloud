import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPanel } from '../panel/server.mjs';
import { createDesktopControls } from '../native/desktop-controls.mjs';
import { createManagerServer } from '../native/manager-server.mjs';
import { readPreferences } from '../native/preferences.mjs';
import { viewportSize } from '../native/viewport.mjs';


export async function fixture({ port = 0, dataDir, password = 'test_password_very_long_123', sessionMs, rfb = false, rfbSize, webrtc = false, fastConnect = false, seamless = false, webrtcIPv6 = false, webrtcIPv6Address, webrtcStunUrl = '', viewport = false, viewportMaximum, viewportHook, tunnelDiagnosticsUrl, inputHook, desktopHook, applyHook, clipboardHook, terminalHook, terminalHistory = '', terminalHistoryHook, terminalHistoryAlternate = false, terminalMaxCols = 500, forwardPorts = [22], forwardDownloadDir, forwardPeerFactory } = {}) {
  const directory = dataDir || await mkdtemp(join(tmpdir(), 'codex-cloud-test-'));
  const received = [];
  const inputCalls = [];
  const clipboardReads = [];
  const clipboardText = { clipboard: '', primary: '' };
  const terminalInputs = [], terminalSizes = [], terminalHistoryReads = [], terminalChildren = new Set(); let terminalConnections = 0;
  const terminalGeometry = { maxCols: terminalMaxCols };
  const files = new Map();
  const screenGeometry = { width: rfbSize?.width ?? 1600, height: rfbSize?.height ?? 1600 };
  const managementStats = { saves: 0, restarts: 0, resumes: 0, fontChanges: 0, maximizes: 0, restores: 0, viewportResizes: 0 };
  const tunnel = { tunnelID: 'private-tunnel-id', connectorID: 'private-connector-id', connections: [
    { isConnected: true, edgeAddress: '2001:db8::1' }, { isConnected: true, edgeAddress: '2001:db8::2' },
    { isConnected: true, edgeAddress: '192.0.2.1' }, { isConnected: false, edgeAddress: '192.0.2.2' },
  ] };
  const upstream = http.createServer(async (req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === '/diag/tunnel') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(tunnel)); }
    if (req.url === '/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ready: true, version: '模拟桌面 · 仅供测试' })); }
    if (req.url === '/files') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ files: [...files].map(([name, content]) => ({ name, size: content.length, modified: 1 })) })); }
    if (req.url.startsWith('/files/')) {
      const name = decodeURIComponent(req.url.slice('/files/'.length));
      if (req.method === 'PUT') { files.set(name, body); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, name })); }
      if (!files.has(name)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: '文件不存在' })); }
      res.setHeader('content-length', files.get(name).length); return res.end(files.get(name));
    }
    if (['/paste', '/key', '/terminal'].includes(req.url)) {
      received.at(-1).body = JSON.parse(body);
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end();
  });
  const clients = new Set();
  let viewersPaused = false;
  let vncConnections = 0;
  const vnc = net.createServer(socket => {
    vncConnections++;
    clients.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => clients.delete(socket));
    if (viewersPaused) return;
    if (!rfb) return socket.on('data', bytes => { received.push({ method: 'VNC', bytes }); socket.write(bytes); });
    // Minimal RFB fixture; browsers still use the real noVNC client and Unix socket bridge.
    socket.write('RFB 003.008\n');
    let phase = 0, pending = Buffer.alloc(0), sent = false;
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      if (phase === 0 && pending.length >= 12) { pending = pending.subarray(12); socket.write(Buffer.from([1, 1])); phase = 1; }
      if (phase === 1 && pending.length >= 1) { pending = pending.subarray(1); socket.write(Buffer.alloc(4)); phase = 2; }
      if (phase === 2 && pending.length >= 1) {
        pending = pending.subarray(1); phase = 3;
        const name = Buffer.from('SIMULATED DESKTOP - TEST ONLY');
        const header = Buffer.alloc(24);
        header.writeUInt16BE(screenGeometry.width, 0); header.writeUInt16BE(screenGeometry.height, 2);
        header.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
        header.writeUInt32BE(name.length, 20); socket.write(Buffer.concat([header, name]));
      } else if (phase === 3 && !sent) {
        sent = true;
        const frame = Buffer.alloc(16 + screenGeometry.width * screenGeometry.height * 4);
        frame.writeUInt16BE(1, 2); frame.writeUInt16BE(screenGeometry.width, 8); frame.writeUInt16BE(screenGeometry.height, 10);
        for (let i = 16; i < frame.length; i += 4) frame.set([34, 48, 29, 0], i);
        socket.write(frame);
      }
      if (phase === 3) pending = Buffer.alloc(0);
    });
  });
  const vncSocket = join(directory, 'vnc.sock');
  vnc.listen(vncSocket); await once(vnc, 'listening');
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const preferencesFile = join(directory, 'desktop-settings.json');
  const defaultPreferences = { width: 1600, height: viewport ? 3200 : 1600, fontSize: 15 };
  const maximum = viewportMaximum || { width: 1600, height: viewport ? 3200 : 1600 };
  const viewportControls = viewport ? {
    status: () => ({ supported: true, maximum, actual: { width: screenGeometry.width, height: screenGeometry.height } }),
    async refresh() { return this.status(); },
    async resize(value, options) {
      await viewportHook?.(value);
      const size = viewportSize(value, maximum, options); Object.assign(screenGeometry, size); managementStats.viewportResizes++;
      if (rfb) for (const socket of clients) {
        if (socket.destroyed) continue;
        const update = Buffer.alloc(16); update.writeUInt16BE(1, 2); update.writeUInt16BE(size.width, 8); update.writeUInt16BE(size.height, 10); update.writeInt32BE(-223, 12); socket.write(update);
      }
      return { actual: size, maximum };
    },
  } : undefined;
  let panePid = 4000, paneCommand = 'codex', terminalVisible = true, terminalChild;
  const auxiliary = new Map(); let activeWindow = '999', nextAuxPid = 4100;
  const controls = createDesktopControls({ root: directory, runtime: directory, display: ':99', workspace: '/test-workspace', transfer: '/test-workspace/transfer',
    env: process.env, preferencesFile, defaultPreferences }, {
    viewport: viewportControls,
    performInput: async value => { inputCalls.push(value); await inputHook?.(value); },
    readClipboard: async source => {
      clipboardReads.push(source);
      await clipboardHook?.(source);
      return { source, text: clipboardText[source], bytes: Buffer.byteLength(clipboardText[source]) };
    },
    sessionId: async () => '11111111-1111-4111-8111-111111111111',
    terminalParentPid: async pid => String(Number(pid) - 10000),
    launch: (id = 'main') => {
      if (id !== 'main') { const terminal = auxiliary.get(id); terminal.visible = true; return { exitCode: 0, signalCode: null }; }
      terminalVisible = true; terminalChild = { exitCode: null, signalCode: null }; return terminalChild;
    },
    run: async (command, args) => {
      await desktopHook?.(command, args);
      if (command === 'xdotool' && args[0] === 'getdisplaygeometry') return `${screenGeometry.width} ${screenGeometry.height}`;
      if (command === 'xdotool' && args[0] === 'search') {
        const id = args.at(-1).match(/terminal-(aux[123])/i)?.[1];
        if (id) return auxiliary.get(id)?.visible ? String(1000 + Number(id.slice(-1))) : '';
        return terminalVisible ? '999' : '';
      }
      if (command === 'xdotool' && args[0] === 'getactivewindow') return activeWindow;
      if (command === 'xdotool' && args[0] === 'getwindowpid') return args[1];
      if (command === 'xdotool' && args[0] === 'windowactivate') { activeWindow = args.at(-1); return ''; }
      if (command === 'xdotool' && args[0] === 'windowclose') { terminalVisible = false; if (terminalChild) terminalChild.exitCode = 0; managementStats.fontChanges++; return ''; }
      if (command === 'python3') { if (args[1] === 'maximize') managementStats.maximizes++; else managementStats.restores++; return ''; }
      if (command === 'systemctl') {
        managementStats.restarts++;
        Object.assign(screenGeometry, readPreferences(preferencesFile, defaultPreferences));
        panePid++; paneCommand = 'bash';
        for (const client of clients) client.destroy();
        return '';
      }
      if (command === 'tmux' && args.includes('respawn-pane')) { managementStats.resumes++; paneCommand = 'codex'; return ''; }
      if (command === 'tmux' && args.includes('set-environment')) return '';
      if (command === 'tmux' && args.includes('new-session')) {
        const id = args[args.indexOf('-s') + 1].replace('codex-', ''); auxiliary.set(id, { pid: nextAuxPid++, name: '', visible: false }); return '';
      }
      if (command === 'tmux' && args.includes('set-option')) {
        const id = args[args.indexOf('-t') + 1].replace('codex-', '');
        if (id === 'codex') return '';
        auxiliary.get(id).name = args.at(-1); return '';
      }
      if (command === 'tmux' && args.includes('list-clients')) return [terminalVisible ? '10999\t/dev/pts/0\tcodex' : '', ...[...auxiliary].filter(([, item]) => item.visible).map(([id]) => `${11000 + Number(id.slice(-1))}\t/dev/pts/${id.slice(-1)}\tcodex-${id}`)].filter(Boolean).join('\n');
      if (command === 'tmux' && args.includes('list-panes')) {
        if (args.at(-1).includes('#{pane_id}')) return [`codex\t%0\t${panePid}\t${paneCommand}\t0\t0\t`, ...[...auxiliary].map(([id, terminal]) => `codex-${id}\t%${id.slice(-1)}\t${terminal.pid}\tbash\t0\t0\t${terminal.name}`)].join('\n');
        return args.at(-1) === '#{pane_pid}' ? [panePid, ...[...auxiliary.values()].map(item => item.pid)].join('\n') : [`codex:0.0\t${panePid}\t${paneCommand}\t/test-workspace`, ...[...auxiliary].map(([id, terminal]) => `codex-${id}:0.0\t${terminal.pid}\tbash\t/test-workspace`)].join('\n');
      }
      throw new Error('Unexpected mock desktop command');
    },
  });
  const manager = createManagerServer('agent_secret_for_test_123', { ...controls,
    async apply(body) { await applyHook?.(); return controls.apply(body); },
    save(body) { const result = controls.save(body); managementStats.saves++; return result; } });
  const managerSocket = join(directory, 'manager.sock');
  manager.listen(managerSocket); await once(manager, 'listening');
  const config = {
    host: '127.0.0.1', port, origin: '', secureCookies: false, hosts: new Set(),
    forwardPorts, forwardDownloadDir, forwardPeerFactory, agentPort: upstream.address().port,
    dataDir: directory, username: 'admin', password,
    agentSecret: 'agent_secret_for_test_123', vncSocket, agentUrl: upstreamUrl,
    tunnelDiagnosticsUrl: tunnelDiagnosticsUrl ?? `${upstreamUrl}/diag/tunnel`,
    managerSocket,
    transferDir: '/test-workspace/transfer', sessionMs: sessionMs || 604800000,
    webrtc, webrtcAddress: '127.0.0.1', fastConnect, streamProtocol: seamless ? 1 : 0,
    webrtcIPv6, webrtcIPv6Address, webrtcStunUrl,
    terminalLaunch(target) {
      terminalConnections++;
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); terminalChildren.add(child);
      let ended = false, pending = '';
      child.kill = () => { if (ended) return; ended = true; terminalChildren.delete(child); child.stdin.destroy(); child.stdout.destroy(); queueMicrotask(() => child.emit('close', 0)); };
      const emit = value => { if (!ended) child.stdout.write(JSON.stringify(value) + '\n'); };
      child.stdin.on('data', bytes => {
        pending += bytes.toString(); let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const value = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          void (async () => {
            if (value.action === 'history') {
              terminalHistoryReads.push({ terminalId: target.terminalId, offset: value.offset }); if (terminalHistoryReads.length > 128) terminalHistoryReads.shift();
              await terminalHistoryHook?.(value.offset);
              const historyText = typeof terminalHistory === 'function' ? terminalHistory() : terminalHistory;
              const source = Buffer.from(value.styled ? historyText : historyText.replace(/\x1b\[[\d;:]*m/g, ''));
              let bytes = source.subarray(-65536);
              if (value.styled && source.length > 65536) { const boundary = bytes.indexOf(10); if (boundary >= 0 && boundary < bytes.length - 1) bytes = bytes.subarray(boundary + 1); }
              const data = bytes.subarray(value.offset, value.offset + 8192);
              emit({ type: 'history', id: value.id, offset: value.offset, next: value.offset + data.length, data: data.toString('base64'), done: value.offset + data.length === bytes.length,
                alternate: terminalHistoryAlternate, truncated: source.length > 65536, styled: value.styled === true, ok: true }); return;
            }
            if (value.action === 'resize') { terminalSizes.push({ terminalId: target.terminalId, cols: value.cols, rows: value.rows }); emit({ type: 'geometry', maxCols: value.viewport ? 500 : terminalGeometry.maxCols }); }
            else { const data = Buffer.from(value.data, 'base64'), text = data.toString(); terminalInputs.push({ terminalId: target.terminalId, text }); await terminalHook?.(text); for (let offset = 0; offset < data.length; offset += 8192) emit({ type: 'output', data: data.subarray(offset, offset + 8192).toString('base64') }); }
            emit({ type: 'result', id: value.id, ok: true });
          })();
        }
      });
      setTimeout(() => { emit({ type: 'ready' }); emit({ type: 'geometry', maxCols: terminalMaxCols }); emit({ type: 'output', data: Buffer.from(`\x1b[?2004h模拟文字终端 ${target.terminalId}\r\n中文显示\r\n$ `).toString('base64') }); }, 10);
      return child;
    },
  };
  const panel = await createPanel(config);
  panel.server.listen(port, '127.0.0.1'); await once(panel.server, 'listening');
  config.origin = `http://127.0.0.1:${panel.server.address().port}`;
  config.hosts.add(new URL(config.origin).host);
  let cookie = '', csrf = '';
  const viewer = '11111111-1111-4111-8111-111111111111';
  async function request(path, { method = 'GET', body, headers = {}, raw } = {}) {
    return fetch(config.origin + path, {
      method, headers: { origin: config.origin, cookie, 'x-csrf-token': csrf, 'x-viewer-id': viewer, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual',
    });
  }
  async function login() {
    const response = await request('/api/login', { method: 'POST', body: { username: 'admin', password } });
    cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json(); csrf = data.csrf;
    return { cookie, csrf };
  }
  async function claim(id = viewer) { return request('/api/desktop/claim', { method: 'POST', body: { viewer: id } }); }
  return {
    panel, config, directory, received, inputCalls, clipboardReads, clipboardText, controls, files, viewer, request, login, claim, managementStats, terminalInputs, terminalSizes, terminalHistoryReads, terminalGeometry,
    get terminalConnections() { return terminalConnections; },
    get terminalChildren() { return [...terminalChildren]; },
    disconnectTerminals() { for (const child of [...terminalChildren]) child.kill(); },
    disconnectViewers() { for (const client of clients) client.destroy(); },
    pauseViewers() { viewersPaused = true; for (const client of clients) client.destroy(); },
    resumeViewers() { viewersPaused = false; for (const client of clients) client.destroy(); },
    get cookie() { return cookie; }, get csrf() { return csrf; },
    get vncConnections() { return vncConnections; },
    async close({ preserve = false } = {}) {
      await panel.close();
      await new Promise(resolve => { manager.close(resolve); manager.closeAllConnections(); });
      for (const client of clients) client.destroy();
      await new Promise(resolve => vnc.close(resolve));
      await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
      if (!preserve && !dataDir) await rm(directory, { recursive: true, force: true });
    },
  };
}
