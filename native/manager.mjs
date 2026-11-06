import { readFile, mkdir, lstat, chmod, unlink } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { settings } from './config.mjs';
import { createDesktopControls } from './desktop-controls.mjs';
import { createManagerServer } from './manager-server.mjs';
import { desktopActionClient } from './desktop-actions.mjs';

const config = settings();
if (process.getuid() === 0) throw new Error('请以普通用户运行桌面管理服务');
await mkdir(config.runtime, { recursive: true, mode: 0o700 });
const directory = await lstat(config.runtime);
if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) throw new Error('本机运行目录无效');
await chmod(config.runtime, 0o700);
try {
  const old = await lstat(config.managerSocket);
  if (!old.isSocket() || old.uid !== process.getuid()) throw new Error('已有无效的管理 socket');
  const active = await new Promise(resolve => {
    const probe = net.createConnection(config.managerSocket);
    probe.setTimeout(500);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('timeout', () => { probe.destroy(); resolve(true); });
    probe.once('error', error => resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
  });
  if (active) throw new Error('管理服务已在运行');
  await unlink(config.managerSocket);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const secret = (await readFile(join(config.root, 'secrets', 'agent_secret'), 'utf8')).trim();
if (secret.length < 16 || secret.length > 512) throw new Error('管理接口密钥无效');
const controls = createDesktopControls(config, { actions: desktopActionClient(config.desktopActionsSocket, secret) });
await controls.ready;
const server = createManagerServer(secret, controls);
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.managerSocket, resolve); });
await chmod(config.managerSocket, 0o600);
console.log('本机桌面管理服务已启动');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close(async () => { await unlink(config.managerSocket).catch(() => {}); process.exit(0); });
});
