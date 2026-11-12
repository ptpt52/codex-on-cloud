import { test, expect } from '@playwright/test';
import { fixture } from '../fixture.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function login(page, app) {
  await page.addInitScript(() => {
    if (window === parent) localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, zoom: 'width', pan: false, collapsed: false, mode: 'terminal', terminalInputCollapsed: true }));
    if (location.pathname !== '/terminal/index.html') return;
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal,
      set: Native => { Terminal = class extends Native { constructor(...args) { super(...args); window.selectionTerminal = this; } }; } });
  });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await expect(page.locator('#connection-status')).toContainText('终端在线');
  return page.frames().find(frame => frame.url().includes('/terminal/index.html'));
}
function output(app, text) {
  const bytes = Buffer.from(text), child = app.terminalChildren.at(-1);
  for (let index = 0; index < bytes.length; index += 8192) child.stdout.write(JSON.stringify({ type: 'output', data: bytes.subarray(index, index + 8192).toString('base64') }) + '\n');
}
async function point(frame, column, row = 0) {
  const box = await frame.locator('.xterm-screen').boundingBox();
  const size = await frame.evaluate(() => ({ cols: window.selectionTerminal.cols, rows: window.selectionTerminal.rows }));
  return { x: box.x + box.width * column / size.cols, y: box.y + box.height * (row + 0.5) / size.rows };
}

for (const mode of ['none', 'vt200', 'drag', 'any']) test(`right click preserves selected plain text and the native copy target in ${mode} mouse mode`, async ({ page, context, browserName }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app), text = 'COPY-中文  <safe>', mouse = mode !== 'none';
    const tracking = { vt200: 1000, drag: 1002, any: 1003 }[mode];
    const start = await point(frame, 0.1);
    await page.mouse.move(start.x, start.y);
    output(app, (mouse ? `\x1b[?1049h\x1b[?${tracking}h\x1b[?1006h` : '') + '\x1b[2J\x1b[H' + text);
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.buffer.active.getLine(0)?.translateToString(true))).toBe(text);
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.modes.mouseTrackingMode)).toBe(mode);
    const end = await point(frame, 17.1), click = await point(frame, 6.5);
    await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.getSelection())).toBe(text);
    await page.mouse.click(click.x, click.y, { button: 'right' });
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.getSelection())).toBe(text);
    expect(await frame.locator('.xterm-screen').evaluate(el => {
      const box = el.getBoundingClientRect();
      return el.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true, clientX: box.x + 2, clientY: box.y + 2 }));
    })).toBe(true);
    const input = frame.locator('.xterm-helper-textarea');
    await expect(input).toHaveValue(text);
    expect(await input.evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length)).toBe(true);
    expect(await input.evaluate(el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).zIndex === '1000'; })).toBe(true);
    const copied = await input.evaluate(el => {
      const data = new DataTransfer(), event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data });
      el.dispatchEvent(event); return { text: event.clipboardData.getData('text/plain'), prevented: event.defaultPrevented };
    });
    expect(copied).toEqual({ text, prevented: true });
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.config.origin });
      expect(await input.evaluate(el => el.ownerDocument.execCommand('copy'))).toBe(true);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    }
    if (mouse) expect(app.terminalInputs.some(value => /^\x1b\[<0;/.test(value.text))).toBe(true);
    else expect(app.terminalInputs).toEqual([]);
    expect(app.terminalInputs.some(value => /^\x1b\[<2;/.test(value.text))).toBe(false);
    expect(app.inputCalls).toEqual([]); expect(app.managementStats.restarts).toBe(0);
  } finally { await app.close(); }
});

test('unselected clicks still reach a mouse-aware application and the browser menu is not cancelled', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app);
    output(app, '\x1b[?1002h\x1b[?1006h');
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.modes.mouseTrackingMode)).toBe('drag');
    const click = await point(frame, 3.5);
    await page.mouse.click(click.x, click.y);
    await expect.poll(() => app.terminalInputs.map(value => value.text).join('')).toContain('\x1b[<0;');
    await page.mouse.click(click.x, click.y, { button: 'right' });
    await expect.poll(() => app.terminalInputs.map(value => value.text).join('')).toContain('\x1b[<2;');
    expect(await frame.locator('.xterm-screen').evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })))).toBe(true);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('reverse multi-line program drags establish a browser selection without requesting the server clipboard', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app);
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => (window.unwantedCopies ||= []).push(text) } }));
    output(app, '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[HROW1 中文\r\nROW2 tail');
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.buffer.active.getLine(1)?.translateToString(true))).toBe('ROW2 tail');
    const start = await point(frame, 9.1, 1), end = await point(frame, .1);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up();
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.getSelection())).toBe('ROW1 中文\nROW2 tail');
    await page.mouse.click(end.x, end.y, { button: 'right' });
    await expect(frame.locator('.xterm-helper-textarea')).toHaveValue('ROW1 中文\nROW2 tail');
    output(app, '\x1b]52;c;VU5TT0xJQ0lURUQ=\x07\x1b[3;1HOSC-PARSED');
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.buffer.active.getLine(2)?.translateToString(true))).toBe('OSC-PARSED');
    expect(await frame.evaluate(() => window.unwantedCopies || [])).toEqual([]);
    expect(app.terminalInputs.some(value => /^\x1b\[<2;/.test(value.text))).toBe(false);
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('an immediate right click finishes a pending local selection before the native menu opens', async ({ page }) => {
  const app = await fixture();
  try {
    const frame = await login(page, app);
    output(app, '\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[HFAST-COPY');
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.buffer.active.getLine(0)?.translateToString(true))).toBe('FAST-COPY');
    const value = await frame.locator('.xterm-screen').evaluate(el => {
      const term = window.selectionTerminal, box = el.getBoundingClientRect(), x = box.width / term.cols, y = box.y + box.height / term.rows / 2;
      const dispatch = (type, col, button, buttons) => el.dispatchEvent(new MouseEvent(type, { clientX: box.x + col * x, clientY: y, button, buttons, bubbles: true, cancelable: true }));
      dispatch('mousedown', .1, 0, 1); dispatch('mousemove', 9.1, 0, 1); dispatch('mouseup', 9.1, 0, 0);
      dispatch('mousedown', 5.1, 2, 2);
      return { selected: term.getSelection(), native: dispatch('contextmenu', 5.1, 2, 2), value: term.textarea.value };
    });
    expect(value).toEqual({ selected: 'FAST-COPY', native: true, value: 'FAST-COPY' });
    expect(app.inputCalls).toEqual([]);
  } finally { await app.close(); }
});

