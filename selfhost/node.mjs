import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { centerClient, centerRequest, readCenterCA } from '../panel/center-http.mjs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { readStateFile, removeStateFile, writeStateFile } from '../scripts/state-files.mjs';
import { acquireDeploymentLease } from '../scripts/deployment-lease.mjs';
import { installFrpc } from './frpc.mjs';
import { CREDENTIAL, KEY, NODE_ID, SELFHOST_LIMITS, SLUG, entryBasePath, slug } from './protocol.mjs';

const exec = promisify(execFile);
export const NODE_SERVICE = 'codex-cloud-selfhost-node.service';

async function command(file, args) {
  try {
    const value = await exec(file, args, { timeout: 30000, maxBuffer: 64 * 1024, env: { ...process.env, NO_COLOR: '1' } });
    return { ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() };
  } catch (error) {
    return { ok: false, code: error.code, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || '').trim() };
  }
}

function origin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('中心服务器地址必须是 HTTP(S) 根地址');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw Error('远程节点必须使用 HTTPS 中心服务器');
  return url.origin;
}

function validateConnection(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'origin', 'slug', 'name', 'path', 'nodeId', 'mode', 'credential', 'proxyHost', 'turnEndpoint', 'frp'].includes(key))) throw Error('节点接入配置格式无效');
  if (!equalsOrigin(value.origin) || !NODE_ID.test(value.nodeId) || !CREDENTIAL.test(value.credential) || !['desktop', 'terminal'].includes(value.mode) || value.path !== entryBasePath(value.slug)) throw Error('节点接入配置身份无效');
  if (value.turnEndpoint !== undefined && value.turnEndpoint !== null && value.turnEndpoint !== value.origin + '/api/turn-credentials') throw Error('节点 TURN 地址必须属于接入中心');
  if (!value.frp || typeof value.frp.serverAddr !== 'string' || !value.frp.serverAddr || value.frp.serverAddr.length > 255 || !Number.isInteger(value.frp.serverPort) || value.frp.serverPort < 1 || value.frp.serverPort > 65535 || typeof value.frp.tlsServerName !== 'string' || !value.frp.tlsServerName || typeof value.frp.token !== 'string' || value.frp.token.length < 16 || value.frp.token.length > 512 || typeof value.proxyHost !== 'string' && typeof value.proxyHost !== 'undefined') throw Error('节点 frp 配置无效');
  return value;
}
const equalsOrigin = value => { try { return origin(value) === value; } catch { return false; } };
const pathFor = (root, name) => join(root, 'data', 'selfhost-node', name);
const json = value => JSON.stringify(value, null, 2) + '\n';
const toml = value => JSON.stringify(value);

export function frpcConfig(connection, { panelPort, caFile } = {}) {
  validateConnection(connection);
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535) throw Error('本机面板端口无效');
  return `serverAddr = ${toml(connection.frp.serverAddr)}
serverPort = ${connection.frp.serverPort}
auth.token = ${toml(connection.frp.token)}
transport.tls.enable = true
${caFile ? `transport.tls.trustedCaFile = ${toml(caFile)}` : 'transport.tls.useSystemCa = true'}
transport.tls.serverName = ${toml(connection.frp.tlsServerName)}
transport.heartbeatInterval = 5
transport.heartbeatTimeout = 20
loginFailExit = true
log.to = "console"
log.level = "info"
metadatas.credential = ${toml(connection.credential)}
metadatas.slug = ${toml(connection.slug)}
metadatas.nodeId = ${toml(connection.nodeId)}
metadatas.mode = ${toml(connection.mode)}

[[proxies]]
name = ${toml('node-' + connection.slug)}
type = "http"
localIP = "127.0.0.1"
localPort = ${panelPort}
customDomains = [${toml(connection.proxyHost || connection.frp.tlsServerName)}]
locations = [${toml(connection.path)}]
healthCheck.type = "tcp"
healthCheck.intervalSeconds = 10
healthCheck.maxFailed = 3
healthCheck.timeoutSeconds = 3
`;
}

