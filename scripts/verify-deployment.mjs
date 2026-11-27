import http from 'node:http';
import https from 'node:https';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readBackendRevisions } from '../native/backend-version.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const VERIFY_LIMITS = Object.freeze({ config: 65536, response: 512 * 1024, requestMs: 6000, commandMs: 12000, commandBytes: 16384, checks: 64 });
const FAILURE_REASONS = Object.freeze({
  http_status: '接口返回非 200 状态。', response_format: '接口响应格式无效。', node_identity: '实际入口返回了不同的节点身份。',
  not_ready: '入口、任务宿主或文件服务尚未就绪。', ui_mismatch: '实际入口界面与当前仓库版本不一致。',
  backend_mismatch: '后台组件未加载当前源码，或运行版本无法核验。',
  helper_manifest: '助手清单不完整、构建混用或最终入口不匹配。', helper_hash: '助手文件大小或 SHA256 不匹配。', helper_build: '助手构建不是指定版本。',
});
const NETWORK_REASONS = Object.freeze({ ABORT_ERR: '请求达到 6 秒期限或已中止。', ETIMEDOUT: '网络请求超时。', ECONNREFUSED: '目标拒绝连接。', ECONNRESET: '连接被重置。', ENOTFOUND: '域名解析失败。', EAI_AGAIN: '域名解析暂时不可用。', CERT_HAS_EXPIRED: 'HTTPS 证书已过期。', DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS 自签名证书未被信任。', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书链无法验证。', SELF_SIGNED_CERT_IN_CHAIN: 'HTTPS 证书链包含未信任的证书。', ERR_TLS_CERT_ALTNAME_INVALID: 'HTTPS 证书主机名不匹配。' });
const failure = (reason, httpStatus) => Object.assign(Error('verification'), { verificationReason: reason, httpStatus });
export const help = `用法：npm run verify:deployment -- [--json] [--login] [--forward]
  --role node|center     默认从本仓库 .env 或中心配置识别角色
  --config-dir PATH      中心配置目录，默认 /etc/codex-selfhost
  --ca-file PATH         显式信任的 PEM CA；节点默认沿用已保存的中心 CA
  --login                用本机密码验证实际入口登录，完成后注销，不接管桌面
  --forward              要求四个平台助手已发布，并核对入口、构建和本机 SHA256
  --helper-build VERSION 要求助手为指定构建版本，同时启用 --forward 检查
  --json                 仅输出有界 JSON；使用 npm run --silent 避免 npm 命令前缀
  --help                 显示帮助
需要 Node.js 22+。不安装、不改配置、不重启服务、不发送终端输入。
默认不创建认证会话；--login 会临时创建验证会话，可能影响账号会话名额。
退出码：0 自动项通过（仍需核对人工项）；1 自动项失败；2 参数无效。`;

export function verifyOptions(args) {
  const { values } = util.parseArgs({ args, options: {
    json: { type: 'boolean' }, login: { type: 'boolean' }, forward: { type: 'boolean' }, help: { type: 'boolean' },
    role: { type: 'string' }, 'config-dir': { type: 'string' }, 'ca-file': { type: 'string' }, 'helper-build': { type: 'string' },
  } });
  if (values.role && !['node', 'center'].includes(values.role)) throw Error('role');
  if (values['helper-build'] !== undefined) {
    if (!/^[a-zA-Z0-9.+-]{1,64}$/.test(values['helper-build'])) throw Error('helper build');
    values.forward = true;
  }
  if (values.role === 'node' && values['config-dir'] || values.role === 'center' && values.forward) throw Error('role options');
  return values;
}

// No links, devices, unbounded configuration, remote bodies or child output.
async function boundedFile(path, maximum, secret = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum || stat.mode & (secret ? 0o077 : 0o022)) throw Error('file');
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const read = await file.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    if (count !== stat.size) throw Error('changed');
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}

