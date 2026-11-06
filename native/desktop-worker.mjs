import { readFile, mkdir, lstat, chmod, unlink } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from './config.mjs';
import { desktopEnvironment } from './desktop-controls.mjs';
import { createDesktopActions, createDesktopActionServer } from './desktop-actions.mjs';

export async function startDesktopWorker(config, secret) {
  await mkdir(config.runtime, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.runtime);
  if (!directory.isDirectory() || directory.uid !== process.getuid()) throw Error('桌面运行目录无效');
  await chmod(config.runtime, 0o700);
  const socket = config.desktopActionsSocket;
  try {
    const old = await lstat(socket);
    if (!old.isSocket() || old.uid !== process.getuid()) throw Error('桌面执行 socket 无效');
    const active = await new Promise(resolve => { const probe = net.createConnection(socket); probe.setTimeout(500);
      probe.once('connect', () => { probe.destroy(); resolve(true); }); probe.once('timeout', () => { probe.destroy(); resolve(true); }); probe.once('error', error => resolve(!['ENOENT', 'ECONNREFUSED'].includes(error.code))); });
    if (active) throw Error('桌面执行服务已运行'); await unlink(socket);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const actions = createDesktopActions(config, { ...desktopEnvironment(config), CODEX_CLOUD_ATTACH_ONLY: '1' });
  const server = createDesktopActionServer(secret, actions);
  await new Promise((resolve, fail) => { server.once('error', fail); server.listen(socket, resolve); }); await chmod(socket, 0o600);
  return { server, async close() { actions.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; }); } };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  if (process.getuid() === 0) throw Error('请以普通用户运行桌面执行服务');
  const config = settings(), secret = (await readFile(join(config.root, 'secrets', 'agent_secret'), 'utf8')).trim();
  if (secret.length < 16 || secret.length > 512) throw Error('桌面执行密钥无效');
  const worker = await startDesktopWorker(config, secret); let stopping = false;
  console.log('独立桌面执行服务已启动');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { if (stopping) return; stopping = true; await worker.close(); });
}