function systemdQuote(value) {
  if (/[\r\n\0]/.test(value)) throw Error('systemd 路径无效');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

export function serviceUnit({ frpc, config }) {
  return `[Unit]
Description=Codex on Cloud self-host node relay
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${systemdQuote(frpc)} -c ${systemdQuote(config)}
Restart=on-failure
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
UMask=0077
LimitNOFILE=4096

[Install]
WantedBy=default.target
`;
}

async function optional(path, limit = 16384) { try { return await readStateFile(path, limit, true); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

async function httpsHealth(origin, _serverName, ca) {
  const response = await centerClient(origin, ca)(origin + '/healthz', { signal: AbortSignal.timeout(5000) });
  return response.ok && (await response.json()).ok === true;
}

function replaceEnv(text, key, value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw Error('Panel 环境配置值无效');
  const pattern = new RegExp('^' + key + '=.*$', 'gm'), matches = text.match(pattern);
  if (matches && matches.length > 1) throw Error('.env 包含重复的 ' + key + '，请先人工消除冲突');
  return matches ? text.replace(pattern, key + '=' + value) : text + (text.endsWith('\n') ? '' : '\n') + key + '=' + value + '\n';
}

function panelEnvironment(before, connection, caFile) {
  let text = replaceEnv(before, 'PUBLIC_ORIGIN', connection.origin);
  text = replaceEnv(text, 'ENTRY_BASE_PATH', connection.path);
  text = replaceEnv(text, 'SELFHOST_NODE_CONFIG_FILE', './data/selfhost-node/connection.json');
  text = replaceEnv(text, 'SHARED_ENTRY', '0');
  text = replaceEnv(text, 'NODE_ID', connection.nodeId);
  text = replaceEnv(text, 'SELFHOST_CA_FILE', caFile ? './data/selfhost-node/frps-ca.pem' : '');
  const parsed = parseEnv(text);
  if (parsed.PUBLIC_ORIGIN !== connection.origin || parsed.ENTRY_BASE_PATH !== connection.path || parsed.SELFHOST_NODE_CONFIG_FILE !== './data/selfhost-node/connection.json' || parsed.SHARED_ENTRY !== '0' || parsed.NODE_ID !== connection.nodeId) throw Error('Panel 环境配置存在冲突，未修改');
  return text;
}

function panelTarget(connection) {
  return { origin: connection.origin, slug: connection.slug, nodeId: connection.nodeId, path: connection.path };
}

function validPanelTarget(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4 &&
    equalsOrigin(value.origin) && typeof value.slug === 'string' && SLUG.test(value.slug) &&
    NODE_ID.test(value.nodeId) && value.path === entryBasePath(value.slug);
}

const panelPaths = root => ({
  env: join(root, '.env'),
  credentials: join(root, 'secrets', 'credentials.txt'),
  gateway: join(root, 'data', 'gateway-node.json'),
  backup: pathFor(root, 'panel-backup.json'),
});

const recoveryPath = root => pathFor(root, 'join-recovery.json');

function validateRecovery(value) {
  if (value?.version === 2) return validateTransaction(value);
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.at) || value.at <= 0 || typeof value.error !== 'string' || value.error.length > 2048 || !value.before || typeof value.before !== 'object' || Array.isArray(value.before)) throw Error('节点接入恢复记录无效');
  const connection = validateConnection(value.connection);
  for (const key of ['connection', 'config', 'unit', 'ca']) if (value.before[key] !== null && (typeof value.before[key] !== 'string' || Buffer.byteLength(value.before[key]) > 262144)) throw Error('节点接入恢复文件快照无效');
  return { version: 1, at: value.at, error: value.error, connection, before: { connection: value.before.connection, config: value.before.config, unit: value.before.unit, ca: value.before.ca } };
}

async function readRecovery(root) {
  const text = await optional(recoveryPath(root), 256 * 1024);
  if (text === null) return null;
  try { return { text, value: validateRecovery(JSON.parse(text)) }; } catch (error) { throw Error('节点接入恢复记录无法读取：' + error.message); }
}

async function panelState(root) {
  const paths = panelPaths(root), env = await optional(paths.env, 65536), credentials = await optional(paths.credentials, 4096), gatewayBefore = await optional(paths.gateway, 4096);
  if (env === null) throw Error('本机尚未完成 Panel 初始化，请先运行 npm run setup 或现有部署流程');
  return { paths, env, credentials, gatewayBefore };
}

async function publicationState(root) {
  const files = ['gateway-node.json', 'gateway-join.json', 'cloudflare-node.json', 'cloudflare-publication.json', 'cloudflare-activation.json', 'cloudflare-deployment.json'];
  for (const name of files) if (await optional(join(root, 'data', name), 262144) !== null) return name;
  return null;
}

async function planPanel(root, connection, { switchExisting = false, replace = false, previousConnection, caFile } = {}) {
  const current = await panelState(root), backupText = await optional(current.paths.backup, 131072);
  let backup, backupChanged = false;
  if (backupText !== null) {
    try { backup = JSON.parse(backupText); } catch { throw Error('Panel 切换备份格式无效'); }
    if (!backup || ![1, 2].includes(backup.version) || typeof backup.envBefore !== 'string' || typeof backup.envAfter !== 'string' || typeof backup.gatewayBefore !== 'string' && backup.gatewayBefore !== null || typeof backup.credentialsBefore !== 'string' && backup.credentialsBefore !== null || typeof backup.credentialsAfter !== 'string' && backup.credentialsAfter !== null) throw Error('Panel 切换备份内容无效');
    if (backup.version === 1) {
      if (!previousConnection || !validPanelTarget(panelTarget(previousConnection))) throw Error('旧版 Panel 切换备份缺少可识别的原连接，未覆盖');
      backup = { ...backup, version: 2, target: panelTarget(previousConnection) }; backupChanged = true;
    }
    if (!validPanelTarget(backup.target)) throw Error('Panel 切换备份目标无效');
  } else {
    const publication = await publicationState(root);
    if (publication && !switchExisting) throw Error('检测到现有 Cloudflare/Gateway 发布状态；如需接管，请显式使用 --switch-existing。普通 server:leave 会恢复原配置');
    backup = {
      version: 2,
      target: panelTarget(connection),
      envBefore: current.env,
      envAfter: panelEnvironment(current.env, connection, caFile),
      credentialsBefore: current.credentials,
      credentialsAfter: current.credentials?.replace(/^工作台：.*$/m, '工作台：' + connection.origin) ?? null,
      gatewayBefore: current.gatewayBefore,
    };
    backupChanged = true;
  }
  const previousEnvAfter = backup.envAfter, previousCredentialsAfter = backup.credentialsAfter;
  const desiredTarget = panelTarget(connection), sameTarget = JSON.stringify(backup.target) === JSON.stringify(desiredTarget);
  if (!sameTarget && !replace) throw Error('Panel 已绑定其他自建节点；切换中心或 slug 必须显式使用 --replace');
  const desiredEnvAfter = panelEnvironment(backup.envBefore, connection, caFile);
  const desiredCredentialsAfter = backup.credentialsBefore?.replace(/^工作台：.*$/m, '工作台：' + connection.origin) ?? null;
  if (backup.target.origin !== desiredTarget.origin || backup.target.slug !== desiredTarget.slug || backup.target.nodeId !== desiredTarget.nodeId || backup.target.path !== desiredTarget.path || backup.envAfter !== desiredEnvAfter || backup.credentialsAfter !== desiredCredentialsAfter) backupChanged = true;
  backup = { ...backup, target: desiredTarget, envAfter: desiredEnvAfter, credentialsAfter: desiredCredentialsAfter };

  if (current.env !== backup.envBefore && current.env !== previousEnvAfter && current.env !== backup.envAfter) throw Error('Panel 环境配置在接入过程中被修改，未覆盖');
  if (current.credentials !== backup.credentialsBefore && current.credentials !== previousCredentialsAfter && current.credentials !== backup.credentialsAfter) throw Error('Panel 登录说明在接入过程中被修改，未覆盖');
  return {
    before: { env: current.env, credentials: current.credentials, gateway: current.gatewayBefore, backup: backupText },
    after: { env: backup.envAfter, credentials: backup.credentialsAfter, gateway: null, backup: backupChanged ? json(backup) : backupText },
  };
}

async function preflightPanel(root, switchExisting) {
  await panelState(root);
  if (await optional(panelPaths(root).backup, 131072) !== null) return;
  const publication = await publicationState(root);
  if (publication && !switchExisting) throw Error('检测到现有 Cloudflare/Gateway 发布状态；如需接管，请显式使用 --switch-existing。普通 server:leave 会恢复原配置');
}

async function restorePanel(root, { run = command } = {}) {
  const paths = panelPaths(root), backupText = await optional(paths.backup, 131072);
  if (backupText === null) return false;
  let backup; try { backup = JSON.parse(backupText); } catch { throw Error('Panel 切换备份损坏，未恢复'); }
  const currentEnv = await optional(paths.env, 65536), currentCredentials = await optional(paths.credentials, 4096);
  if (currentEnv !== null && currentEnv !== backup.envBefore && currentEnv !== backup.envAfter) throw Error('Panel 环境在自建接入后被修改，未自动恢复');
  if (currentCredentials !== null && currentCredentials !== backup.credentialsBefore && currentCredentials !== backup.credentialsAfter) throw Error('Panel 登录说明在自建接入后被修改，未自动恢复');
  if (currentEnv !== backup.envBefore) await writeStateFile(paths.env, backup.envBefore, { expected: currentEnv });
  if (backup.credentialsBefore !== null && currentCredentials !== backup.credentialsBefore) await writeStateFile(paths.credentials, backup.credentialsBefore, { expected: currentCredentials });
  if (backup.gatewayBefore !== null) {
    const current = await optional(paths.gateway, 4096);
    if (current !== null && current !== backup.gatewayBefore) throw Error('Gateway 配置在自建接入后被修改，未覆盖');
    if (current === null) await writeStateFile(paths.gateway, backup.gatewayBefore, { expected: null });
  }
  const result = await run('systemctl', ['--user', 'restart', 'codex-cloud-panel.service']);
  if (!result.ok) throw Error('Panel 原配置已恢复，但服务重启失败：' + (result.stderr || result.stdout || result.code));
  await removeStateFile(paths.backup, { expected: backupText });
  return true;
}

export async function readNodeConnection(root) {
  const text = await optional(pathFor(root, 'connection.json'), 16384);
  if (text === null) return null;
  try { return validateConnection(JSON.parse(text)); } catch (error) { throw Error('节点接入配置无法读取：' + error.message, { cause: error }); }
}

function servicePath(configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')) {
  return join(configHome, 'systemd', 'user', NODE_SERVICE);
}

async function relayState(run) {
  const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]);
  const enabled = await run('systemctl', ['--user', 'is-enabled', NODE_SERVICE]);
  return { active: active.ok && active.stdout === 'active', enabled: enabled.ok && ['enabled', 'enabled-runtime'].includes(enabled.stdout) };
}

