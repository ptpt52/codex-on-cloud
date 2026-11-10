import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FORWARD_CLIENTS } from './public/forward-platform.js';
import { FORWARD_FILES, ARTIFACT_LIMITS, artifactSnapshot } from '../native/forward-artifacts.mjs';

export { FORWARD_FILES };
export function createForwardDownloads(directory, { server } = {}) {
  const entry = () => { const value = typeof server === 'function' ? server() : server; return { server: value, base: value ? new URL(value).pathname : '/' }; };
  function matching(snapshot) {
    // Root publications made before server metadata remain usable. Node paths
    // require a helper compiled for this exact entry, including its prefix.
    const { server: expected, base } = entry();
    if (expected && (snapshot.server ? snapshot.server !== expected : base !== '/')) throw Object.assign(Error('助手入口已变化，请重新构建并下载'), { status: 409 });
    return snapshot;
  }
  let active = 0;
  async function list() {
    if (!directory) return [];
    try {
      const { files, generation } = matching(await artifactSnapshot(directory));
      const { base } = entry();
      return files.map(({ arch, name, size, sha256, build }) => ({ arch, name, size, sha256, build,
        href: (base === '/' ? '' : base.slice(0, -1)) + '/api/forward/download/' + arch + (generation ? '?generation=' + generation : '') }));
    } catch { return []; }
  }
  async function serve(arch, res, generation) {
    if (active >= 2) throw Object.assign(new Error('助手下载繁忙，请稍后重试'), { status: 429 });
    active++; let fd;
    try {
      let snapshot;
      try { snapshot = matching(await artifactSnapshot(directory, generation)); }
      catch (error) { if (error.status) throw error; throw Object.assign(Error(generation ? '助手版本已更新，请刷新列表重新下载' : '助手尚未构建或下载项不存在'), { status: generation ? 410 : 404 }); }
      const item = snapshot.files.find(item => item.arch === arch);
      if (!item) throw Object.assign(new Error('助手尚未构建或下载项不存在'), { status: 404 });
      try { fd = await open(join(snapshot.location, FORWARD_FILES[arch]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (snapshot.generation && error.code === 'ENOENT') throw Object.assign(Error('助手版本已更新，请刷新列表重新下载'), { status: 410 });
        throw error;
      }
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size !== item.size || stat.size > ARTIFACT_LIMITS.file) throw new Error('Invalid helper binary');
      res.writeHead(200, { 'content-type': FORWARD_CLIENTS[arch].format === 'zip' ? 'application/zip' : 'application/octet-stream', 'content-length': stat.size, 'content-disposition': 'attachment; filename="' + item.name + '"', 'cache-control': 'no-store' });
      const stream = fd.createReadStream({ start: 0, end: stat.size - 1 }); fd = null; await pipeline(stream, res);
    } finally { await fd?.close(); active--; }
  }
  return { list, serve };
}
