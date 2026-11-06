// Actual user-systemd restart/limit test, with real browser/HTTP and fixture
// desktop/manager. Only a uniquely named temporary test unit is killed/stopped.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { fixture } from './fixture.mjs';
import { serviceUnits } from '../native/service-units.mjs';

const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'codex-recovery-'));
const unit = `codex-cloud-test-recovery-${process.pid}.service`, unitFile = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'systemd/user', unit);
const ctl = async (...args) => (await exec('systemctl', ['--user', ...args], { timeout: 4000, maxBuffer: 8192 })).stdout;
let browser, app, release;
async function eventually(probe, attempts = 200) { for (let n = 0; n < attempts; n++) { try { if (await probe()) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw Error('test recovery deadline exceeded'); }
const state = async () => Object.fromEntries((await ctl('show', unit, '--property=MainPID,ActiveState,Result,NRestarts')).trim().split('\n').map(line => line.split('=')));
try {
  await ctl('show-environment');
  let entered; const hold = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  app = await fixture({ rfb: true, inputHook: async () => { entered(); await hold; } });
  await app.panel.close();
  await mkdir(join(root, 'panel')); await mkdir(resolve(unitFile, '..'), { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ ...app.config, port: Number(new URL(app.config.origin).port), hosts: [...app.config.hosts] }), { mode: 0o600 });
  const module = pathToFileURL(resolve('panel/server.mjs')).href;
  await writeFile(join(root, 'panel/main.mjs'), `import { readFile } from 'node:fs/promises'; import { createPanel } from ${JSON.stringify(module)};
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url))); config.hosts=new Set(config.hosts); config.serviceDiagnostics=async()=>({available:false});
const panel=await createPanel(config); panel.server.listen(config.port,config.host); process.on('SIGTERM',()=>void panel.close());\n`, { mode: 0o600 });
  const contents = serviceUnits(root, process.env.PATH).get('codex-cloud-panel.service').replace(/^After=.*\n/m, '');
  await writeFile(unitFile, contents, { flag: 'wx', mode: 0o600 });
  await ctl('daemon-reload'); await ctl('start', unit);
  await eventually(async () => (await fetch(app.config.origin + '/healthz', { signal: AbortSignal.timeout(500) })).ok);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' }); const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('codex-cloud.display.v1', JSON.stringify({ layout: 2, mode: 'desktop', controlsCollapsed: true, collapsed: true, zoom: 'width', pan: false })));
  await page.goto(app.config.origin); await page.locator('#password').fill(app.config.password); await page.locator('#login-button').click();
  await page.waitForFunction(() => document.getElementById('connection-status').textContent.includes('桌面在线'));
  await page.locator('#toggle-input-button').click(); const draft = '已接受一次，恢复不得自动重发'; await page.locator('#mobile-input').fill(draft); await page.locator('#paste-button').click(); await started;
  const first = await state(); await ctl('kill', '--signal=SIGKILL', unit);
  await eventually(async () => { const s = await state(); return s.ActiveState === 'active' && s.MainPID !== first.MainPID && s.MainPID !== '0'; });
  release();
  await page.waitForFunction(() => document.getElementById('connection-status').textContent.includes('桌面在线'), { timeout: 15000 });
  await eventually(async () => await page.locator('#mobile-input').inputValue() === draft);
  await page.waitForFunction(() => document.getElementById('input-status').textContent.includes('结果未知'));
  assert.equal(app.inputCalls.length, 1); assert.equal(app.managementStats.restarts, 0); assert.equal(app.managementStats.resumes, 0);
  await browser.close(); browser = undefined;
  // Initial start plus two recoveries exhaust the exact generated 60s budget.
  let previous = (await state()).MainPID; await ctl('kill', '--signal=SIGKILL', unit);
  await eventually(async () => { const s = await state(); return s.ActiveState === 'active' && s.MainPID !== previous && s.MainPID !== '0'; });
  await ctl('kill', '--signal=SIGKILL', unit);
  await eventually(async () => { const s = await state(); return s.ActiveState === 'failed' && s.MainPID === '0' && Number(s.NRestarts) >= 3; });
  const limited = await state(); await new Promise(r => setTimeout(r, 5500)); assert.deepEqual(await state(), limited);
  await ctl('reset-failed', unit); await ctl('start', unit); await ctl('stop', unit);
  await new Promise(r => setTimeout(r, 5500)); assert.equal((await state()).ActiveState, 'inactive');
  console.log('PASS: real systemd + Chrome + authenticated panel: SIGKILL recovers the original login and draft, accepted input stays unknown and is never replayed; 60s/3-start cap and manual-stop behavior verified. Desktop and management are fixtures; only a temporary test service was killed.');
} finally {
  release?.(); await browser?.close(); await ctl('stop', unit).catch(() => {}); await rm(unitFile, { force: true }); await ctl('daemon-reload').catch(() => {}); await ctl('reset-failed', unit).catch(() => {}); await app?.close(); await rm(root, { recursive: true, force: true });
}