async function stopRelay(run) {
  const result = await run('systemctl', ['--user', 'disable', '--now', NODE_SERVICE]);
  if (result.ok) return result;
  // A failure before unit creation has nothing to stop. Confirm both systemd
  // load and active state instead of treating an arbitrary stop error as success.
  const loaded = await run('systemctl', ['--user', 'show', NODE_SERVICE, '--property=LoadState', '--value']);
  const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]);
  return loaded.ok && loaded.stdout === 'not-found' && ['inactive', 'unknown'].includes(active.stdout) ? { ok: true } : result;
}

async function restoreRelay(before, run) {
  if (!before) return [];
  const failures = [];
  if (before.enabled) {
    const enabled = await run('systemctl', ['--user', 'enable', NODE_SERVICE]);
    if (!enabled.ok) failures.push('恢复中继自启动：' + (enabled.stderr || enabled.stdout || enabled.code || 'unknown'));
  }
  if (before.active) {
    const restarted = await run('systemctl', ['--user', 'restart', NODE_SERVICE]);
    const active = restarted.ok ? await run('systemctl', ['--user', 'is-active', NODE_SERVICE]) : restarted;
    if (!active.ok || active.stdout !== 'active') failures.push('恢复中继服务：' + (active.stderr || active.stdout || active.code || 'unknown'));
  }
  return failures;
}

