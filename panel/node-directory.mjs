import { readPortalConnection, directoryToken } from './portal-connection.mjs';
import { parseNodeDirectory, readNodeDirectoryResponse } from './public/node-directory.js';
export function createNodeDirectoryReader(config) {
  let pending;
  return () => pending ||= (async () => {
    let directory;
    try {
      const connection = await readPortalConnection(config);
      if (!connection?.registeredAt) return { enabled: false };
      const response = await (config.portalFetch || fetch)(connection.portalOrigin + '/api/directory', { headers: { authorization: 'Bearer ' + directoryToken(connection) }, redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('portal unavailable');
      directory = parseNodeDirectory(await readNodeDirectoryResponse(response));
      if (directory.portalOrigin !== connection.portalOrigin) throw Error('invalid origin');
    } catch (error) { throw Error('统一门户目录暂不可用，当前服务器仍可独立使用', { cause: error }); }
    const current = directory.nodes.find(node => node.origin === config.origin);
    return { ...directory, enabled: true, currentId: current?.id || null };
  })().finally(() => { pending = undefined; });
}
