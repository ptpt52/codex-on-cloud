import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portalRead } from './portal-files.mjs';
import { readNodeDirectoryResponse } from '../panel/public/node-directory.js';

const validSubdomain = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
export async function preparePortalAccount({ accountId, apiTokenFile, subdomain, request = fetch }) {
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId) || typeof apiTokenFile !== 'string') throw Error('请指定 --account-id 和 --api-token-file');
  if (subdomain !== undefined && !validSubdomain(subdomain)) throw Error('--subdomain 必须是有效的小写 DNS 标签');
  const token = (await portalRead(resolve(apiTokenFile), 512, true)).trim();
  if (token.length < 16 || /[\s\0]/.test(token)) throw Error('API Token 文件格式无效');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  const call = async (method, body) => {
    let response, value;
    try {
      response = await request(endpoint, { method, redirect: 'error', signal: AbortSignal.timeout(25000), headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      value = await readNodeDirectoryResponse(response, 65536);
    } catch { throw Error(method === 'GET' ? '读取 Workers 初始化状态失败，请检查网络后重试' : 'Workers 初始化结果未知，请先重新查询；不会自动重试'); }
    return { response, value };
  };
  const failed = ({ response, value }) => Error(`Cloudflare Workers 初始化失败：HTTP ${response.status}，错误码 ${(value.errors || []).map(error => Number.isInteger(error.code) ? error.code : '未知').join(',')}；请检查令牌权限与账户范围`);
  const existing = await call('GET');
  if (existing.response.ok && existing.value.success === true) {
    if (!validSubdomain(existing.value.result?.subdomain)) throw Error('Cloudflare 返回了无效的 Workers 子域名');
    return { created: false, subdomain: existing.value.result.subdomain };
  }
  if (existing.response.status !== 404 || !existing.value.errors?.some(error => error.code === 10007)) throw failed(existing);
  if (!subdomain) throw Error('此账户尚未初始化 Workers；请显式指定 --subdomain，或在 Cloudflare 控制台打开 Workers & Pages');
  const created = await call('PUT', { subdomain });
  if (!created.response.ok || created.value.success !== true) throw failed(created);
  if (created.value.result?.subdomain !== subdomain) throw Error('Workers 初始化响应与请求不符，请先查询账户状态');
  return { created: true, subdomain };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'account-id': { type: 'string' }, 'api-token-file': { type: 'string' }, subdomain: { type: 'string' } } });
    const result = await preparePortalAccount({ accountId: values['account-id'] || process.env.CLOUDFLARE_ACCOUNT_ID, apiTokenFile: values['api-token-file'], subdomain: values.subdomain });
    console.log(`${result.created ? '已初始化' : '保留现有'} Workers 子域名：${result.subdomain}.workers.dev\n此操作不发布 Worker；门户仍按构建配置关闭 workers.dev 和预览入口。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