const transactionLimits = { env: 65536, credentials: 4096, gateway: 4096, backup: 131072, unit: 65536, config: 262144, connection: 16384, ca: 262144 };
function transactionPaths(root, configHome) {
  return { ...panelPaths(root), unit: servicePath(configHome), config: pathFor(root, 'frpc.toml'), connection: pathFor(root, 'connection.json'), ca: pathFor(root, 'frps-ca.pem') };
}
function validateTransaction(value) {
  if (!Number.isSafeInteger(value.at) || value.at <= 0 || !value.before || !value.after || typeof value.relay?.active !== 'boolean' || typeof value.relay?.enabled !== 'boolean') throw Error('接入事务无效');
  validateConnection(value.connection);
  if (typeof value.unitPath !== 'string' || !value.unitPath.startsWith('/') || value.unitPath.length > 4096) throw Error('接入中继路径无效');
  for (const side of ['before', 'after']) for (const [key, limit] of Object.entries(transactionLimits)) {
    const text = value[side][key];
    if (text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > limit)) throw Error('接入事务快照无效');
  }
  return value;
}
async function restoreFile(path, before, limit = 262144, expected) {
  const current = await optional(path, limit);
  if (current === before) return;
  if (expected !== undefined && current !== expected) throw Error('配置在接入后被修改，未覆盖：' + path);
  if (before === null) await removeStateFile(path, { expected: current });
  else await writeStateFile(path, before, { expected: current });
}
async function rollbackTransaction(root, value, { run, request, configHome }) {
  const failures = [], paths = transactionPaths(root, configHome);
  if (paths.unit !== value.unitPath) throw Error('恢复的 systemd 目录与接入时不同，未修改');
  try { await releaseCentral(value.connection, centerClient(value.connection.origin, value.after.ca || undefined, request)); }
  catch (error) { failures.push('中心：' + error.message); }
  const remoteFailures = failures.length;
  const stopped = await stopRelay(run);
  if (!stopped.ok) failures.push('无法确认中继已停止');
  if (stopped.ok) {
    for (const [key, limit] of Object.entries(transactionLimits)) {
      try { await restoreFile(paths[key], value.before[key], limit, value.after[key]); }
      catch (error) { failures.push(error.message); }
    }
    if (failures.length === remoteFailures) {
      const panel = await run('systemctl', ['--user', 'restart', 'codex-cloud-panel.service']);
      if (!panel.ok) failures.push('Panel 恢复重启失败');
      const reloaded = await run('systemctl', ['--user', 'daemon-reload']);
      if (!reloaded.ok) failures.push('中继单元恢复失败');
      if (failures.length === remoteFailures) failures.push(...await restoreRelay(value.relay, run));
    }
  }
  return failures;
}