export function verificationRequest(target, { ca, method = 'GET', headers = {}, body } = {}) {
  const url = new URL(target);
  validateEntry(url.href);
  return new Promise((resolve, reject) => {
    // Explicit verification also when NODE_TLS_REJECT_UNAUTHORIZED was inherited.
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method, headers, ca, rejectUnauthorized: true, agent: false, maxHeaderSize: 16384,
      signal: AbortSignal.timeout(VERIFY_LIMITS.requestMs),
    }, response => {
      const bytes = Buffer.alloc(VERIFY_LIMITS.response); let size = 0;
      response.on('data', chunk => { if (size + chunk.length > bytes.length) response.destroy(Error('oversize')); else { chunk.copy(bytes, size); size += chunk.length; } });
      response.on('error', reject); response.on('aborted', () => reject(Error('aborted')));
      response.on('end', () => {
        const resultHeaders = new Headers();
        for (const [name, values] of Object.entries(response.headers)) for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) resultHeaders.append(name, value);
        try { resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : bytes.subarray(0, size), { status: response.statusCode, headers: resultHeaders })); }
        catch { reject(Error('response')); }
      });
    });
    request.on('error', reject); request.end(body);
  });
}

function validateEntry(value, entry = false) {
  if (typeof value !== 'string' || value.length > 512) throw Error('entry');
  const url = new URL(value), loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.protocol === 'http:' && !loopback || url.username || url.password || url.hash || (entry && (url.search || !/^\/(?:node\/[a-z0-9-]{1,48}\/)?$/.test(url.pathname)))) throw Error('entry');
  return url;
}

const command = async (file, args) => {
  try {
    const result = await util.promisify(execFile)(file, args, { cwd: ROOT, timeout: VERIFY_LIMITS.commandMs, maxBuffer: VERIFY_LIMITS.commandBytes });
    return { ok: true, stdout: result.stdout.trim() };
  } catch { return { ok: false, stdout: '' }; }
};

