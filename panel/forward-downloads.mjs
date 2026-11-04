import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FORWARD_CLIENTS } from './public/forward-platform.js';

export const FORWARD_FILES = Object.freeze(Object.fromEntries(Object.entries(FORWARD_CLIENTS).map(([arch, item]) => [arch, item.name])));
const MAX_FILE = 32 * 1024 * 1024;
export function createForwardDownloads(directory) {
  let active = 0;
  async function list() {
    if (!directory) return [];
    let fd;
    try {
      fd = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await fd.stat(); if (!stat.isFile() || stat.size > 4096) return [];
      const manifest = JSON.parse(await fd.readFile('utf8'));
      if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > Object.keys(FORWARD_FILES).length || new Set(manifest.files.map(item => item?.arch)).size !== manifest.files.length) return [];
      return manifest.files.filter(item => Object.hasOwn(FORWARD_FILES, item.arch) && item.name === FORWARD_FILES[item.arch] &&
        Number.isInteger(item.size) && item.size > 0 && item.size <= MAX_FILE && /^[a-f0-9]{64}$/.test(item.sha256) &&
        typeof item.build === 'string' && /^[a-zA-Z0-9.+-]{1,64}$/.test(item.build))
        .map(({ arch, name, size, sha256, build }) => ({ arch, name, size, sha256, build, href: '/api/forward/download/' + arch }));
    } catch { return []; }
    finally { await fd?.close(); }
  }
  async function serve(arch, res) {
    if (active >= 2) throw Object.assign(new Error('助手下载繁忙，请稍后重试'), { status: 429 });
    active++; let fd;
    try {
      const item = (await list()).find(item => item.arch === arch);
      if (!item) throw Object.assign(new Error('助手尚未构建或下载项不存在'), { status: 404 });
      fd = await open(join(directory, FORWARD_FILES[arch]), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size !== item.size || stat.size > MAX_FILE) throw new Error('Invalid helper binary');
      res.writeHead(200, { 'content-type': FORWARD_CLIENTS[arch].format === 'zip' ? 'application/zip' : 'application/octet-stream', 'content-length': stat.size, 'content-disposition': 'attachment; filename="' + item.name + '"', 'cache-control': 'no-store' });
      const stream = fd.createReadStream({ start: 0, end: stat.size - 1 }); fd = null; await pipeline(stream, res);
    } finally { await fd?.close(); active--; }
  }
  return { list, serve };
}