async function releaseCentral(connection, request) {
  const response = await request(connection.origin + '/api/leave', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, slug: connection.slug, credential: connection.credential, nodeId: connection.nodeId }), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok && response.status !== 401) { const value = await response.json().catch(() => ({})); throw Error(value.error || '中心释放节点失败'); }
}

export async function joinNode(options = {}) {
  if (!options.root) throw Error('节点部署目录未配置');
  const lease = await acquireDeploymentLease(options.root);
  try { return await joinNodeLocked(options); } finally { await lease.release(); }
}

async function joinNodeLocked({
  root, server, slug: wantedSlug, mode = 'desktop', panelPort, caFile, replace = false, reauthorize = false, switchExisting = false,
  request = centerRequest, run = command, install = installFrpc, promptKey, configHome,
} = {}) {
  const nodeSlug = slug(wantedSlug), serverOrigin = origin(server), existingText = await optional(pathFor(root, 'connection.json'), 16384);
  let existing = null;
  if (existingText !== null) { try { existing = validateConnection(JSON.parse(existingText)); } catch (error) { throw Error('已有节点接入配置无效，未覆盖：' + error.message); } }
  if (existing && !replace && (existing.origin !== serverOrigin || existing.slug !== nodeSlug)) throw Error('本机已接入其他中心或节点路径；请先 server:leave，或显式使用 --replace');
  if (await readRecovery(root)) throw Error('存在未完成的中继回滚，请先运行 server:leave --recover');
  await preflightPanel(root, switchExisting);
  const same = existing?.origin === serverOrigin && existing.slug === nodeSlug, body = { version: 1, slug: nodeSlug, node: { id: same ? existing.nodeId : randomBytes(16).toString('hex'), mode } };
  const previousRelay = existing ? await relayState(run) : null;
  const replacingRelay = !!previousRelay && !same;
  if (same && !reauthorize) body.credential = existing.credential;
  else { const key = await promptKey?.(); if (!KEY.test(key || '')) throw Error('授权 key 格式无效'); body.key = key; }
  const frpc = await install({ root }), config = pathFor(root, 'frpc.toml'), unit = servicePath(configHome);
  const caPath = pathFor(root, 'frps-ca.pem'), paths = transactionPaths(root, configHome), before = {};
  for (const [name, limit] of Object.entries(transactionLimits)) before[name] = await optional(paths[name], limit);
  // Existing trust belongs to the old origin. Reuse only for that same center.
  const caBytes = caFile ? readCenterCA(caFile) : existing?.origin === serverOrigin ? before.ca : null;
  const client = centerClient(serverOrigin, caBytes || undefined, request);
  const response = await client(serverOrigin + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  let joined;
  try { joined = await response.json(); } catch { throw Error('中心接入响应格式无效'); }
  if (!response.ok) throw Error(joined.error || '中心拒绝节点接入（HTTP ' + response.status + '）');
  const connection = validateConnection({ version: 1, origin: serverOrigin, slug: nodeSlug, name: joined.name, path: joined.entryBasePath, nodeId: body.node.id, mode, credential: joined.credential, proxyHost: joined.proxyHost || joined.frp?.tlsServerName, turnEndpoint: joined.turnEndpoint || null, frp: joined.frp });
  let recoveryText, value;
  try {
    const panel = await planPanel(root, connection, { switchExisting, replace, previousConnection: existing, caFile: caBytes ? caPath : undefined });
    // Recheck panel snapshots captured before contacting the center.
    for (const name of ['env', 'credentials', 'gateway', 'backup']) if (before[name] !== panel.before[name]) throw Error('Panel 配置在接入过程中被修改，未覆盖');
    value = validateTransaction({ version: 2, at: Date.now(), connection, unitPath: unit, relay: previousRelay || { active: false, enabled: false }, before,
      after: { ...panel.after, ca: caBytes, connection: json(connection), config: frpcConfig(connection, { panelPort, caFile: caBytes ? caPath : undefined }), unit: serviceUnit({ frpc, config }) } });
    recoveryText = json(value);
    // writeStateFile enforces the total 256 KiB bound before any configuration mutation.
    await writeStateFile(recoveryPath(root), recoveryText, { expected: null });
  } catch (error) {
    try { await releaseCentral(connection, client); }
    catch (failure) { throw Object.assign(Error(error.message + '；中心释放未确认：' + failure.message), { outcome: 'unknown' }); }
    throw error;
  }
  try {
    if (replacingRelay) {
      const stopped = await stopRelay(run);
      if (!stopped.ok) throw Error('无法停止现有节点中继');
    }
    for (const name of ['ca', 'connection', 'config', 'backup', 'env', 'credentials', 'gateway', 'unit']) {
      if (before[name] !== value.after[name]) await restoreFile(paths[name], value.after[name], transactionLimits[name], before[name]);
    }
    const panel = await run('systemctl', ['--user', 'restart', 'codex-cloud-panel.service']);
    if (!panel.ok) throw Error('Panel 重启失败：' + (panel.stderr || panel.stdout || panel.code));
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', NODE_SERVICE], ['--user', 'restart', NODE_SERVICE]]) {
      const result = await run('systemctl', args); if (!result.ok) throw Error('systemctl 执行失败：' + (result.stderr || result.stdout || result.code || 'unknown'));
    }
    const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]);
    if (!active.ok || active.stdout !== 'active') throw Error('节点中继服务未进入 active 状态');
    const warnings = [], linger = await run('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger', '--value']);
    if (!linger.ok || linger.stdout !== 'yes') {
      const enabled = process.env.USER ? await run('loginctl', ['enable-linger', process.env.USER]) : { ok: false };
      if (!enabled.ok) warnings.push('未能启用 systemd user linger；请由管理员执行 loginctl enable-linger ' + (process.env.USER || '<用户>'));
    }
    await removeStateFile(recoveryPath(root), { expected: recoveryText });
    return { connection, warnings, unit, config, frpc };
  } catch (error) {
    const journalFailures = [];
    try {
      if (await optional(recoveryPath(root), 262144) === null) await writeStateFile(recoveryPath(root), recoveryText, { expected: null });
    } catch (failure) { journalFailures.push('恢复记录：' + failure.message); }
    const failures = [...journalFailures, ...await rollbackTransaction(root, value, { run, request, configHome })];
    if (!failures.length) await removeStateFile(recoveryPath(root), { expected: recoveryText });
    throw Object.assign(Error(error.message + (failures.length ? '；回滚未完全确认（' + failures.join('；') + '），请运行 server:leave --recover' : '；中心授权和本地变更已回滚')), { outcome: failures.length ? 'unknown' : 'rejected' });
  }
}