test('real isolated tmux and Python PTY allow a native copy menu without a program clipboard reply', async ({ page }) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'codex-terminal-mouse-')), socket = join(directory, 'tmux.sock');
  const script = join(directory, 'receiver.py'), proof = join(directory, 'proof.json'), children = [];
  const env = { ...process.env, TERM: 'xterm-256color', DEPLOY_MODE: 'terminal', HISTFILE: '/dev/null', DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  delete env.TMUX; delete env.DISPLAY; delete env.XAUTHORITY;
  const exec = promisify(execFile), run = args => exec('tmux', ['-S', socket, ...args], { env, timeout: 3000, maxBuffer: 8192 });
  let app;
  try {
    await writeFile(script, `import json, os, re, select, sys, time, tty
from pathlib import Path
tty.setraw(0)
state = {'copies': 0, 'wheels': 0, 'pages': 0}
proof = Path(sys.argv[2])
def save():
    temporary = proof.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(proof)
save()
os.write(1, b'\\x1b[?1049h\\x1b[?1002h\\x1b[?1006h\\x1b[2J\\x1b[HREAL-MOUSE-COPY')
pending = b''
deadline = time.monotonic() + 55
while time.monotonic() < deadline:
    if not select.select([0], [], [], .1)[0]:
        continue
    chunk = os.read(0, 4096)
    if not chunk:
        break
    pending = (pending + chunk)[-8192:]
    state['pages'] = min(128, state['pages'] + chunk.count(b'\\x1b[5~') + chunk.count(b'\\x1b[6~'))
    while (match := re.search(rb'\\x1b\\[<(\\d+);\\d+;\\d+([Mm])', pending)):
        code, action = int(match[1]), match[2]
        pending = pending[match.end():]
        if code in (64, 65):
            state['wheels'] = min(128, state['wheels'] + 1)
        if code == 2 and action == b'M':
            state['copies'] = min(128, state['copies'] + 1)
        save()
`);
    const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await exec('tmux', ['-f', resolve('desktop/tmux.conf'), '-S', socket, 'new-session', '-d', '-s', 'codex', '-x', '80', '-y', '24', ['python3', script, socket, proof].map(quoted).join(' ')], { env, timeout: 3000 });
    const token = (await run(['display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}'])).stdout.trim();
    app = await fixture();
    app.config.terminalLaunch = () => {
      const child = spawn('python3', [resolve('desktop/web-terminal.py'), socket, 'main', token, '--geometry'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
      children.push(child); return child;
    };
    const frame = await login(page, app);
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => (window.programCopies ||= []).push(text) } }));
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.buffer.active.getLine(0)?.translateToString(true))).toBe('REAL-MOUSE-COPY');
    const start = await point(frame, .2), end = await point(frame, 8.2);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up();
    await page.mouse.click(end.x, end.y, { button: 'right' });
    await expect.poll(() => frame.evaluate(() => window.selectionTerminal.getSelection())).toBe('REAL-MOU');
    await expect(frame.locator('.xterm-helper-textarea')).toHaveValue('REAL-MOU');
    const copied = await frame.locator('.xterm-helper-textarea').evaluate(el => {
      const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      el.dispatchEvent(event); return event.clipboardData.getData('text/plain');
    });
    expect(copied).toBe('REAL-MOU');
    expect(await frame.evaluate(() => window.programCopies || [])).toEqual([]);
    await frame.locator('#history-program').click(); await expect(frame.locator('#history-state')).toContainText('原生方式');
    await frame.locator('.xterm-screen').evaluate(el => {
      const box = el.getBoundingClientRect();
      for (const deltaY of [-120, -120, 120]) el.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: box.x + 10, clientY: box.y + 10, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => JSON.parse(await readFile(proof, 'utf8'))).toEqual({ copies: 0, wheels: 3, pages: 0 });
    expect((await run(['display-message', '-p', '-t', 'codex', '#{pane_id}:#{pane_pid}'])).stdout.trim()).toBe(token);
    expect(app.inputCalls).toEqual([]);
  } finally {
    await app?.close(); for (const child of children) child.kill('SIGTERM');
    await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
