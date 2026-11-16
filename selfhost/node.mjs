import { randomBytes } from 'node:crypto';
import { centerClient, centerRequest, readCenterCA } from '../panel/center-http.mjs';
import { removeStateFile, writeStateFile } from '../scripts/state-files.mjs';
import { acquireDeploymentLease } from '../scripts/deployment-lease.mjs';
import { installFrpc } from './frpc.mjs';
import { queryEnrollment } from './enrollment.mjs';
import { CREDENTIAL, KEY, entryBasePath, randomToken, slug } from './protocol.mjs';
import { command, NODE_SERVICE, relayState, servicePath, serviceUnit, stopRelay } from './node-service.mjs';
import { nodeEntryReady } from './node-health.mjs';
import { trackNodeOperation } from './node-operation.mjs';
import {
  json, optional, origin, pathFor, planPanel, planPanelRestore, preflightPanel, readNodeConnection, readRecovery,
  recoveryPath, releaseCentral, restoreFile, restorePanel, rollbackTransaction, transactionLimits, transactionPaths, validateConnection, validateRecovery, validateTransaction,
} from './node-state.mjs';

export { NODE_SERVICE, serviceUnit, readNodeConnection, nodeEntryReady };
export { nodeStatus, nodeDoctor } from './node-diagnostics.mjs';
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

export async function joinNode(options = {}) {
  if (!options.root) throw Error('节点部署目录未配置');
  const lease = await acquireDeploymentLease(options.root);
  try { return await trackNodeOperation(options.root, 'join', report => joinNodeLocked({ ...options, report })); } finally { await lease.release(); }
}