export async function nodeStatus({ root, run = command } = {}) {
  const connection = await readNodeConnection(root); if (!connection) return { joined: false, service: 'missing' };
  const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]), panel = await run('systemctl', ['--user', 'is-active', 'codex-cloud-panel.service']);
  return { joined: true, origin: connection.origin, slug: connection.slug, path: connection.path, mode: connection.mode, service: active.stdout || 'inactive', panel: panel.stdout || 'inactive' };
}

export async function nodeDoctor({ root, run = command, request = centerRequest, secureHealth = httpsHealth } = {}) {
  const recovery = await readRecovery(root), connection = await readNodeConnection(root);
  if (!connection) return { ok: false, issues: [recovery ? '存在未完成的中继回滚，请运行 server:leave --recover' : '尚未执行 server:join'], warnings: [] };
  const issues = [], warnings = [];
  let ca;
  try {
    const text = await optional(pathFor(root, 'frps-ca.pem'), 256 * 1024);
    if (text !== null) {
      if (text.length < 100 || !text.includes('-----BEGIN CERTIFICATE-----')) throw Error('节点 CA 文件内容无效');
      ca = text;
    }
  } catch (error) { issues.push('节点 CA 文件无效：' + error.message); }
  const health = issues.length ? false : new URL(connection.origin).protocol === 'https:'
    ? await secureHealth(connection.origin, connection.frp.tlsServerName, ca).catch(() => false)
    : await request(connection.origin + '/healthz', { signal: AbortSignal.timeout(5000) }).then(response => response.ok).catch(() => false);
  if (recovery) issues.push('存在未完成的中继回滚，请运行 server:leave --recover');
  if (!health) issues.push('中心健康检查失败');
  const service = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]), panel = await run('systemctl', ['--user', 'is-active', 'codex-cloud-panel.service']);
  if (service.stdout !== 'active') issues.push('中继服务未运行');
  if (panel.stdout !== 'active') issues.push('节点 Panel 未运行');
  const linger = process.env.USER ? await run('loginctl', ['show-user', process.env.USER, '-p', 'Linger', '--value']) : { stdout: '' };
  if (linger.stdout !== 'yes') warnings.push('systemd user linger 未启用');
  return { ok: issues.length === 0, origin: connection.origin, path: connection.path, service: service.stdout || 'inactive', panel: panel.stdout || 'inactive', health, issues, warnings };
}

