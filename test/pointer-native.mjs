import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, lstat, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { chromium } from '@playwright/test';
import { fixture } from './fixture.mjs';

// Real X input on a private, disposable display. The manager is fixture-backed;
// no physical display, live tmux pane, Codex task or production login is used.
const directory = await mkdtemp(join(tmpdir(), 'codex-pointer-native-'));
const env = { ...process.env, XAUTHORITY: join(directory, 'Xauthority'),
  XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'share'),
  PATH: `${resolve('data/host-tools/usr/bin')}:${process.env.PATH}` };
delete env.DBUS_SESSION_BUS_ADDRESS;
delete env.SESSION_MANAGER;
const children = [], runFile = promisify(execFile);
const run = async (command, args) => (await runFile(command, args, { env, timeout: 3000, maxBuffer: 16384 })).stdout.trim();
function start(command, args, stdio = 'ignore') { const child = spawn(command, args, { env, stdio }); children.push(child); return child; }
async function eventually(probe) {
  for (let count = 0; count < 100; count++) { try { if (await probe()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Isolated X input check timed out');
}
let server, browser, app;
try {
  for (let number = 94; number < 200; number++) {
    const occupied = await Promise.all([`/tmp/.X${number}-lock`, `/tmp/.X11-unix/X${number}`].map(path => lstat(path).then(() => true, () => false)));
    if (!occupied.some(Boolean)) { env.DISPLAY = `:${number}`; break; }
  }
  assert.ok(env.DISPLAY);
  await writeFile(env.XAUTHORITY, '', { mode: 0o600 });
  await run('xauth', ['-f', env.XAUTHORITY, 'add', env.DISPLAY, '.', randomBytes(16).toString('hex')]);
  start('Xvfb', [env.DISPLAY, '-screen', '0', '1600x3200x24', '-nolisten', 'tcp', '-auth', env.XAUTHORITY, '-noreset']);
  await eventually(async () => (await run('xdotool', ['getdisplaygeometry'])) === '1600 3200');
  let events = '', vncConnections = 0;
  const observer = start('xev', ['-name', 'codex-pointer-native-check', '-geometry', '1600x3200+0+0', '-event', 'button', '-event', 'keyboard'], ['ignore', 'pipe', 'ignore']);
  observer.stdout.on('data', bytes => { events = (events + bytes.toString()).slice(-65536); });
  await eventually(async () => /^\d+$/.test(await run('xdotool', ['search', '--name', '^codex-pointer-native-check$'])));
  const socketPath = join(directory, 'vnc.sock');
  server = net.createServer(socket => {
    vncConnections++;
    socket.pause(); socket.on('error', () => {});
    start('x11vnc', ['-norc', '-inetd', '-display', env.DISPLAY, '-auth', env.XAUTHORITY, '-no6', '-noipv6', '-rfbport', '0', '-nopw', '-noremote', '-nolookup', '-noxrecord', '-quiet'], [socket, socket, 'ignore']);
    socket.destroy();
  });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  app = await fixture({ rfb: true, webrtc: true, fastConnect: true, seamless: true }); app.config.vncSocket = socketPath;
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => { window.nativePeers = []; const Native = RTCPeerConnection; window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.nativePeers.push(this); } }; });
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('桌面在线'));
  const frame = page.frameLocator('#desktop-frame');
  await frame.locator('#screen canvas').waitFor();
  await frame.locator('#screen canvas').evaluate(el => { window.originalNativeCanvas = el; });
  await page.locator('#connection-button').click(); await page.waitForFunction(() => document.querySelector('#diag-transport').textContent.includes('WebRTC')); await page.locator('#close-connection').click();
  assert.equal(vncConnections, 1);
  await page.locator('#toggle-controls-button').click(); await page.locator('#pointer-mode').selectOption('trackpad'); await page.locator('#close-controls-button').click();
  await frame.locator('#pointer-left').waitFor();
  const bounds = await page.locator('#desktop-stage').boundingBox(), x = Math.round(bounds.x + bounds.width * 0.4), y = Math.round(bounds.y + bounds.height * 0.45);
  const client = await context.newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let step = 1; step <= 5; step++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + step * 8, y: y - step * 4, id: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await eventually(async () => Number((await run('xdotool', ['getmouselocation', '--shell'])).match(/^X=(\d+)/m)?.[1]) > 900);
  assert.equal(events.includes('ButtonPress'), false, 'A relative move must not click');
  await frame.locator('#pointer-left').click();
  await eventually(() => /ButtonPress[\s\S]*button 1/.test(events) && /ButtonRelease[\s\S]*button 1/.test(events));
  await frame.locator('#pointer-right').click();
  await eventually(() => /ButtonPress[\s\S]*button 3/.test(events) && /ButtonRelease[\s\S]*button 3/.test(events));
  await frame.locator('#pointer-drag').click();
  assert.equal(await frame.locator('#pointer-drag').getAttribute('aria-pressed'), 'true');
  const releases = (events.match(/ButtonRelease/g) || []).length;
  await page.locator('#toggle-controls-button').click();
  await eventually(() => (events.match(/ButtonRelease/g) || []).length > releases);
  await page.locator('#close-controls-button').click();
  assert.equal(await frame.locator('#pointer-drag').getAttribute('aria-pressed'), 'false');
  await frame.locator('#screen canvas').click({ position: { x: 50, y: 50 } });
  await page.keyboard.down('Shift');
  await eventually(() => /KeyPress[\s\S]*Shift_L/.test(events));
  await frame.locator('#pointer-drag').click();
  const beforeFallback = (events.match(/ButtonRelease/g) || []).length;
  await frame.locator('body').evaluate(() => window.nativePeers.at(-1).close());
  await page.locator('#connection-button').click(); await page.waitForFunction(() => document.querySelector('#diag-transport').textContent.includes('中转')); await page.locator('#close-connection').click();
  await eventually(() => (events.match(/ButtonRelease/g) || []).length > beforeFallback && /KeyRelease[\s\S]*Shift_L/.test(events));
  await page.keyboard.up('Shift');
  assert.equal(vncConnections, 1, 'fallback must retain the original real x11vnc connection');
  assert.equal(await frame.locator('#screen canvas').evaluate(el => el === window.originalNativeCanvas), true);
  assert.equal(await frame.locator('#pointer-drag').getAttribute('aria-pressed'), 'false');
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({ path: resolve('test-results/desktop-pointer-native.png') });
  assert.equal(app.inputCalls.length, 0);
  console.log('PASS: real Xvfb + x11vnc + noVNC + UDP/DTLS: one VNC connection and canvas survive relay/direct/fallback; native movement, left/right buttons, held key and drag release passed. Management is fixture-backed; no production input.');
  await client.detach();
} finally {
  await browser?.close(); await app?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit').catch(() => {}) : undefined));
  await rm(directory, { recursive: true, force: true });
}