async function joinNodeLocked({
  root, server, slug: wantedSlug, mode = 'desktop', panelPort, caFile, replace = false, reauthorize = false, switchExisting = false,
  request = centerRequest, run = command, install = installFrpc, promptKey, configHome, report,
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
  else {
    const key = await promptKey?.(); if (!KEY.test(key || '')) throw Error('授权 key 格式无效'); body.key = key;
    body.operation = { id: randomBytes(16).toString('hex'), proof: randomToken('cocj_') };
  }
  await report('preparing');
  const frpc = await install({ root }), config = pathFor(root, 'frpc.toml'), unit = servicePath(configHome);
  const caPath = pathFor(root, 'frps-ca.pem'), paths = transactionPaths(root, configHome), before = {};
  for (const [name, limit] of Object.entries(transactionLimits)) before[name] = await optional(paths[name], limit);
  // Existing trust belongs to the old origin. Reuse only for that same center.
  const caBytes = caFile ? readCenterCA(caFile) : existing?.origin === serverOrigin ? before.ca : null;
  const client = centerClient(serverOrigin, caBytes || undefined, request);
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535 || !['desktop', 'terminal'].includes(mode)) throw Error('本机面板端口或节点模式无效');
  const target = { origin: serverOrigin, slug: nodeSlug, nodeId: body.node.id, path: entryBasePath(nodeSlug) };
  const panelOptions = { switchExisting, replace, previousConnection: existing, caFile: caBytes ? caPath : undefined };
  // Validate local conflicts and unit paths before creating a central lease.
  const preparedPanel = await planPanel(root, target, panelOptions);
  for (const name of ['env', 'credentials', 'gateway', 'backup']) if (before[name] !== preparedPanel.before[name]) throw Error('Panel 配置在接入过程中被修改，未覆盖');
  const unitText = serviceUnit({ frpc, config });
  const intent = validateRecovery({ version: 4, at: Date.now(), target, mode, credential: null, ca: caBytes, keepConnection: !!body.credential, operation: body.operation || null });
  let intentText = json(intent);
  // One private, <=256 KiB journal covers even a lost/malformed HTTP response.
  await writeStateFile(recoveryPath(root), intentText, { expected: null });
  await report('enrolling');
  let connection;
  try {
    let response;
    try { response = await client(serverOrigin + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch (error) {
      if (error.outcome === 'rejected') await removeStateFile(recoveryPath(root), { expected: intentText });
      throw error;
    }
    let joined;
    try { joined = await response.json(); } catch { throw Error('中心接入响应格式无效'); }
    if (!response.ok) {
      // Only explicit pre-commit rejection proves that no enrollment occurred.
      if (joined?.outcome === 'rejected') await removeStateFile(recoveryPath(root), { expected: intentText });
      throw Object.assign(Error(joined?.error || '中心拒绝节点接入（HTTP ' + response.status + '）'), { status: response.status });
    }
    if (!joined || typeof joined.credential !== 'string' || !CREDENTIAL.test(joined.credential)) throw Error('中心接入响应缺少有效凭据');
    intent.credential = joined.credential;
    const acceptedText = json(intent);
    await writeStateFile(recoveryPath(root), acceptedText, { expected: intentText, committed: () => { intentText = acceptedText; } });
    connection = validateConnection({ version: 1, ...target, path: joined.entryBasePath, name: joined.name, mode, credential: joined.credential, proxyHost: joined.proxyHost || joined.frp?.tlsServerName, turnEndpoint: joined.turnEndpoint || null, frp: joined.frp });
  } catch (error) {
    // No local configuration/service has changed. Preserve an unknown receipt;
    // never replay the join or stop the previous node to recover this stage.
    if (await optional(recoveryPath(root), 262144) !== null) {
      throw Object.assign(Error(error.message + '；接入结果未确认，恢复记录已保留，请运行 server:doctor', { cause: error }), { outcome: 'unknown', status: error.status });
    }
    throw error;
  }
  let recoveryText, value;
  try {
    const panel = await planPanel(root, connection, panelOptions);
    // Recheck panel snapshots captured before contacting the center.
    for (const name of ['env', 'credentials', 'gateway', 'backup']) if (before[name] !== panel.before[name]) throw Error('Panel 配置在接入过程中被修改，未覆盖');
    value = validateTransaction({ version: 2, at: Date.now(), connection, unitPath: unit, relay: previousRelay || { active: false, enabled: false }, before,
      after: { ...panel.after, ca: caBytes, connection: json(connection), config: frpcConfig(connection, { panelPort, caFile: caBytes ? caPath : undefined }), unit: unitText } });
    recoveryText = json(value);
    // writeStateFile enforces the total 256 KiB bound before any configuration mutation.
    await writeStateFile(recoveryPath(root), recoveryText, { expected: intentText });
  } catch (error) {
    try {
      if (!intent.keepConnection) await releaseCentral(connection, client);
      await removeStateFile(recoveryPath(root), { expected: intentText });
    }
    catch (failure) { throw Object.assign(Error(error.message + '；中心释放未确认：' + failure.message), { outcome: 'unknown' }); }
    throw error;
  }
  try {
    await report('applying');
    if (replacingRelay) {
      const stopped = await stopRelay(run);
      if (!stopped.ok) throw Error('无法停止现有节点中继');
    }
    for (const name of ['ca', 'connection', 'config', 'backup', 'env', 'credentials', 'gateway', 'unit']) {
      if (before[name] !== value.after[name]) await restoreFile(paths[name], value.after[name], transactionLimits[name], before[name]);
    }
    await report('starting');
    const panel = await run('systemctl', ['--user', 'restart', 'codex-cloud-panel.service']);
    if (!panel.ok) throw Error('Panel 重启失败：' + (panel.stderr || panel.stdout || panel.code));
    for (const args of [['--user', 'daemon-reload'], ['--user', 'reset-failed', NODE_SERVICE], ['--user', 'enable', NODE_SERVICE], ['--user', 'restart', NODE_SERVICE]]) {
      // On first installation systemd may not have loaded this unit yet.
      // Clearing old failure counters is best-effort; enable/restart must pass.
      const result = await run('systemctl', args); if (!result.ok && args[1] !== 'reset-failed') throw Error('systemctl 执行失败：' + (result.stderr || result.stdout || result.code || 'unknown'));
    }
    const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]);
    if (!active.ok || active.stdout !== 'active') throw Error('节点中继服务未进入 active 状态');
    const warnings = [], linger = await run('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger', '--value']);
    if (!linger.ok || linger.stdout !== 'yes') {
      const enabled = process.env.USER ? await run('loginctl', ['enable-linger', process.env.USER]) : { ok: false };
      if (!enabled.ok) warnings.push('未能启用 systemd user linger；请由管理员执行 loginctl enable-linger ' + (process.env.USER || '<用户>'));
    }
    await report('verifying');
    const entryReady = await nodeEntryReady(connection, { request, ca: caBytes || undefined });
    if (!entryReady) warnings.push('中继进程已启动，节点入口尚未就绪；请稍后运行 npm run server:doctor 检查隧道、节点身份及任务/文件服务');
    await removeStateFile(recoveryPath(root), { expected: recoveryText });
    return { connection, warnings, entryReady, unit, config, frpc };
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

export async function leaveNode(options = {}) {
  if (!options.root) throw Error('节点部署目录未配置');
  const lease = await acquireDeploymentLease(options.root);
  try { return await trackNodeOperation(options.root, options.recover ? 'recover' : 'leave', report => options.recover ? recoverNodeLocked({ ...options, report }) : leaveNodeLocked({ ...options, report })); } finally { await lease.release(); }
}

async function recoverNodeLocked({ root, request = centerRequest, run = command, configHome, report } = {}) {
  let recovery = await readRecovery(root);
  if (!recovery) throw Error('没有待恢复的节点接入记录');
  let value = recovery.value;
  if ([3, 4].includes(value.version)) {
    if (!value.keepConnection) {
      if (!value.credential) {
        await report('resolving');
        const result = await queryEnrollment(value, { request });
        if (result.state !== 'accepted') throw Error('中心接入结果未确认且尚无凭据；请管理员核对节点状态，恢复记录已保留');
        value = { ...value, credential: result.credential };
        const text = json(value); await writeStateFile(recoveryPath(root), text, { expected: recovery.text }); recovery = { value, text };
      }
      await report('releasing');
      await releaseCentral({ ...value.target, credential: value.credential }, centerClient(value.target.origin, value.ca || undefined, request));
    }
    await removeStateFile(recoveryPath(root), { expected: recovery.text });
    return { recovered: true, origin: value.target.origin, slug: value.target.slug };
  }
  if (value.version === 2) {
    await report('restoring');
    const failures = await rollbackTransaction(root, value, { run, request, configHome });
    if (failures.length) throw Error('恢复未完成：' + failures.join('；'));
    await removeStateFile(recoveryPath(root), { expected: recovery.text });
    return { recovered: true, origin: value.connection.origin, slug: value.connection.slug };
  }
  const panelPlan = await planPanelRestore(root);
  await report('stopping');
  const stopped = await stopRelay(run);
  if (!stopped.ok) throw Error('无法确认节点中继已停止，恢复记录已保留：' + (stopped.stderr || stopped.stdout || stopped.code || 'unknown'));
  await report('releasing');
  await releaseCentral(value.connection, centerClient(value.connection.origin, value.before.ca || undefined, request));
  await report('restoring');
  await restorePanel(root, { run, plan: panelPlan });
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

async function leaveNodeLocked({ root, request = centerRequest, run = command, configHome, report } = {}) {
  if (await readRecovery(root)) throw Error('存在未完成的接入，请运行 server:leave --recover');
  const connection = await readNodeConnection(root); if (!connection) throw Error('本机尚未接入自建中心');
  const panelPlan = await planPanelRestore(root);
  await report('stopping');
  const stopped = await stopRelay(run);
  if (!stopped.ok) throw Error('无法确认节点中继已停止，本机接入配置已保留：' + (stopped.stderr || stopped.stdout || stopped.code || 'unknown'));
  await report('releasing');
  const client = centerClient(connection.origin, await optional(pathFor(root, 'frps-ca.pem'), 262144) || undefined, request);
  const response = await client(connection.origin + '/api/leave', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, slug: connection.slug, credential: connection.credential, nodeId: connection.nodeId }), redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (response && !response.ok && response.status !== 401) { const value = await response.json().catch(() => ({})); throw Error(value.error || '中心释放节点失败'); }
  await report('restoring');
  await restorePanel(root, { run, plan: panelPlan });
  const unit = servicePath(configHome), unitText = await optional(unit, 65536); if (unitText !== null) await removeStateFile(unit, { expected: unitText });
  for (const name of ['connection.json', 'frpc.toml', 'frps-ca.pem']) { const path = pathFor(root, name), text = await optional(path, 262144); if (text !== null) await removeStateFile(path, { expected: text }); }
  return { left: true, origin: connection.origin, slug: connection.slug, warning: !response ? '中心网络不可达；本地中继已停止并清理，中心租约会按超时释放' : response.status === 401 ? '中心认为节点已经离线；本地配置已清理' : '' };
}
