import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { root, maintenanceSettings } from '../native/config.mjs';
import { cloudflareAPI, cloudflareTokenFile } from './cloudflare-client.mjs';
import { createNodeActivation, readActivationProfile } from './node-activation.mjs';
import { readGatewayConnection } from '../native/gateway-config.mjs';

export const activationHelp = `用法：npm run native:activate -- [选项]
首次接入：--domain 固定域名 --zone 区域
  --api-token-file FILE  可选，默认 secrets/cf_token；已接入节点沿用保存的路径
后续切换：npm run native:activate
  --status           只核对本节点是否为当前入口，不修改DNS或服务
  --resolve-unknown  明确接受当前DNS结果，解除本机待核对记录，不重发切换
  --help             显示帮助
首次应在当前拥有域名的原节点运行一次，以启用共享入口。
各节点独立Tunnel，数量不需预先登记；不共享密钥、终端、工作区或登录。
只更新当前节点的面板/Tunnel，不重启桌面、manager或tmux。
切换后保存浏览器草稿并刷新，已有连接与输入不会迁移或重发。
不要同时在多台机器发起切换；命令确认当前观察到的DNS结果。`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedJSON(response) {
  const chunks = []; let size = 0;
  for await (const bytes of response.body) { size += bytes.length; if (size > 4096) throw Error('节点探测响应超过4 KiB'); chunks.push(bytes); }
  return { status: response.status, value: JSON.parse(Buffer.concat(chunks)) };
}
function loadedNode(socketPath, hostname) {
  return new Promise(resolve => {
    const request = http.get({ socketPath, path: '/readyz', headers: { host: hostname }, signal: AbortSignal.timeout(3000) }, response => {
      const chunks = []; let size = 0;
      response.on('data', bytes => { size += bytes.length; if (size > 4096) response.destroy(); else chunks.push(bytes); });
      response.on('error', () => resolve('')); response.on('aborted', () => resolve(''));
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks)).nodeId || ''); } catch { resolve(''); } });
    });
    request.on('error', () => resolve(''));
  });
}
export async function activateCommand(args) {
  const { values } = parseArgs({ args, options: { domain: { type: 'string' }, zone: { type: 'string' }, 'api-token-file': { type: 'string' }, status: { type: 'boolean' }, 'resolve-unknown': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(activationHelp); return; }
  if (process.platform !== 'linux' || process.getuid() === 0) throw Error('请由Linux部署用户运行');
  if (values.status && values['resolve-unknown']) throw Error('状态核对与解除记录不能同时使用');
  if (readGatewayConnection(root)) throw Error('本机已接入固定网关，请从 /__nodes/ 选择节点；无需 CF 管理 Token 或 DNS 激活');
  const stored = await readActivationProfile(root);
  const tokenFile = cloudflareTokenFile(values['api-token-file'], { fallback: stored?.tokenFile });
  if (!values.status && !values['resolve-unknown'] && !stored && (!values.domain || !values.zone)) throw Error('首次接入需要 --domain、--zone；CF API Token默认读取 secrets/cf_token');
  const api = await cloudflareAPI(tokenFile, { privateFile: true }), config = maintenanceSettings();
  const exec = promisify(execFile);
  const service = async args => { try { return (await exec('systemctl', ['--user', ...args], { timeout: 5000, maxBuffer: 8192 })).stdout.trim(); } catch { return ''; } };
  if (!values.status && !values['resolve-unknown']) for (const unit of ['codex-cloud-panel.service', 'codex-cloud-tunnel.service']) if (await service(['show', unit, '--property=LoadState', '--value']) !== 'loaded') throw Error('请先完成 npm run deploy，安装本机服务');
  const run = async (lease, args) => { const result = await lease.runTerminal('systemctl', ['--user', ...args], { cwd: root, timeout: 60000 }); if (result.status !== 0) throw Error('本机服务更新失败，未切换DNS'); };
  const activation = createNodeActivation({ root, api, socketPath: config.tunnelSocket,
    services: async ({ panelChanged, tunnelChanged, profile, lease }) => {
      const installed = await lease.runTerminal(process.execPath, [join(root, 'scripts/install-cloudflared.mjs')], { cwd: root, timeout: 360000 });
      if (installed.status !== 0) throw Error('固定版本cloudflared未就绪，未切换DNS');
      if (await loadedNode(config.tunnelSocket, profile.domain) !== profile.nodeId) {
        if (!panelChanged) throw Error('运行中的面板未加载节点身份；请先更新面板后台，未切换DNS');
        await run(lease, ['restart', 'codex-cloud-panel.service']);
      }
      for (let n = 0; n < 20 && await loadedNode(config.tunnelSocket, profile.domain) !== profile.nodeId; n++) await pause(300);
      if (await loadedNode(config.tunnelSocket, profile.domain) !== profile.nodeId) throw Error('面板尚未加载节点身份，未切换DNS');
      const active = await service(['is-active', 'codex-cloud-tunnel.service']) === 'active';
      await run(lease, ['enable', 'codex-cloud-tunnel.service']);
      await run(lease, [active && tunnelChanged ? 'restart' : 'start', 'codex-cloud-tunnel.service']);
    },
    connected: async profile => {
      for (let n = 0; n < 12; n++) {
        const tunnel = await api('/accounts/' + profile.accountId + '/cfd_tunnel/' + profile.tunnelId);
        if (tunnel.status === 'healthy') return;
        if (n < 11) await pause(1000);
      }
      throw Error('本节点Tunnel尚未健康连接Cloudflare，未切换DNS');
    },
    publicReady: async profile => {
      for (let n = 0; n < 6; n++) {
        try {
          const result = await boundedJSON(await fetch('https://' + profile.domain + '/readyz', { redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store' }));
          if (result.status === 200 && result.value.ok === true && result.value.nodeId === profile.nodeId) return;
        } catch {}
        if (n < 5) await pause(1000);
      }
      throw Error('公网入口尚未确认命中新节点');
    },
  });
  const result = values.status ? await activation.status() : values['resolve-unknown'] ? await activation.resolveUnknown() : await activation.activate({ domain: values.domain?.toLowerCase(), zone: values.zone?.toLowerCase(), tokenFile });
  console.log(JSON.stringify(result));
  if (result.published) {
    console.log(result.reachable ? '固定域名已指向本节点，公网就绪验证通过。' : 'DNS切换已提交，公网尚未确认命中新节点；请稍后核对，不要重复提交。');
    console.log('已有终端任务保持在各自机器。保存草稿后刷新网页，确认节点后再输入；原连接与已发送操作不会迁移或重发。');
  }
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { await activateCommand(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
