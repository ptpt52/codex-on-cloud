// Opt-in integration check against the real local services, never used by npm test.
// Requires an idle bash pane. Sends benign printf/sleep commands and restarts only the panel.
import assert from 'node:assert/strict';
import { readFile, access, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { settings } from '../native/config.mjs';

const config = settings();
const origin = config.env.PUBLIC_ORIGIN || 'http://localhost:36080';
if (new URL(origin).protocol !== 'http:' && !process.argv.includes('--public')) throw new Error('公网 HTTPS 验收需要显式添加 --public；已启用 Cloudflare Access 时请用手机手动验证');
function tmux(format) {
  const result = spawnSync('tmux', ['-S', join(config.runtime, 'tmux.sock'), 'display-message', '-p', '-t', 'codex:0.0', format], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('独立 tmux 会话尚未就绪');
  return result.stdout.trim();
}
assert.equal(tmux('#{pane_current_command}'), 'bash', '请先结束 Codex 或其他前台任务；测试只操作空闲 bash');
const pane = tmux('#{pane_pid}');
const name = `native-smoke-${randomBytes(6).toString('hex')}.txt`;
const file = join(config.transfer, name);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const errors = [];
let context;
async function connect(mobile = false) {
  context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('密码', { exact: true }).fill((await readFile(join(config.root, 'secrets', 'panel_password'), 'utf8')).trim());
  await page.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toHaveJSProperty('width', Number(config.size.split('x')[0]), { timeout: 30000 });
  await page.frameLocator('#desktop-frame').locator('#status').waitFor({ state: 'hidden', timeout: 30000 });
  assert.deepEqual(await page.frameLocator('#desktop-frame').locator('#screen canvas').evaluate(canvas => [canvas.width, canvas.height]), config.size.split('x').map(Number));
  return page;
}
async function eventually(probe) {
  for (let i = 0; i < 150; i++) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('实机操作等待超时');
}
try {
  let page = await connect();
  await page.getByRole('button', { name: '打开终端', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 350));
  await page.getByLabel('要粘贴到桌面的文字').fill(`printf '%s\\n' '中文原生验证' > "$TRANSFER_DIR/${name}"`);
  await page.getByRole('button', { name: '粘贴文字' }).click();
  await expect(page.getByRole('button', { name: '粘贴文字' })).toBeEnabled({ timeout: 30000 });
  await page.getByRole('status').filter({ hasText: '已粘贴' }).waitFor();
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(access(file), { code: 'ENOENT' });
  await page.getByRole('button', { name: 'Enter ↵' }).click();
  await eventually(async () => { try { return (await readFile(file, 'utf8')) === '中文原生验证\n'; } catch { return false; } });
  console.log('✓ 真实 noVNC / Unix socket / X11 连接，中文粘贴不自动执行，独立 Enter 正常');
  await mkdir(join(config.root, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(config.root, 'test-results', 'native-desktop.png'), fullPage: true });
  await page.getByLabel('要粘贴到桌面的文字').fill(`sleep 2; printf '%s\\n' '断线后完成' > "$TRANSFER_DIR/${name}"`);
  await page.getByRole('button', { name: '粘贴文字' }).click();
  await expect(page.getByRole('button', { name: '粘贴文字' })).toBeEnabled({ timeout: 30000 });
  await page.getByRole('button', { name: 'Enter ↵' }).click();
  await context.close();
  await eventually(async () => (await readFile(file, 'utf8')) === '断线后完成\n');
  assert.equal(tmux('#{pane_pid}'), pane);
  console.log('✓ 浏览器断开后任务完成，tmux shell PID 保持不变');
  page = await connect(true);
  await page.screenshot({ path: join(config.root, 'test-results', 'native-mobile.png'), fullPage: true });
  const restarted = spawnSync('systemctl', ['--user', 'restart', 'codex-cloud-panel.service']);
  assert.equal(restarted.status, 0);
  await eventually(async () => { try { return (await fetch(origin + '/healthz')).ok; } catch { return false; } });
  await page.reload();
  await expect(page.frameLocator('#desktop-frame').locator('#screen canvas')).toHaveJSProperty('width', Number(config.size.split('x')[0]), { timeout: 30000 });
  // Session survives restart; ownership is deliberately claimed by the reloaded page.
  await page.frameLocator('#desktop-frame').locator('#status').waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(tmux('#{pane_pid}'), pane);
  assert.equal((await page.request.get(origin + '/api/me')).status(), 200);
  console.log('✓ 手机尺寸连接、面板重启、登录保留；桌面任务进程不变');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await rm(file, { force: true });
}
