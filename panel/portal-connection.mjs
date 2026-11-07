import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { portalRead, portalWrite } from '../scripts/portal-files.mjs';
import { parseNodeDirectory, nodeOrigin, decodePortalCode, readNodeDirectoryResponse } from './public/node-directory.js';
export const directoryToken = connection => createHash('sha256').update('directory-v1\0' + connection.nodeSecret + '\0' + connection.portalOrigin).digest('hex');
async function readConnectionFile(path) {
  try {
    const value = JSON.parse(await portalRead(path, 2048, true));
    if (value.version !== 1 || !/^[a-z][a-z0-9-]{0,31}$/.test(value.nodeId || '') || !/^[a-f0-9]{64}$/.test(value.nodeSecret || '') || typeof value.name !== 'string' || value.name.length > 48 || !Number.isSafeInteger(value.registeredAt) || value.registeredAt < 0) throw Error('门户配置损坏');
    return { ...value, portalOrigin: nodeOrigin(value.portalOrigin) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export const readPortalConnection = config => readConnectionFile(join(config.dataDir, 'portal.json'));
export function createPortalConnection(config) {
  let busy = false;
  const publicState = value => ({ configured: !!value?.registeredAt, portalOrigin: value?.portalOrigin || '', name: value?.name || new URL(config.origin).hostname, publicOrigin: config.origin, nodeId: value?.nodeId || '', registeredAt: value?.registeredAt || null });
  return {
    async status() { return publicState(await readPortalConnection(config)); },
    get busy() { return busy; },
    async register(body) {
      if (busy) throw Object.assign(Error('门户接入正在处理，请稍后再试'), { status: 409 });
      busy = true;
      try {
        let connection = await readPortalConnection(config), authorizationCode = '';
        const pendingPath = join(config.dataDir, 'portal-pending.json');
        if (body.authorizationCode) {
          let code; try { code = decodePortalCode(body.authorizationCode); } catch (error) { throw Object.assign(error, { status: 400 }); } authorizationCode = code.key;
          if (connection?.portalOrigin !== code.origin) { const pending = await readConnectionFile(pendingPath); connection = pending?.portalOrigin === code.origin ? pending : { version: 1, portalOrigin: code.origin, nodeId: 'node-' + randomBytes(8).toString('hex'), nodeSecret: randomBytes(32).toString('hex'), registeredAt: 0 }; }
        }
        if (!connection) throw Object.assign(Error('请先填写门户授权码'), { status: 400 });
        let node; try { node = parseNodeDirectory({ version: 1, portalOrigin: connection.portalOrigin, nodes: [{ id: connection.nodeId, name: body.name, origin: config.origin, mode: config.mode === 'terminal' ? 'terminal' : 'desktop' }] }).nodes[0]; } catch (error) { throw Object.assign(error, { status: 400 }); }
        connection.name = node.name;
        // Persist the per-node identity before networking. A manual retry after
        // a lost response reuses this identity and cannot create a duplicate.
        await portalWrite(pendingPath, JSON.stringify(connection) + '\n');
        const response = await (config.portalFetch || fetch)(connection.portalOrigin + '/api/register', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', origin: connection.portalOrigin }, body: JSON.stringify({ authorizationCode, nodeSecret: connection.nodeSecret, node }) });
        const result = await readNodeDirectoryResponse(response);
        if (!response.ok) throw Object.assign(Error(result.error || '门户拒绝注册'), { status: response.status === 401 ? 400 : response.status >= 400 && response.status < 500 ? response.status : 503 });
        if (result.ok !== true || !/^[a-z][a-z0-9-]{0,31}$/.test(result.nodeId || '') || result.origin !== config.origin || typeof result.enabled !== 'boolean') throw Error('门户注册响应无效');
        connection.nodeId = result.nodeId; connection.registeredAt = Date.now(); await portalWrite(join(config.dataDir, 'portal.json'), JSON.stringify(connection) + '\n'); await unlink(pendingPath).catch(() => {});
        return { ...publicState(connection), enabled: result.enabled };
      } catch (error) {
        if (error.status) throw error;
        throw Object.assign(Error('门户接入未完成或结果未知，请检查后手动重试；当前服务器仍可独立使用'), { status: 503 });
      } finally { busy = false; }
    },
  };
}
