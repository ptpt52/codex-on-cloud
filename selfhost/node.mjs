import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readStateFile, removeStateFile, writeStateFile } from '../scripts/state-files.mjs';
import { installFrpc } from './frpc.mjs';
import { CREDENTIAL, KEY, NODE_ID, SELFHOST_LIMITS, entryBasePath, slug } from './protocol.mjs';

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

export async function readNodeConnection(root) {
  const text = await optional(pathFor(root, 'connection.json'), 16384);
  if (text === null) return null;
  try { return validateConnection(JSON.parse(text)); } catch (error) { throw Error('节点接入配置无法读取：' + error.message, { cause: error }); }
}

function servicePath(configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')) {
  return join(configHome, 'systemd', 'user', NODE_SERVICE);
}

export async function joinNode({
  root, server, slug: wantedSlug, mode = 'desktop', panelPort, caFile, replace = false,
  request = fetch, run = command, install = installFrpc, promptKey, configHome,
} = {}) {
  const nodeSlug = slug(wantedSlug), serverOrigin = origin(server), existingText = await optional(pathFor(root, 'connection.json'), 16384);
  let existing = null;
  if (existingText !== null) { try { existing = validateConnection(JSON.parse(existingText)); } catch (error) { throw Error('已有节点接入配置无效，未覆盖：' + error.message); } }
  if (existing && !replace && (existing.origin !== serverOrigin || existing.slug !== nodeSlug)) throw Error('本机已接入其他中心或节点路径；请先 server:leave，或显式使用 --replace');
  const same = existing?.origin === serverOrigin && existing.slug === nodeSlug, body = { version: 1, slug: nodeSlug, node: { id: same ? existing.nodeId : randomBytes(16).toString('hex'), mode } };
  if (same) body.credential = existing.credential;
  else { const key = await promptKey?.(); if (!KEY.test(key || '')) throw Error('授权 key 格式无效'); body.key = key; }
  const response = await request(serverOrigin + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  let joined;
  try { joined = await response.json(); } catch { throw Error('中心接入响应格式无效'); }
  if (!response.ok) throw Error(joined.error || '中心拒绝节点接入（HTTP ' + response.status + '）');
  const connection = validateConnection({ version: 1, origin: serverOrigin, slug: nodeSlug, name: joined.name, path: joined.entryBasePath, nodeId: body.node.id, mode, credential: joined.credential, proxyHost: joined.proxyHost || joined.frp?.tlsServerName, turnEndpoint: joined.turnEndpoint || null, frp: joined.frp });
  if (connection.path !== entryBasePath(nodeSlug) || !/^cocn_[A-Za-z0-9_-]{43}$/.test(connection.credential)) throw Error('中心接入响应与节点身份不一致');

  const frpc = await install({ root }), config = pathFor(root, 'frpc.toml'), unit = servicePath(configHome);
  let caPath;
  if (caFile) {
    const bytes = await readFile(caFile);
    if (bytes.length < 100 || bytes.length > 256 * 1024) throw Error('CA 文件大小无效');
    caPath = pathFor(root, 'frps-ca.pem');
    await mkdir(pathFor(root, ''), { recursive: true, mode: 0o700 });
    await writeStateFile(caPath, bytes.toString(), { expected: await optional(caPath, 256 * 1024) });
  }
  await mkdir(pathFor(root, ''), { recursive: true, mode: 0o700 });
  await writeStateFile(pathFor(root, 'connection.json'), json(connection), { expected: existingText });
  await writeStateFile(config, frpcConfig(connection, { panelPort, caFile: caPath }), { expected: await optional(config, 262144) });
  await mkdir(join(unit, '..'), { recursive: true, mode: 0o700 });
  await writeStateFile(unit, serviceUnit({ frpc, config }), { expected: await optional(unit, 65536) });

  const warnings = [];
  for (const [tool, args] of [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', NODE_SERVICE]]]) {
    const result = await run(tool, args); if (!result.ok) throw Error(tool + ' 执行失败：' + (result.stderr || result.stdout || result.code || 'unknown'));
  }
  const linger = await run('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger', '--value']);
  if (!linger.ok || linger.stdout !== 'yes') {
    const enabled = process.env.USER ? await run('loginctl', ['enable-linger', process.env.USER]) : { ok: false };
    if (!enabled.ok) warnings.push('未能启用 systemd user linger；SSH 全退出后中继可能停止，请由管理员执行 loginctl enable-linger ' + (process.env.USER || '<用户>'));
  }
  return { connection, warnings, unit, config, frpc };
}

export async function nodeStatus({ root, run = command } = {}) {
  const connection = await readNodeConnection(root); if (!connection) return { joined: false, service: 'missing' };
  const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]);
  return { joined: true, origin: connection.origin, slug: connection.slug, path: connection.path, mode: connection.mode, service: active.stdout || 'inactive' };
}

export async function nodeDoctor({ root, run = command, request = fetch } = {}) {
  const connection = await readNodeConnection(root); if (!connection) return { ok: false, issues: ['尚未执行 server:join'], warnings: [] };
  const issues = [], warnings = [], health = await request(connection.origin + '/healthz', { signal: AbortSignal.timeout(5000) }).then(response => response.ok).catch(() => false);
  if (!health) issues.push('中心健康检查失败');
  const service = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]); if (service.stdout !== 'active') issues.push('中继服务未运行');
  const linger = process.env.USER ? await run('loginctl', ['show-user', process.env.USER, '-p', 'Linger', '--value']) : { stdout: '' };
  if (linger.stdout !== 'yes') warnings.push('systemd user linger 未启用');
  return { ok: issues.length === 0, origin: connection.origin, path: connection.path, service: service.stdout || 'inactive', health, issues, warnings };
}

export async function leaveNode({ root, request = fetch, run = command, configHome } = {}) {
  const connection = await readNodeConnection(root); if (!connection) throw Error('本机尚未接入自建中心');
  const response = await request(connection.origin + '/api/leave', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, slug: connection.slug, credential: connection.credential, nodeId: connection.nodeId }), redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (response && !response.ok && response.status !== 401) { const value = await response.json().catch(() => ({})); throw Error(value.error || '中心释放节点失败'); }
  await run('systemctl', ['--user', 'disable', '--now', NODE_SERVICE]);
  const unit = servicePath(configHome), unitText = await optional(unit, 65536); if (unitText !== null) await removeStateFile(unit, { expected: unitText });
  for (const name of ['connection.json', 'frpc.toml', 'frps-ca.pem']) { const path = pathFor(root, name), text = await optional(path, 262144); if (text !== null) await removeStateFile(path, { expected: text }); }
  return { left: true, origin: connection.origin, slug: connection.slug, warning: response?.status === 401 ? '中心认为节点已经离线；本地配置已清理' : '' };
}