export async function leaveNode(options = {}) {
  if (!options.root) throw Error('节点部署目录未配置');
  const lease = await acquireDeploymentLease(options.root);
  try { return await (options.recover ? recoverNodeLocked(options) : leaveNodeLocked(options)); } finally { await lease.release(); }
}

async function recoverNodeLocked({ root, request = centerRequest, run = command, configHome } = {}) {
  const recovery = await readRecovery(root);
  if (!recovery) throw Error('没有待恢复的节点接入记录');
  const value = recovery.value;
  if (value.version === 2) {
    const failures = await rollbackTransaction(root, value, { run, request, configHome });
    if (failures.length) throw Error('恢复未完成：' + failures.join('；'));
    await removeStateFile(recoveryPath(root), { expected: recovery.text });
    return { recovered: true, origin: value.connection.origin, slug: value.connection.slug };
  }
  const stopped = await stopRelay(run);
  if (!stopped.ok) throw Error('无法确认节点中继已停止，恢复记录已保留：' + (stopped.stderr || stopped.stdout || stopped.code || 'unknown'));
  await releaseCentral(value.connection, centerClient(value.connection.origin, value.before.ca || undefined, request));
  await restorePanel(root, { run });
  const targets = [
    [servicePath(configHome), value.before.unit, 65536],
    [pathFor(root, 'frpc.toml'), value.before.config, 262144],
    [pathFor(root, 'connection.json'), value.before.connection, 16384],
    [pathFor(root, 'frps-ca.pem'), value.before.ca, 262144],
  ];
  for (const [path, text, limit] of targets) await restoreFile(path, text, limit);
  await removeStateFile(recoveryPath(root), { expected: recovery.text });
  return { recovered: true, origin: value.connection.origin, slug: value.connection.slug };
}

