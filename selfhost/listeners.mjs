import { join } from 'node:path';
import { readStateFile } from '../scripts/state-files.mjs';

export function centerListenerConfig(env) {
  const port = (text, label) => {
    if (typeof text !== 'string' || !/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw Error(label + '无效');
    return Number(text);
  };
  const publicPort = port(env.SELFHOST_CENTER_PORT ?? '36180', '中心公共端口');
  const internalPort = env.SELFHOST_INTERNAL_PORT === undefined ? undefined : port(env.SELFHOST_INTERNAL_PORT, '中心内部端口');
  if (internalPort === publicPort) throw Error('中心内部端口不能与公共端口相同');
  return { port: publicPort, internalPort };
}

// Start the private callback listener first. A failed bind must not leave a
// public health page alive for a center whose node callbacks cannot operate.
export async function listenCenter(center, { port, internalPort }) {
  const listen = (server, value) => new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(value, '127.0.0.1');
  });
  try {
    if (center.internalServer) await listen(center.internalServer, internalPort);
    await listen(center.server, port);
  } catch (error) { await center.close(); throw error; }
}

export async function checkCenterRollbackListeners(previous, env) {
  if (centerListenerConfig(env).internalPort === undefined) return;
  // This packaged module is the v1 contract for the optional internal port.
  // Older applications ignore the new environment key; swapping only their
  // app directory would leave Caddy/frps pointing at an absent listener.
  try { await readStateFile(join(previous, 'selfhost', 'listeners.mjs'), 16384); }
  catch { throw Error('上一版应用不支持独立内部监听，未切换应用；请使用目标版本源码重新执行完整中心 install，配套恢复 server.env、Caddyfile 和 frps.toml'); }
}
