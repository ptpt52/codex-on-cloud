// Explicit provisioning command. Creates a dedicated tunnel and DNS record;
// never changes another tunnel or overwrites an unrelated hostname record.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { root, settings } from '../native/config.mjs';
import { cloudflareDomainPlan, assertManagedIngress, renamedDNSRecord } from '../native/cloudflare-domain.mjs';

const { values } = parseArgs({ options: {
  domain: { type: 'string' }, zone: { type: 'string' }, 'api-token-file': { type: 'string' }, rename: { type: 'boolean' },
} });
const domain = values.domain?.toLowerCase();
const zoneName = values.zone?.toLowerCase();
if (!domain || !zoneName || !domain.endsWith('.' + zoneName) || !/^[a-z0-9.-]+$/.test(domain) || !values['api-token-file']) {
  throw new Error('用法：npm run native:publish -- --domain desktop.example.com --zone example.com --api-token-file /path/to/api-token');
}
if (process.getuid() === 0) throw new Error('请以普通用户运行');
const token = (await readFile(values['api-token-file'], 'utf8')).trim();
if (!token || /[\s\0]/.test(token)) throw new Error('API token 文件中只能有 token 本身');
const config = settings();
async function api(path, method = 'GET', body) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method, signal: AbortSignal.timeout(25_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    const codes = (result.errors || []).map(error => error.code).join(',');
    throw new Error(`Cloudflare ${method} ${path.split('?')[0]} 失败：HTTP ${response.status}，错误码 ${codes}；检查对应资源权限`);
  }
  return result.result;
}
const stateFile = join(root, 'data', 'cloudflare-deployment.json');
await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
async function save() { await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await chmod(stateFile, 0o600); }
const zones = await api('/zones?name=' + encodeURIComponent(zoneName));
const zone = zones.find(zone => zone.name === zoneName);
if (!zone) throw new Error('当前 API token 看不到指定区域');
const account = zone.account.id;
const base = `/accounts/${account}/cfd_tunnel`;
const dnsBase = `/zones/${zone.id}/dns_records`;
state = cloudflareDomainPlan(state, { domain, accountId: account, zoneId: zone.id, rename: values.rename });
const records = await api(dnsBase + '?name=' + encodeURIComponent(domain));
if (records.length && (!state?.tunnelId || records.some(record => record.type !== 'CNAME' || record.content !== `${state.tunnelId}.cfargotunnel.com`))) {
  throw new Error('此域名已有其他 DNS 记录，不会覆盖');
}
if (!state) {
  const name = `codex-on-cloud-${domain.split('.')[0]}`;
  const tunnels = await api(base + '?is_deleted=false&name=' + encodeURIComponent(name));
  if (tunnels.some(tunnel => tunnel.name === name)) throw new Error('同名 Tunnel 已存在但没有本地部署状态，不会接管其他 Tunnel');
  const tunnel = await api(base, 'POST', { name, config_src: 'cloudflare' });
  state = { hostname: domain, accountId: account, zoneId: zone.id, tunnelId: tunnel.id };
  await save();
  console.log('已创建本项目专用 Tunnel。');
}
const current = await api(`${base}/${state.tunnelId}/configurations`);
assertManagedIngress(state, current);
const oldRecords = state.previousHostname ? await api(dnsBase + '?name=' + encodeURIComponent(state.previousHostname)) : [];
// Save the bounded pending rename before changing routing, so the same command
// can finish it after an API or local filesystem failure.
if (state.previousHostname) await save();
const tunnelToken = await api(`${base}/${state.tunnelId}/token`);
await writeFile(join(root, 'secrets', 'tunnel_token'), tunnelToken + '\n', { mode: 0o600 });
await chmod(join(root, 'secrets', 'tunnel_token'), 0o600);
await api(`${base}/${state.tunnelId}/configurations`, 'PUT', { config: { ingress: [
  { hostname: domain, service: `unix:${config.tunnelSocket}`, originRequest: {} },
  { service: 'http_status:404' },
] } });
// Prepare the authenticated origin before publishing DNS. Preserve credentials and other settings.
const envFile = join(root, '.env');
let env = await readFile(envFile, 'utf8');
try { await writeFile(join(root, 'data', '.env.before-cloudflare'), env, { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
for (const [key, value] of [['PUBLIC_ORIGIN', `https://${domain}`], ['ALLOWED_HOSTS', '']]) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  env = pattern.test(env) ? env.replace(pattern, `${key}=${value}`) : env + `\n${key}=${value}\n`;
}
await writeFile(envFile, env, { mode: 0o600 });
const credentials = join(root, 'secrets', 'credentials.txt');
await writeFile(credentials, (await readFile(credentials, 'utf8')).replace(/^工作台：.*$/m, `工作台：https://${domain}`), { mode: 0o600 });
const desired = { type: 'CNAME', name: domain, content: `${state.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 };
const record = records.length ? await api(`${dnsBase}/${records[0].id}`, 'PUT', desired) : await api(dnsBase, 'POST', desired);
state.dnsRecordId = record.id;
await save();
const oldRecord = renamedDNSRecord(state, oldRecords);
if (oldRecord) await api(`${dnsBase}/${oldRecord.id}`, 'DELETE');
if (state.previousHostname) { delete state.previousHostname; delete state.previousDnsRecordId; await save(); }
console.log(`域名和路由已配置：https://${domain}\nAPI token 未保存到项目。运行以下命令使配置生效：\nsystemctl --user restart codex-cloud-panel.service\nnpm run native:tunnel\n当前使用工作台账号密码登录；Cloudflare Access 可按 docs/cloudflare.md 另行添加。`);
