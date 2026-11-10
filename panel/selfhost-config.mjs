import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

const SLUG = /^[a-z0-9-]{1,48}$/, NODE_ID = /^[a-f0-9]{32}$/, CREDENTIAL = /^cocn_[A-Za-z0-9_-]{43}$/;

export function readSelfhostNode(root, env = process.env) {
  if (!env.SELFHOST_NODE_CONFIG_FILE) return null;
  const file = resolve(root, env.SELFHOST_NODE_CONFIG_FILE);
  let handle;
  try {
    handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(handle);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 16384) throw Error('自建节点配置必须是当前用户的私有文件，且最多 16 KiB');
    const bytes = Buffer.alloc(16385), count = readSync(handle, bytes, 0, bytes.length, 0);
    if (count !== info.size || count > 16384) throw Error('自建节点配置超过限制或正在修改');
    const value = JSON.parse(bytes.subarray(0, count));
    if (!value || value.version !== 1 || !NODE_ID.test(value.nodeId) || !CREDENTIAL.test(value.credential) || typeof value.slug !== 'string' || !SLUG.test(value.slug) || typeof value.origin !== 'string' || value.path !== '/node/' + value.slug + '/' || typeof value.turnEndpoint !== 'string' && value.turnEndpoint !== null) throw Error('自建节点配置身份无效');
    const origin = new URL(value.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.origin) throw Error('自建节点中心地址无效');
    if (value.turnEndpoint !== null && value.turnEndpoint !== value.origin + '/api/turn-credentials') throw Error('TURN 地址必须属于接入中心');
    return { origin: value.origin, slug: value.slug, nodeId: value.nodeId, credential: value.credential, path: value.path, turnEndpoint: value.turnEndpoint };
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('SELFHOST_NODE_CONFIG_FILE 指向的文件不存在');
    throw Error('自建节点配置无法读取：' + error.message, { cause: error });
  } finally { if (handle !== undefined) closeSync(handle); }
}
