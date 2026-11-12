// Isolated X11/noVNC text input. No physical display, user's tmux or Codex task.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { chromium } from '@playwright/test';
import { fixture } from './fixture.mjs';
import { vncArguments } from '../native/vnc.mjs';
import { executeInput, focusedInputTarget, runInputCommand } from '../native/input.mjs';

const directory = await mkdtemp(join(tmpdir(), 'codex-desktop-input-'));
const env = { ...process.env, XAUTHORITY: join(directory, 'Xauthority'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'share'),
  PATH: `${resolve('data/host-tools/usr/bin')}:${process.env.PATH}` };
delete env.DBUS_SESSION_BUS_ADDRESS; delete env.SESSION_MANAGER;
const children = [], exec = promisify(execFile);
const run = async (command, args) => (await exec(command, args, { env, timeout: 3000, maxBuffer: 16384 })).stdout.trim();
function start(command, args, stdio = 'ignore') { const child = spawn(command, args, { env, stdio }); children.push(child); return child; }
async function eventually(probe) {
  for (let i = 0; i < 160; i++) { try { if (await probe()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Isolated desktop input check timed out');
}
async function compose(frame, value) {
  await frame.locator('#desktop-input').evaluate((el, value) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.value = value; el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: value, isComposing: true, bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: value, bubbles: true }));
    const echo = new InputEvent('input', { inputType: 'insertFromComposition', data: value, bubbles: true });
    if (!echo.inputType) Object.defineProperty(echo, 'inputType', { value: 'insertFromComposition' });
    el.value = value; el.dispatchEvent(echo);
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }, value);
}
let server, browser, app, switchedWindow, childWindow, forceFocusChange = false, forceChildFocus = false;
const direct = process.env.DESKTOP_IME_TEST_DIRECT === '1';
try {
  for (let number = 94; number < 200; number++) {
    const occupied = await Promise.all([`/tmp/.X${number}-lock`, `/tmp/.X11-unix/X${number}`].map(path => lstat(path).then(() => true, () => false)));
    if (!occupied.some(Boolean)) { env.DISPLAY = `:${number}`; break; }
  }
  assert.ok(env.DISPLAY); await writeFile(env.XAUTHORITY, '', { mode: 0o600 });
  await run('xauth', ['-f', env.XAUTHORITY, 'add', env.DISPLAY, '.', randomBytes(16).toString('hex')]);
  start('Xvfb', [env.DISPLAY, '-screen', '0', '1024x768x24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY, '-noreset']);
  await eventually(async () => await run('xdotool', ['getdisplaygeometry']) === '1024 768');
  const receiver = join(directory, 'receiver.py'), proof = join(directory, 'terminal.json');
  await writeFile(receiver, `import json, os, select, sys, time, tty
from pathlib import Path
tty.setraw(0)
proof = Path(sys.argv[1])
data = b''
deadline = time.monotonic() + 100
def save():
    temp = proof.with_suffix('.tmp')
    temp.write_text(json.dumps({'hex': data.hex()}))
    temp.replace(proof)
save()
os.write(1, b'ISOLATED IME CHECK')
while time.monotonic() < deadline:
    if select.select([0], [], [], .1)[0]:
        chunk = os.read(0, 4096)
        if not chunk: break
        data = (data + chunk)[-65536:]
        save()
`);
  const terminal = start('xterm', ['-u8', '-name', 'codex-ime-terminal', '-class', 'codex-on-cloud-terminal', '-geometry', '80x24+0+0',
    '-xrm', '*VT100.translations: #override \\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD)', '-e', 'python3', receiver, proof]);
  let terminalWindow;
  await eventually(async () => { terminalWindow = await run('xdotool', ['search', '--class', '^codex-on-cloud-terminal$']); return /^\d+$/.test(terminalWindow) && !!await readFile(proof, 'utf8'); });
  await run('xdotool', ['windowfocus', terminalWindow]);
  const socketPath = join(directory, 'vnc.sock'); let vncConnections = 0;
  server = net.createServer(socket => { vncConnections++; socket.pause(); socket.on('error', () => {}); start('x11vnc', vncArguments(env.DISPLAY, env.XAUTHORITY), [socket, socket, 'ignore']); socket.destroy(); });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  app = await fixture({ rfb: true, webrtc: direct, fastConnect: direct, seamless: direct, inputHook: body => executeInput(body, env, runInputCommand,
    async text => {
      await runInputCommand('xclip', ['-selection', 'clipboard', '-i'], { env, input: text });
      if (forceFocusChange || forceChildFocus) await run('xdotool', ['windowfocus', forceChildFocus ? childWindow : switchedWindow]);
    },
    () => focusedInputTarget(run)) });
  app.config.vncSocket = socketPath;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('桌面在线'));
  if (direct) {
    await page.locator('#connection-button').click();
    await page.waitForFunction(() => document.querySelector('#diag-transport').textContent.includes('WebRTC'));
    await page.locator('#close-connection').click();
  }
  const frame = page.frames().find(value => value.url().includes('/desktop/index.html'));
  await frame.locator('#screen canvas').click({ position: { x: 30, y: 30 } });
  await eventually(() => frame.locator('#desktop-input').evaluate(el => el === document.activeElement));
  const received = async () => Buffer.from(JSON.parse(await readFile(proof, 'utf8')).hex, 'hex').toString('utf8');
  await compose(frame, '中文直输😀');
  try { await eventually(async () => await received() === '中文直输😀'); }
  catch (error) {
    console.error(JSON.stringify({ received: await received(), calls: app.inputCalls, focus: await focusedInputTarget(run), status: await frame.locator('#desktop-input-status').textContent(), input: app.controls.status().input }));
    throw error;
  }
  await page.keyboard.type('OK'); await page.keyboard.press('Enter');
  await eventually(async () => await received() === '中文直输😀OK\r');
  await compose(frame, '再来');
  await frame.locator('#desktop-input').evaluate(el => { el.value = '，'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '，', bubbles: true })); });
  await page.keyboard.type('123 '); await compose(frame, '下一句');
  await frame.locator('#desktop-input').evaluate(el => { el.value = '。'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '。', bubbles: true })); });
  await page.keyboard.press('Enter');
  await eventually(async () => await received() === '中文直输😀OK\r再来，123 下一句。\r');
  assert.equal(terminal.exitCode, null); assert.equal(vncConnections, 1);
  console.log(`PASS (${direct ? 'resumable WebRTC' : 'WebSocket relay'}): real Xvfb/x11vnc/noVNC/xterm received exact Chinese/emoji once, no candidate Enter, followed by native ASCII and an independent Enter.`);
  if (process.env.DESKTOP_IME_TEST_TK_PYTHON) {
    const gui = join(directory, 'application.py'), appProof = join(directory, 'application.txt'), childProof = join(directory, 'child.txt'), ids = join(directory, 'widgets.json');
    await writeFile(gui, `import tkinter as tk, sys, json
from pathlib import Path
root = tk.Tk(className='CodexImeApp')
root.title('codex-ime-app')
root.geometry('500x150+0+0')
value = tk.StringVar()
field = tk.Entry(root, textvariable=value, font=('sans', 18))
field.pack(fill='both', expand=True)
second = tk.StringVar()
other = tk.Entry(root, textvariable=second)
other.pack(fill='both', expand=True)
def save(*args): Path(sys.argv[1]).write_text(value.get(), encoding='utf-8')
def save_child(*args): Path(sys.argv[2]).write_text(second.get(), encoding='utf-8')
value.trace_add('write', save)
second.trace_add('write', save_child)
save()
save_child()
root.update_idletasks()
Path(sys.argv[3]).write_text(json.dumps({'first': field.winfo_id(), 'second': other.winfo_id()}))
field.focus_force()
root.mainloop()
`);
    start(process.env.DESKTOP_IME_TEST_TK_PYTHON, [gui, appProof, childProof, ids]);
    await eventually(async () => { switchedWindow = await run('xdotool', ['search', '--name', '^codex-ime-app$']); return /^\d+$/.test(switchedWindow); });
    await run('xdotool', ['windowfocus', switchedWindow]);
    // Restore browser keyboard focus without changing the real X11 focus.
    await frame.locator('#desktop-input').focus(); await compose(frame, '普通应用中文');
    await eventually(async () => await readFile(appProof, 'utf8') === '普通应用中文');
    const widgets = JSON.parse(await readFile(ids, 'utf8')); childWindow = String(widgets.second);
    await run('xdotool', ['windowfocus', String(widgets.first)]);
    assert.equal((await focusedInputTarget(run)).window, String(widgets.first));
    forceChildFocus = true; await compose(frame, '不要进入另一输入框');
    await eventually(() => frame.locator('#desktop-input-status').evaluate(el => el.textContent.includes('未发送')));
    assert.equal(await run('xdotool', ['getwindowfocus', '-f']), childWindow);
    assert.equal(await readFile(childProof, 'utf8'), ''); assert.equal(await readFile(appProof, 'utf8'), '普通应用中文');
    forceChildFocus = false; await frame.locator('#desktop-input').focus();
    const before = await received();
    await run('xdotool', ['windowfocus', terminalWindow]); forceFocusChange = true;
    await compose(frame, '窗口变化不应误粘贴');
    await eventually(() => frame.locator('#desktop-input-status').evaluate(el => el.textContent.includes('未发送')));
    assert.equal(await received(), before); assert.equal(await readFile(appProof, 'utf8'), '普通应用中文');
    console.log('PASS: actual Tk entry received Chinese with Ctrl+V; changing the focused X11 child or application during clipboard preparation rejected the paste.');
  } else console.log('SKIP: generic GUI proof needs DESKTOP_IME_TEST_TK_PYTHON pointing to Python with Tk.');
  assert.equal(app.managementStats.restarts, 0);
  console.log('Boundary: input-method composition events are injected; native OS candidate selection and production Codex are not operated.');
} finally {
  await browser?.close(); await app?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit').catch(() => {}) : undefined));
  await rm(directory, { recursive: true, force: true });
}
