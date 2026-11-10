import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayOrigin, gatewayHex, gatewaySecret } from '../gateway/protocol.mjs';

export function validateGatewayConnection(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'origin', 'backendOrigin', 'nodeId', 'name', 'secret', 'registeredAt'].includes(key)) || !gatewayHex(value.nodeId) || !gatewaySecret(value.secret) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 48 || /[\u0000-\u001f\u007f]/.test(value.name) || !Number.isSafeInteger(value.registeredAt) || value.registeredAt < 0) throw Error('节点网关配置无效');
  const origin = gatewayOrigin(value.origin), backendOrigin = gatewayOrigin(value.backendOrigin);
  if (origin === backendOrigin) throw Error('节点后端地址不能与网关相同');
  return { ...value, origin, backendOrigin };
}
export function readGatewayConnection(root) {
  let file;
  try {
    file = openSync(join(root, 'data/gateway-node.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 4096) throw Error('节点网关配置必须是当前用户的私有文件，且最多 4 KiB');
    const bytes = Buffer.alloc(4097), count = readSync(file, bytes, 0, bytes.length, 0);
    if (count !== info.size || count > 4096) throw Error('节点网关配置超过限制或正在修改');
    let value; try { value = JSON.parse(bytes.subarray(0, count)); } catch { throw Error('节点网关配置格式无效'); }
    return validateGatewayConnection(value);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (file !== undefined) closeSync(file); }
}
