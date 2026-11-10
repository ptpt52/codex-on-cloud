import { parseEnv } from 'node:util';
import { join, resolve } from 'node:path';
import { settings, root as projectRoot } from '../native/config.mjs';
import { portalRead } from './portal-files.mjs';
import { createCloudflarePublication } from './cloudflare-publication.mjs';

export function cloudflareTokenFile(explicit, { root = projectRoot, fallback } = {}) {
  return resolve(explicit || fallback || join(root, 'secrets', 'cf_token'));
}

export async function cloudflareAPI(tokenFile, { request = fetch, privateFile = false } = {}) {
  const token = (await portalRead(tokenFile, 4096, privateFile)).trim();
  if (!token || /[\s\0]/.test(token)) throw Error('API token文件需为单行token');
  async function api(path, method = 'GET', body) {
    const response = await request('https://api.cloudflare.com/client/v4' + path, { method, redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 262144) throw Error('Cloudflare响应超过256KiB'); chunks.push(chunk); }
    let result; try { result = JSON.parse(Buffer.concat(chunks)); } catch { throw Error(`Cloudflare响应无效，HTTP ${response.status}`); }
    if (!response.ok || !result.success) throw Object.assign(Error(`Cloudflare ${method}失败：HTTP ${response.status}，错误码 ${(result.errors || []).map(error => error.code).filter(code => /^\d+$/.test(String(code))).join(',')}`), { status: response.status });
    return result.result;
  }
  return api;
}
export async function publicationClient(values, { root = projectRoot, deploymentLease, operationId, request = fetch } = {}) {
  const api = await cloudflareAPI(cloudflareTokenFile(values['api-token-file'], { root }), { request, privateFile: true });
  const env = parseEnv(await portalRead(join(root, '.env'), 65536, true));
  if (env.SHARED_ENTRY === '1' && (values.rename || values.domain !== new URL(env.PUBLIC_ORIGIN).hostname)) throw Error('共享入口节点不能通过普通发布改名，请使用 native:activate 管理固定入口');
  const config = settings({ ...env, ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}) });
  return createCloudflarePublication({ root, socketPath: config.tunnelSocket, api, deploymentLease, operationId });
}