export async function loadVerificationConfig(options, { root = ROOT, centerDirectory = options['config-dir'] || '/etc/codex-selfhost' } = {}) {
  let nodeText;
  try { nodeText = (await boundedFile(join(root, '.env'), VERIFY_LIMITS.config)).toString(); }
  catch (error) { if (options.role !== 'center' && error.code !== 'ENOENT') throw error; }
  const role = options.role || (nodeText !== undefined ? 'node' : 'center');
  if (role === 'center') {
    if (options.forward) throw Error('center helpers belong to nodes');
    const env = util.parseEnv((await boundedFile(join(centerDirectory, 'server.env'), VERIFY_LIMITS.config)).toString());
    const url = validateEntry(env.SELFHOST_ORIGIN, true);
    if (url.pathname !== '/' || env.SELFHOST_PUBLIC_HOST !== url.hostname) throw Error('center entry');
    const { centerListenerConfig } = await import('../selfhost/listeners.mjs');
    const { internalPort } = centerListenerConfig(env);
    return { role, root, entry: url.href, internalPort, kind: 'selfhost-center', username: 'admin', passwordFile: join(centerDirectory, 'admin_password'),
      services: ['codex-selfhost-center.service', 'codex-selfhost-frps.service', 'codex-selfhost-caddy.service', 'codex-selfhost-coturn.service'],
      ca: options['ca-file'] ? await loadCA(resolve(options['ca-file'])) : undefined };
  }
  if (nodeText === undefined) throw Error('missing deployment');
  if (options['config-dir']) throw Error('center configuration used for node');
  const env = util.parseEnv(nodeText); // Persisted configuration wins over an old task's environment.
  const { deploymentMode, modeServices } = await import('../native/deployment-mode.mjs');
  const { readGatewayConnection } = await import('../native/gateway-config.mjs');
  const { readSelfhostNode } = await import('../panel/selfhost-config.mjs');
  const { normalizeEntryBasePath } = await import('../panel/entry-path.mjs');
  const mode = deploymentMode(env.DEPLOY_MODE), origin = validateEntry(env.PUBLIC_ORIGIN, true);
  if (origin.pathname !== '/') throw Error('origin');
  const path = normalizeEntryBasePath(env.ENTRY_BASE_PATH), entry = validateEntry(origin.origin + path, true).href;
  const nodeId = env.NODE_ID || '';
  if (nodeId && !/^[a-f0-9]{32}$/.test(nodeId)) throw Error('node identity');
  const gateway = readGatewayConnection(root), selfhost = readSelfhostNode(root, env);
  if (gateway && selfhost || gateway && (gateway.origin !== origin.origin || gateway.nodeId !== nodeId || env.SHARED_ENTRY !== '1' || path !== '/') || selfhost && (selfhost.origin !== origin.origin || selfhost.path !== path || selfhost.nodeId !== nodeId)) throw Error('entry mismatch');
  if (!selfhost && path !== '/' || env.SHARED_ENTRY === '1' && !nodeId) throw Error('incomplete entry');
  const services = modeServices(mode);
  let tunnel = false;
  if (!selfhost && origin.protocol === 'https:') {
    try { tunnel = (await boundedFile(join(root, 'secrets', 'tunnel_token'), 4096, true)).toString('utf8').trim() !== ''; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (selfhost) services.push('codex-cloud-selfhost-node.service');
  else if (tunnel || gateway) services.push('codex-cloud-tunnel.service');
  const caFile = options['ca-file'] ? resolve(options['ca-file']) : env.SELFHOST_CA_FILE ? resolve(root, env.SELFHOST_CA_FILE) : null;
  if (!options['ca-file'] && caFile && caFile !== resolve(root) && !caFile.startsWith(resolve(root) + sep)) throw Error('saved CA must be inside deployment');
  return { role, root, env, mode, entry, nodeId, gateway, selfhost, username: env.ADMIN_USER || 'admin', passwordFile: join(root, 'secrets', 'panel_password'), services,
    kind: selfhost ? 'selfhost-node' : gateway ? 'cloudflare-gateway' : tunnel ? 'cloudflare' : origin.protocol === 'http:' ? 'local' : 'https',
    ca: caFile ? await loadCA(caFile) : undefined, forwardDirectory: join(root, 'data', 'forward-client'), webrtc: env.WEBRTC_ENABLED !== '0' };
}

async function loadCA(file) { const { readCenterCA } = await import('../panel/center-http.mjs'); return readCenterCA(file); }

async function expectedUI(config) {
  const { createUIAssets } = await import('../panel/ui-assets.mjs');
  const { createLoginIdentity, nodeLoginScope } = await import('../panel/login-identity.mjs');
  return (await createUIAssets({ validate: false, nodeId: config.nodeId, entryBasePath: new URL(config.entry).pathname,
    gateway: !!config.gateway, gatewayOrigin: config.gateway?.origin || '',
    login: createLoginIdentity(config.username, nodeLoginScope({ nodeId: config.nodeId, entryBasePath: new URL(config.entry).pathname, sharedEntry: config.env.SHARED_ENTRY === '1' || !!config.gateway }), { nodeName: config.gateway?.name || '' }) })).revision;
}

async function localArtifacts(config) {
  const { artifactSnapshot, artifactRead, FORWARD_FILES, ARTIFACT_LIMITS } = await import('../native/forward-artifacts.mjs');
  const snapshot = await artifactSnapshot(config.forwardDirectory), entry = new URL(config.entry);
  const server = entry.origin + (entry.pathname === '/' ? '' : entry.pathname);
  if (snapshot.server !== server || snapshot.files.length !== 4 || new Set(snapshot.files.map(file => file.build)).size !== 1) throw failure('helper_manifest');
  for (const item of snapshot.files) {
    const bytes = await artifactRead(join(snapshot.location, FORWARD_FILES[item.arch]), ARTIFACT_LIMITS.file);
    if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw failure('helper_hash');
  }
  return snapshot.files.map(({ arch, size, sha256, build }) => ({ arch, size, sha256, build }));
}

export async function verifyDeployment(options = {}, dependencies = {}) {
  const report = { version: 1, deployment: {}, checks: [] };
  const add = (id, status, message, hint) => {
    if (report.checks.length >= VERIFY_LIMITS.checks) throw Error('checks');
    report.checks.push({ id, status, message, ...(hint ? { hint } : {}) });
  };
  const attempt = async (id, action, success, hint) => {
    try { const value = await action(); if (value === false) throw Error('check'); add(id, 'pass', success); return value; }
    catch (error) {
      // Only allowlisted causes and numeric status; raw errors and remote
      // response bodies may contain credentials and must never reach reports.
      const reason = Object.hasOwn(FAILURE_REASONS, error?.verificationReason) ? error.verificationReason : Object.hasOwn(NETWORK_REASONS, error?.code) ? error.code : null;
      add(id, 'fail', FAILURE_REASONS[reason] || NETWORK_REASONS[reason] || '检查未通过。', hint);
      if (reason) report.checks.at(-1).reason = reason;
      if (reason === 'http_status' && Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) report.checks.at(-1).httpStatus = error.httpStatus;
      return null;
    }
  };
  const finish = () => {
    const counts = Object.fromEntries(['pass', 'fail', 'manual', 'skip'].map(status => [status, report.checks.filter(check => check.status === status).length]));
    report.summary = { ...counts, automatedOk: counts.fail === 0, acceptanceComplete: counts.fail === 0 && counts.manual === 0 };
    return report;
  };
  const config = await attempt('configuration', () => (dependencies.loadConfig || loadVerificationConfig)(options), '部署角色、模式和最终入口配置一致。', '在部署仓库执行；节点先完成 deploy / gateway:join / server:join。中心用 --role center，确认配置读取权限。');
  if (!config) return finish();
  report.deployment = { role: config.role, kind: config.kind, entry: config.entry, ...(config.mode ? { mode: config.mode, nodeId: config.nodeId } : {}) };
  const run = dependencies.run || command;
  const git = await run('git', ['-C', config.root, 'rev-parse', 'HEAD']);
  if (git.ok && /^[a-f0-9]{40,64}$/.test(git.stdout)) report.deployment.sourceCommit = git.stdout;
  else add('source', 'manual', '无法读取源码提交标识；此报告不证明后台进程已加载当前代码。');
  const dirty = await run('git', ['-C', config.root, 'status', '--porcelain', '--untracked-files=normal']);
  if (!dirty.ok || dirty.stdout) add('source-tree', 'manual', '源码状态未确认干净；提交标识不能代表所有本机修改。');
  for (const unit of config.services) await attempt('service:' + unit, async () => {
    const result = await run('systemctl', [...(config.role === 'node' ? ['--user'] : []), 'is-active', unit]);
    return result.ok && result.stdout === 'active';
  }, unit + ' 正在运行。', config.role === 'node' ? '运行 npm run native:status；检查对应用户服务日志。' : '检查对应中心系统服务日志。');
  if (config.role === 'node') {
    await attempt('prerequisites', async () => (await run(process.execPath, [join(config.root, 'scripts/deploy.mjs'), '--check'])).ok, '现有 deploy --check（含 native:doctor 与适用的 WSL 检查）通过。', '运行 npm run deploy -- --check 查看环境问题；检查不会安装或升级。');
    if (config.selfhost) await attempt('relay', async () => {
      const { nodeDoctor } = await import('../selfhost/node.mjs');
      return (await (dependencies.relayDoctor || nodeDoctor)({ root: config.root, run })).ok;
    }, '现有 server:doctor 检查通过。', '运行 npm run server:doctor 核对中继、CA 和待恢复记录。');
  }
  const request = dependencies.request || verificationRequest;
  const origin = new URL(config.entry).origin;
  const fetch = (path, options = {}) => request(new URL(path, config.entry), { ca: config.ca, ...options,
    headers: { origin, ...(config.nodeId ? { 'x-codex-node': config.nodeId } : {}), ...options.headers } });
  const requireType = (response, expected) => {
    if (response.status !== 200) throw failure('http_status', response.status);
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== expected) throw failure('response_format');
  };
  const json = async response => {
    requireType(response, 'application/json');
    try { return await response.json(); } catch { throw failure('response_format'); }
  };
  const ready = await attempt('entry', async () => {
    const value = await json(await fetch(config.role === 'node' ? 'readyz' : 'healthz'));
    if (config.role === 'node' && (value.nodeId || '') !== config.nodeId) throw failure('node_identity');
    if (value.ok !== true || config.role === 'node' && (value.host !== true || value.files !== true)) throw failure('not_ready');
    return true;
  }, config.role === 'node' ? '实际节点入口、任务宿主和文件服务已就绪，已配置的节点身份匹配。' : '中心实际 HTTPS 入口健康检查通过。', '检查最终域名、完整节点路径、TLS、宿主和文件服务；网关当前默认节点必须与本机身份一致。');
  if (config.role === 'node' && !config.nodeId) add('node-identity', 'manual', '本机未保存固定 NODE_ID，只能核对所配置的域名与路径，无法独立确认固定节点身份。');
  if (config.role === 'node') await attempt('ui', async () => {
    const expected = await (dependencies.expectedUI || expectedUI)(config), actual = await json(await fetch('ui-version'));
    if (!/^[a-f0-9]{24}$/.test(actual.revision) || actual.revision !== expected) throw failure('ui_mismatch');
    report.deployment.uiRevision = actual.revision; return true;
  }, '实际入口界面版本与当前仓库一致。', '新增资源注册项需更新 panel；仅已有前端内容修改可运行 npm run reload-ui。');
  else {
    if (config.internalPort !== undefined) await attempt('internal-listener', async () => {
      const value = await json(await request(new URL(`http://127.0.0.1:${config.internalPort}/internal/healthz`)));
      return value.ok === true && value.isolated === true;
    }, '中心独立回环监听已就绪。', '在中心主机执行验收，核对 SELFHOST_INTERNAL_PORT、Caddy forward_auth 和 frps 插件地址；用完整中心 install 同步升级配置。');
    else add('internal-listener', 'manual', '当前配置使用旧版共享监听；完整运行中心 install 可启用独立回环监听，并同步 Caddy/frps 配置。');
    const pageContains = async (path, marker) => {
      const response = await fetch(path);
      requireType(response, 'text/html');
      return (await response.text()).includes(marker);
    };
    await attempt('homepage', () => pageContains('', '/admin/'), '公开首页提供管理入口。', '检查 Caddy 首页路由。');
    await attempt('admin-page', () => pageContains('admin/', 'login-form'), '管理子路径登录页可访问。', '核对 /admin/ 路由和管理网段白名单；从允许的网络执行。');
    await attempt('public-nodes', async () => Array.isArray((await json(await fetch('api/public/nodes'))).nodes), '匿名节点列表接口可访问。', '检查中心服务和公开节点列表接口。');
  }
  let helpers;
  if (config.role === 'node') {
    let selected = options.forward === true;
    if (!selected) {
      try { await boundedFile(join(config.forwardDirectory, 'current.json'), 256); selected = true; }
      catch (error) { if (error.code !== 'ENOENT') selected = true; }
      if (!selected) { try { await boundedFile(join(config.forwardDirectory, 'manifest.json'), 4096); selected = true; } catch (error) { if (error.code !== 'ENOENT') selected = true; } }
    }
    if (selected) helpers = await attempt('forward-artifacts', async () => {
      const files = await (dependencies.artifacts || localArtifacts)(config);
      if (options['helper-build'] && files.some(file => file.build !== options['helper-build'])) throw failure('helper_build');
      return files;
    }, '四个平台助手的最终入口、构建一致性和本机 SHA256 正确。', '最终入口接入完成后运行 npm run build:forward；保留现有 v2 key 和规则。指定构建版本时也必须匹配。');
    else add('forward-artifacts', 'skip', '未要求且未发现已发布助手；如需要助手，请增加 --forward。');
    if (helpers) report.deployment.helperBuild = helpers[0].build;
  }
  if (options.login && ready) {
    let cookie, csrf;
    const prefix = config.role === 'center' ? 'admin/' : '';
    const loggedIn = await attempt('login', async () => {
      const password = (await (dependencies.readPassword || (path => boundedFile(path, 4096, true)))(config.passwordFile)).toString().trim();
      if (password.length < 16 || password.length > 512 || /[\r\n\0]/.test(password)) throw Error('password');
      const response = await fetch(prefix + 'api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: config.username, password }) });
      const name = config.role === 'center' ? 'coc_session_center_admin' : 'coc_session' + (config.nodeId ? '_' + config.nodeId : '');
      cookie = response.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0];
      const value = await json(response); csrf = value.csrf;
      if (!cookie || typeof csrf !== 'string' || !/^[a-f0-9]{48}$/.test(csrf) || config.role === 'node' && value.mode !== config.mode) throw Error('session');
      return true;
    }, '实际入口账号登录成功；没有接管或解锁桌面。', '核对本机密码文件、实际入口和账号；不自动重试登录。');
    try {
      if (loggedIn) await attempt('backend-code', async () => {
        const expected = await (dependencies.expectedBackend || (config => readBackendRevisions(config.root, config.role === 'center' ? ['center'] : ['panel', 'manager', 'files', ...(config.mode === 'desktop' ? ['actions'] : [])])))(config);
        const value = await json(await fetch(prefix + 'api/backend-version', { headers: { cookie } }));
        const required = config.role === 'center' ? ['center'] : ['panel', 'manager', 'files', ...(config.mode === 'desktop' ? ['actions'] : [])];
        const components = report.deployment.backend = {};
        for (const name of required) {
          const item = value?.components?.[name];
          const available = value?.protocol === 1 && item?.protocol === 1 && item.component === name && /^[a-f0-9]{64}$/.test(item.revision) && Number.isSafeInteger(item.startedAt) && item.startedAt > 0 && Number.isSafeInteger(item.pid) && item.pid > 0;
          components[name] = !available ? 'unavailable' : item.revision === expected[name] ? 'match' : 'mismatch';
        }
        if (Object.values(components).some(status => status !== 'match')) throw failure('backend_mismatch');
        return true;
      }, '实际入口后台组件的启动版本与本机源码包一致。', '按 deployment.backend 的组件结果更新面板、管理、文件或桌面执行服务；中心更新中心服务。不会自动重启任务。');
      if (loggedIn && helpers) await attempt('forward-publication', async () => {
        const value = await json(await fetch('api/forward', { headers: { cookie } }));
        if (!Array.isArray(value.downloads) || value.downloads.length !== 4) throw Error('downloads');
        const seen = new Set();
        for (const item of value.downloads) {
          const expected = helpers.find(file => file.arch === item.arch), target = new URL(item.href, config.entry);
          if (!expected || seen.has(item.arch) || ['size', 'sha256', 'build'].some(key => expected[key] !== item[key]) || target.origin !== origin || target.username || target.password || target.hash || target.pathname !== new URL('api/forward/download/' + item.arch, config.entry).pathname || target.search && !/^\?generation=[a-f0-9]{32}$/.test(target.search)) throw Error('publication');
          seen.add(item.arch);
        }
        return true;
      }, '实际入口发布的四项助手下载与本机构建一致。', '检查节点入口和助手发布；不要使用旧域名或缺少节点路径的包。');
    } finally {
      if (cookie && typeof csrf === 'string' && /^[a-f0-9]{48}$/.test(csrf)) await attempt('logout', async () => (await fetch(prefix + 'api/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{}' })).status === 200, '验证会话已注销。', '注销结果未确认，请在账号管理中核对验证会话。');
      else if (cookie) add('logout', 'manual', '登录响应无效，验证会话的注销未确认；请核对账号会话。');
    }
  } else add('login', 'manual', options.login ? '入口身份未核验通过，未发送登录凭据。' : '尚未验证实际账号登录；可增加 --login，或在浏览器人工验证。');
  if (helpers) {
    if (!report.checks.some(check => check.id === 'forward-publication')) add('forward-publication', 'manual', '尚未核对已认证入口的下载列表；可增加 --login。');
    add('forward-device', 'manual', '从实际入口下载所用平台助手，核对 SHA256，连接目标电脑并验证所需 TCP / 串口规则。');
  }
  if (config.role === 'node') {
    add('interaction', 'manual', '在浏览器核对终端或桌面、输入目标、中文/听写、粘贴与独立 Enter，以及文件上传下载。');
    add('reconnect', 'manual', '核对重连、锁屏和接管后原任务保留，未确认的输入没有补发。');
    add('network', config.webrtc ? 'manual' : 'skip', config.webrtc ? '在实际设备与网络验证直连/中转；未实测的拓扑不能由健康检查代替。' : '未启用 WebRTC。');
    if (config.gateway) add('gateway-switch', 'manual', '在 /__nodes/ 验证所需节点的登记、切换及原任务保留。');
  } else {
    add('center-routing', 'manual', '在一个真实节点路径验证登录、终端/桌面及文件；中心健康不代表节点已部署。');
    add('center-network', 'manual', '在目标网络验证 frpc 接入、TURN 中继和所选证书续期方式。');
  }
  if (!report.checks.some(check => check.id === 'backend-code')) add('backend-code', 'manual', '尚未核验后台启动版本；可增加 --login。界面匹配和服务 active 不能替代后台版本核验。');
  return finish();
}