async function leaveNodeLocked({ root, request = centerRequest, run = command, configHome } = {}) {
  if (await readRecovery(root)) throw Error('存在未完成的接入，请运行 server:leave --recover');
  const connection = await readNodeConnection(root); if (!connection) throw Error('本机尚未接入自建中心');
  const stopped = await stopRelay(run);
  if (!stopped.ok) throw Error('无法确认节点中继已停止，本机接入配置已保留：' + (stopped.stderr || stopped.stdout || stopped.code || 'unknown'));
  const client = centerClient(connection.origin, await optional(pathFor(root, 'frps-ca.pem'), 262144) || undefined, request);
  const response = await client(connection.origin + '/api/leave', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, slug: connection.slug, credential: connection.credential, nodeId: connection.nodeId }), redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (response && !response.ok && response.status !== 401) { const value = await response.json().catch(() => ({})); throw Error(value.error || '中心释放节点失败'); }
  await restorePanel(root, { run });
  const unit = servicePath(configHome), unitText = await optional(unit, 65536); if (unitText !== null) await removeStateFile(unit, { expected: unitText });
  for (const name of ['connection.json', 'frpc.toml', 'frps-ca.pem']) { const path = pathFor(root, name), text = await optional(path, 262144); if (text !== null) await removeStateFile(path, { expected: text }); }
  return { left: true, origin: connection.origin, slug: connection.slug, warning: !response ? '中心网络不可达；本地中继已停止并清理，中心租约会按超时释放' : response.status === 401 ? '中心认为节点已经离线；本地配置已清理' : '' };
}
