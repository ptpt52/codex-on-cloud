import http from 'node:http';
import net from 'node:net';
import { dirname } from 'node:path';
import { lstat, chmod, unlink } from 'node:fs/promises';

// Local maintenance protocol. Never exposed on the panel TCP port or Tunnel.
export async function requestUIReload(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('没有找到当前用户的热更新接口；旧版面板需先正常重启一次');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path, path: '/reload-ui', method: 'POST', headers: { 'content-length': '0', connection: 'close' } }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 2048) { req.destroy(); reject(Error('热更新响应超过限制')); } else chunks.push(chunk); });
      res.on('error', reject);
      res.once('end', () => {
        try { const data = JSON.parse(Buffer.concat(chunks)); if (res.statusCode !== 200 || !/^[a-f0-9]{24}$/.test(data.revision)) throw Error(data.error || '界面更新失败，原版本保持不变'); resolve(data); }
        catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(Error('热更新结果未知，请检查面板日志；没有自动重试')), 130000);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end();
  });
}
export async function serveUIReload(path, reload) {
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw Error('维护接口必须位于当前部署用户的私有目录');
  const previous = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid()) throw Error('前端维护接口路径被占用');
    await new Promise((resolve, reject) => {
      const probe = net.createConnection(path); const timer = setTimeout(() => probe.destroy(Error('无法确认旧维护接口状态')), 1000);
      probe.once('connect', () => { probe.destroy(); reject(Error('已有面板维护接口在运行')); });
      probe.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      probe.once('close', () => clearTimeout(timer));
    });
    const current = await lstat(path); if (current.ino !== previous.ino || current.dev !== previous.dev) throw Error('维护接口发生变化');
    await unlink(path);
  }
  let busy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/reload-ui' || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) { res.writeHead(400); return res.end('{"error":"无效维护请求"}'); }
    if (busy) { res.writeHead(409); return res.end('{"error":"已有界面更新正在执行"}'); }
    busy = true;
    try { const result = await reload(); res.end(JSON.stringify(result)); }
    catch { res.writeHead(409); res.end('{"error":"资源校验失败，原版本保持不变；请检查完整性、语法和大小限制"}'); }
    finally { busy = false; }
  });
  server.maxConnections = 4; server.maxHeadersCount = 8; server.headersTimeout = 3000; server.requestTimeout = 5000; server.maxRequestsPerSocket = 1;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  try { await chmod(path, 0o600); } catch (error) { server.close(); await unlink(path).catch(() => {}); throw error; }
  const info = await lstat(path);
  return async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    const current = await lstat(path).catch(() => null);
    if (current?.ino === info.ino && current.dev === info.dev) await unlink(path).catch(() => {});
  };
}
