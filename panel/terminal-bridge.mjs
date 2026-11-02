import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../desktop/web-terminal.py', import.meta.url));
export const TERMINAL_KEYS = Object.freeze({ Enter: '\r', Tab: '\t', Escape: '\x1b', Backspace: '\x7f', Delete: '\x1b[3~',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C', Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~', 'Shift+Tab': '\x1b[Z', 'Ctrl+ArrowLeft': '\x1b[1;5D', 'Ctrl+ArrowRight': '\x1b[1;5C',
  'Alt+Backspace': '\x1b\x7f', 'Alt+D': '\x1bd', 'Alt+B': '\x1bb', 'Alt+F': '\x1bf', 'Escape Escape': '\x1b\x1b',
  ...Object.fromEntries('ACDEGJKLORUVWYZ'.split('').map(key => [`Ctrl+${key}`, String.fromCharCode(key.charCodeAt(0) - 64)])),
});
export function terminalPaste(text, bracketed) {
  if (typeof text !== 'string' || !text || text.includes('\0') || Buffer.byteLength(text) > 32768) throw new Error('粘贴文字需在 32 KiB 内');
  if (!bracketed && /[\r\n]/.test(text)) throw new Error('当前程序未启用多行粘贴保护，请分行粘贴并手动提交');
  const clean = text.replace(/\x1b\[20[01]~/g, '');
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean;
}
export function attachTerminal(ws, { socketPath, terminalId, terminalToken, env, valid, verify, readClipboard, launch }) {
  const child = launch ? launch() : spawn('python3', [helper, socketPath, terminalId, terminalToken], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let ended = false, ready = false, pending = '', outstanding = 0, sequence = 0, lastClientId = 0, busy = false;
  const requests = new Map(); // At most 64 streamed records / 64 KiB in the helper.
  let rawWindow = Date.now(), rawBytes = 0;
  let lastHealthNonce = 0, healthWindow = Date.now(), healthCount = 0;
  let pressureTimer, escapeTimer;
  const close = () => {
    if (ended) return;
    ended = true; clearTimeout(startTimer); clearTimeout(pressureTimer); clearTimeout(escapeTimer); clearInterval(heartbeat); clearInterval(guard);
    child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1500).unref(); child.once('close', () => clearTimeout(killTimer));
    requests.clear(); ws.terminate();
  };
  const send = value => { if (ended || !valid() || ws.readyState !== 1 || ws.bufferedAmount > 256 * 1024) return close(); ws.send(JSON.stringify(value)); };
  const startTimer = setTimeout(close, 4500).unref();
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const heartbeat = ws.ping ? setInterval(() => { if (!alive || !valid()) return close(); alive = false; ws.ping(); }, 15000).unref() : undefined;
  let checking = false;
  const guard = setInterval(() => {
    if (checking || ended) return;
    checking = true;
    void verify().then(ok => { if (!ok) close(); }, close).finally(() => { checking = false; });
  }, 3000).unref();
  function command(action, value, clientId) {
    if (ended || !ready || !valid() || sequence >= 2147483647 || requests.size >= 64 || child.stdin.writableLength > 64 * 1024) throw new Error('terminal unavailable');
    const id = ++sequence;
    requests.set(id, clientId || 0);
    child.stdin.write(JSON.stringify({ id, action, ...value }) + '\n');
  }
  child.stdout.on('data', bytes => {
    if (ended) return;
    pending += bytes.toString('utf8');
    if (pending.length > 128 * 1024) return close();
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (line.length > 24 * 1024) return close();
      let value;
      try { value = JSON.parse(line); } catch { return close(); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return close();
      if (!valid()) return close();
      if (value.type === 'ready' && !ready) { ready = true; clearTimeout(startTimer); send({ type: 'ready' }); }
      else if (value.type === 'output' && typeof value.data === 'string' && value.data.length <= 11000) {
        const size = Buffer.from(value.data, 'base64').length; outstanding += size;
        if (outstanding > 192 * 1024) return close();
        send({ type: 'output', data: value.data });
        if (outstanding >= 64 * 1024) { child.stdout.pause(); pressureTimer ||= setTimeout(close, 10000).unref(); }
      } else if (value.type === 'result' && requests.has(value.id)) {
        const clientId = requests.get(value.id); requests.delete(value.id);
        if (clientId) { busy = false; send({ type: 'result', id: clientId, ok: value.ok === true, outcome: value.ok ? 'success' : 'rejected' }); }
        if (value.ok !== true) return close();
      } else return close();
    }
  });
  ws.on('message', (bytes, binary) => {
    if (ended) return;
    if (binary || bytes.length > 256 * 1024 || !valid()) return close();
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { return close(); }
    if (value?.type === 'health') {
      if (!ready || bytes.length > 96 || Object.keys(value).length !== 2 || !Number.isSafeInteger(value.nonce) || value.nonce <= lastHealthNonce || value.nonce > 2147483647) return close();
      if (Date.now() - healthWindow >= 1000) { healthWindow = Date.now(); healthCount = 0; }
      if (++healthCount > 8) return close();
      lastHealthNonce = value.nonce;
      send({ type: 'health', nonce: value.nonce }); return;
    }
    if (value?.type === 'ack') {
      if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > outstanding) return close();
      outstanding -= value.bytes; if (outstanding < 16 * 1024) { clearTimeout(pressureTimer); pressureTimer = null; child.stdout.resume(); } return;
    }
    if (!ready || !Number.isSafeInteger(value?.id) || value.id <= lastClientId || value.id > 2147483647) return close();
    lastClientId = value.id;
    try {
      if (value.type === 'resize') {
        if (!Number.isInteger(value.cols) || !Number.isInteger(value.rows) || value.cols < 2 || value.cols > 500 || value.rows < 1 || value.rows > 200) return close();
        command('resize', { cols: value.cols, rows: value.rows }); return;
      }
      if (value.type === 'input') {
        if (typeof value.data !== 'string' || !value.data || Buffer.byteLength(value.data) > 8192) return close();
        if (Date.now() - rawWindow >= 1000) { rawWindow = Date.now(); rawBytes = 0; }
        rawBytes += Buffer.byteLength(value.data); if (rawBytes > 64 * 1024) return close();
        command('input', { data: Buffer.from(value.data).toString('base64') }); return;
      }
      if (value.type !== 'control' || busy) return close();
      busy = true;
      void (async () => {
        let text;
        try {
          if (value.action === 'paste') text = terminalPaste(value.text, value.bracketed === true);
          else if (value.action === 'key' && value.key === 'Ctrl+Shift+V') text = terminalPaste(await readClipboard(), value.bracketed === true);
          else if (value.action === 'key' && Object.hasOwn(TERMINAL_KEYS, value.key)) text = TERMINAL_KEYS[value.key];
          else throw new Error('该按键在网页终端中不可用');
          if (!valid()) return close();
          if (value.action === 'key' && value.key === 'Escape Escape') {
            command('input', { data: Buffer.from('\x1b').toString('base64') });
            escapeTimer = setTimeout(() => { try { command('input', { data: Buffer.from('\x1b').toString('base64') }, value.id); } catch { close(); } }, 80);
            return;
          }
          command('input', { data: Buffer.from(text).toString('base64') }, value.id);
        } catch (error) { busy = false; send({ type: 'result', id: value.id, ok: false, outcome: 'rejected', message: error.message }); }
      })();
    } catch { close(); }
  });
  for (const stream of [child, child.stdin, child.stdout]) stream.on('error', close);
  child.once('close', close); ws.once('close', close); ws.once('error', close);
  return { close, get idle() { return !ended && ready && !busy && requests.size === 0; } };
}