export function formatVerification(report) {
  const names = { pass: '通过', fail: '失败', manual: '待人工验证', skip: '未启用' };
  const lines = ['部署验收（自动检查与人工项目分别报告）'];
  if (report.deployment.entry) lines.push(`角色：${report.deployment.role}；模式：${report.deployment.mode || '中心'}；入口：${report.deployment.entry}`);
  for (const check of report.checks) lines.push(`[${names[check.status]}] ${check.id}：${check.message}${check.httpStatus ? ' HTTP ' + check.httpStatus + '。' : ''}${check.hint ? ' ' + check.hint : ''}`);
  const summary = report.summary;
  lines.push(`自动通过 ${summary.pass}，失败 ${summary.fail}，待人工验证 ${summary.manual}，未启用 ${summary.skip}。`);
  lines.push(summary.fail ? '自动检查失败，请先处理失败项。' : '自动检查通过；完整验收仍须完成上述人工项目和部署检查清单。');
  return lines.join('\n');
}

const failureReport = (id, message) => ({ version: 1, deployment: {}, checks: [{ id, status: 'fail', message }], summary: { pass: 0, fail: 1, manual: 0, skip: 0, automatedOk: false, acceptanceComplete: false } });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = verifyOptions(process.argv.slice(2)); }
  catch {
    const message = '参数无效；运行 npm run verify:deployment -- --help。';
    if (process.argv.includes('--json')) console.log(JSON.stringify(failureReport('arguments', message))); else console.error(message);
    process.exitCode = 2;
  }
  if (options?.help) console.log(help);
  else if (options) {
    try {
      if (Number(process.versions.node.split('.')[0]) < 22) throw Error('runtime');
      const report = await verifyDeployment(options);
      console.log(options.json ? JSON.stringify(report) : formatVerification(report));
      process.exitCode = report.summary.automatedOk ? 0 : 1;
    } catch {
      const report = failureReport('verification', '验收未完成，请检查 Node.js 22+、配置权限及命令环境。');
      console.log(options.json ? JSON.stringify(report) : formatVerification(report)); process.exitCode = 1;
    }
  }
}
