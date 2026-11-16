import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { centerClient } from '../panel/center-http.mjs';
import { readStateFile, removeStateFile, writeStateFile } from '../scripts/state-files.mjs';
import { isLoopbackHostname } from './client-address.mjs';
import { mergeCredentials, mergeEnvironment } from './config-merge.mjs';
import { CREDENTIAL, NODE_ID, SLUG, enrollmentOperation, entryBasePath } from './protocol.mjs';
import { command, restoreRelay, servicePath, stopRelay } from './node-service.mjs';

export function origin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('中心服务器地址必须是 HTTP(S) 根地址');
  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) throw Error('远程节点必须使用 HTTPS 中心服务器');
  return url.origin;
}

export function validateConnection(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'origin', 'slug', 'name', 'path', 'nodeId', 'mode', 'credential', 'proxyHost', 'turnEndpoint', 'frp'].includes(key))) throw Error('节点接入配置格式无效');
  if (!equalsOrigin(value.origin) || !NODE_ID.test(value.nodeId) || !CREDENTIAL.test(value.credential) || !['desktop', 'terminal'].includes(value.mode) || value.path !== entryBasePath(value.slug)) throw Error('节点接入配置身份无效');
  if (value.turnEndpoint !== undefined && value.turnEndpoint !== null && value.turnEndpoint !== value.origin + '/api/turn-credentials') throw Error('节点 TURN 地址必须属于接入中心');
  if (!value.frp || typeof value.frp.serverAddr !== 'string' || !value.frp.serverAddr || value.frp.serverAddr.length > 255 || !Number.isInteger(value.frp.serverPort) || value.frp.serverPort < 1 || value.frp.serverPort > 65535 || typeof value.frp.tlsServerName !== 'string' || !value.frp.tlsServerName || typeof value.frp.token !== 'string' || value.frp.token.length < 16 || value.frp.token.length > 512 || typeof value.proxyHost !== 'string' && typeof value.proxyHost !== 'undefined') throw Error('节点 frp 配置无效');
  return value;
}
const equalsOrigin = value => { try { return origin(value) === value; } catch { return false; } };
export const pathFor = (root, name) => join(root, 'data', 'selfhost-node', name);
export const json = value => JSON.stringify(value, null, 2) + '\n';
export async function optional(path, limit = 16384) { try { return await readStateFile(path, limit, true); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

function panelEnvironment(before, connection, caFile) {
  const values = { PUBLIC_ORIGIN: connection.origin, ENTRY_BASE_PATH: connection.path, SELFHOST_NODE_CONFIG_FILE: './data/selfhost-node/connection.json', SHARED_ENTRY: '0', NODE_ID: connection.nodeId, SELFHOST_CA_FILE: caFile ? './data/selfhost-node/frps-ca.pem' : '' };
  for (const value of Object.values(values)) if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw Error('Panel 环境配置值无效');
  const text = mergeEnvironment(before, before, Object.entries(values).map(([key, value]) => key + '=' + value + '\n').join(''));
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

export const recoveryPath = root => pathFor(root, 'join-recovery.json');

export function validateRecovery(value) {
  if ([3, 4].includes(value?.version)) {
    if (!Number.isSafeInteger(value.at) || value.at <= 0 || !validPanelTarget(value.target) ||
      value.credential !== null && (typeof value.credential !== 'string' || !CREDENTIAL.test(value.credential)) ||
      value.ca !== null && (typeof value.ca !== 'string' || Buffer.byteLength(value.ca) > 262144) || typeof value.keepConnection !== 'boolean') throw Error('节点接入意图无效');
    if (value.version === 4 && value.operation !== null) enrollmentOperation(value.operation);
    if (value.mode !== undefined && !['desktop', 'terminal'].includes(value.mode)) throw Error('节点接入意图模式无效');
    return value;
  }
  if (value?.version === 2) return validateTransaction(value);
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.at) || value.at <= 0 || typeof value.error !== 'string' || value.error.length > 2048 || !value.before || typeof value.before !== 'object' || Array.isArray(value.before)) throw Error('节点接入恢复记录无效');
  const connection = validateConnection(value.connection);
  for (const key of ['connection', 'config', 'unit', 'ca']) if (value.before[key] !== null && (typeof value.before[key] !== 'string' || Buffer.byteLength(value.before[key]) > 262144)) throw Error('节点接入恢复文件快照无效');
  return { version: 1, at: value.at, error: value.error, connection, before: { connection: value.before.connection, config: value.before.config, unit: value.before.unit, ca: value.before.ca } };
}

export async function readRecovery(root) {
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

export async function planPanel(root, connection, { switchExisting = false, replace = false, previousConnection, caFile } = {}) {
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
  const desiredEnvAfter = mergeEnvironment(current.env, previousEnvAfter, panelEnvironment(backup.envBefore, connection, caFile), [backup.envBefore]);
  const desiredCredentialsAfter = backup.credentialsBefore?.replace(/^工作台：.*$/m, '工作台：' + connection.origin) ?? null;
  const envBefore = mergeEnvironment(current.env, previousEnvAfter, backup.envBefore, [desiredEnvAfter]);
  const credentialsBefore = mergeCredentials(current.credentials, previousCredentialsAfter, backup.credentialsBefore, [desiredCredentialsAfter]);
  const credentialsAfter = mergeCredentials(current.credentials, previousCredentialsAfter, desiredCredentialsAfter, [backup.credentialsBefore]);
  if (backup.target.origin !== desiredTarget.origin || backup.target.slug !== desiredTarget.slug || backup.target.nodeId !== desiredTarget.nodeId || backup.target.path !== desiredTarget.path || backup.envAfter !== desiredEnvAfter || backup.credentialsAfter !== desiredCredentialsAfter) backupChanged = true;
  if (backup.envBefore !== envBefore || backup.credentialsBefore !== credentialsBefore || backup.credentialsAfter !== credentialsAfter) backupChanged = true;
  backup = { ...backup, target: desiredTarget, envBefore, envAfter: desiredEnvAfter, credentialsBefore, credentialsAfter };
  if (Buffer.byteLength(json(backup)) > 131072) throw Error('Panel 切换备份超过 128 KiB，未修改');
  return {
    before: { env: current.env, credentials: current.credentials, gateway: current.gatewayBefore, backup: backupText },
    after: { env: backup.envAfter, credentials: backup.credentialsAfter, gateway: null, backup: backupChanged ? json(backup) : backupText },
  };
}

export async function preflightPanel(root, switchExisting) {
  await panelState(root);
  if (await optional(panelPaths(root).backup, 131072) !== null) return;
  const publication = await publicationState(root);
  if (publication && !switchExisting) throw Error('检测到现有 Cloudflare/Gateway 发布状态；如需接管，请显式使用 --switch-existing。普通 server:leave 会恢复原配置');
}

export async function planPanelRestore(root) {
  const paths = panelPaths(root), backupText = await optional(paths.backup, 131072);
  if (backupText === null) return { paths, backupText, files: [] };
  let backup; try { backup = JSON.parse(backupText); } catch { throw Error('Panel 切换备份损坏，未恢复'); }
  if (!backup || ![1, 2].includes(backup.version) || ['envBefore', 'envAfter'].some(key => typeof backup[key] !== 'string' || Buffer.byteLength(backup[key]) > 65536) ||
    ['credentialsBefore', 'credentialsAfter', 'gatewayBefore'].some(key => backup[key] !== null && (typeof backup[key] !== 'string' || Buffer.byteLength(backup[key]) > 4096))) throw Error('Panel 切换备份内容无效，未恢复');
  const [currentEnv, currentCredentials, currentGateway] = await Promise.all([optional(paths.env, 65536), optional(paths.credentials, 4096), optional(paths.gateway, 4096)]);
  const restoredEnv = currentEnv === null ? backup.envBefore : mergeEnvironment(currentEnv, backup.envAfter, backup.envBefore);
  const restoredCredentials = currentCredentials === null ? backup.credentialsBefore : mergeCredentials(currentCredentials, backup.credentialsAfter, backup.credentialsBefore);
  if (currentGateway !== null && currentGateway !== backup.gatewayBefore) throw Error('Gateway 配置在自建接入后被修改，未覆盖');
  return { paths, backupText, files: [
    { path: paths.env, expected: currentEnv, restore: restoredEnv, limit: 65536 },
    { path: paths.credentials, expected: currentCredentials, restore: restoredCredentials, limit: 4096 },
    { path: paths.gateway, expected: currentGateway, restore: backup.gatewayBefore, limit: 4096 },
  ] };
}

export async function restorePanel(root, { run = command, plan } = {}) {
  plan ??= await planPanelRestore(root);
  // Revalidate the complete preflight after stopping/contacting the center,
  // before writing any file. Each atomic write also checks its own snapshot.
  const { paths, backupText, files } = plan;
  if (await optional(paths.backup, 131072) !== backupText) throw Error('Panel 切换备份在退出过程中被修改，未恢复');
  for (const file of files) if (await optional(file.path, file.limit) !== file.expected) throw Error('Panel 配置在退出过程中被修改，未覆盖');
  if (backupText === null) return false;
  for (const file of files) {
    if (file.restore !== null && file.expected !== file.restore) await writeStateFile(file.path, file.restore, { expected: file.expected });
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

export const transactionLimits = { env: 65536, credentials: 4096, gateway: 4096, backup: 131072, unit: 65536, config: 262144, connection: 16384, ca: 262144 };
export function transactionPaths(root, configHome) {
  return { ...panelPaths(root), unit: servicePath(configHome), config: pathFor(root, 'frpc.toml'), connection: pathFor(root, 'connection.json'), ca: pathFor(root, 'frps-ca.pem') };
}
export function validateTransaction(value) {
  if (!Number.isSafeInteger(value.at) || value.at <= 0 || !value.before || !value.after || typeof value.relay?.active !== 'boolean' || typeof value.relay?.enabled !== 'boolean') throw Error('接入事务无效');
  validateConnection(value.connection);
  if (typeof value.unitPath !== 'string' || !value.unitPath.startsWith('/') || value.unitPath.length > 4096) throw Error('接入中继路径无效');
  for (const side of ['before', 'after']) for (const [key, limit] of Object.entries(transactionLimits)) {
    const text = value[side][key];
    if (text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > limit)) throw Error('接入事务快照无效');
  }
  return value;
}
export async function restoreFile(path, before, limit = 262144, expected) {
  const current = await optional(path, limit);
  if (current === before) return;
  if (expected !== undefined && current !== expected) throw Error('配置在接入后被修改，未覆盖：' + path);
  if (before === null) await removeStateFile(path, { expected: current });
  else await writeStateFile(path, before, { expected: current });
}
export async function rollbackTransaction(root, value, { run, request, configHome }) {
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

export async function releaseCentral(connection, request) {
  const response = await request(connection.origin + '/api/leave', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, slug: connection.slug, credential: connection.credential, nodeId: connection.nodeId }), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok && response.status !== 401) { const value = await response.json().catch(() => ({})); throw Error(value.error || '中心释放节点失败'); }
}
