import { parseArgs } from 'node:util';
import { root, settings, environment } from '../native/config.mjs';
import { portalRead } from './portal-files.mjs';
import { createCloudflarePublication } from './cloudflare-publication.mjs';

const { values } = parseArgs({ options: {
  domain: { type: 'string' }, zone: { type: 'string' }, 'api-token-file': { type: 'string' }, rename: { type: 'boolean' },
  'prepare-only': { type: 'boolean' }, 'commit-only': { type: 'boolean' }, rollback: { type: 'boolean' },
} });
try {
  const domain = values.domain?.toLowerCase(), zone = values.zone?.toLowerCase();
  if (!domain || !zone || !domain.endsWith('.' + zone) || !/^[a-z0-9.-]+$/.test(domain) || !/^[a-z0-9.-]+$/.test(zone) || !values['api-token-file'] || ['prepare-only', 'commit-only', 'rollback'].filter(key => values[key]).length > 1) throw Error('需要 --domain、--zone、--api-token-file；发布阶段选项不能同时使用');
  if (process.getuid() === 0) throw Error('请以普通用户运行');
  const token = (await portalRead(values['api-token-file'], 4096)).trim();
  if (!token || /[\s\0]/.test(token)) throw Error('API token文件需为单行token');
  // Service units inherit the OS runtime directory, not an old task configuration.
  const config = settings(environment({ ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}) }));
  async function api(path, method = 'GET', body) {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, { method, signal: AbortSignal.timeout(25000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 262144) throw Error('Cloudflare响应超过256KiB'); chunks.push(chunk); }
    let result; try { result = JSON.parse(Buffer.concat(chunks)); } catch { throw Error(`Cloudflare响应无效，HTTP ${response.status}`); }
    if (!response.ok || !result.success) throw Object.assign(Error(`Cloudflare ${method}失败：HTTP ${response.status}，错误码 ${(result.errors || []).map(error => error.code).filter(code => /^\d+$/.test(String(code))).join(',')}`), { status: response.status });
    return result.result;
  }
  const publication = createCloudflarePublication({ root, socketPath: config.tunnelSocket, api });
  if (values.rollback) { await publication.rollback(); console.log('公网发布回退检查完成；原任务保留。'); }
  else {
    if (!values['commit-only']) await publication.prepare({ domain, zone, rename: values.rename });
    if (values['prepare-only']) console.log('公网配置已准备，远端路由和DNS未切换。加载本机服务并验证就绪后执行 --commit-only。');
    else { await publication.commit({ domain, zone }); console.log(`公网入口已验证并提交：https://${domain}`); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
