import { centerRequest } from '../panel/center-http.mjs';
import { queryEnrollment } from './enrollment.mjs';
import { optional, pathFor, readNodeConnection, readRecovery } from './node-state.mjs';
import { command, NODE_SERVICE, relayDetails } from './node-service.mjs';
import { centerHealthStatus, httpsHealth, nodeEntryStatus } from './node-health.mjs';
import { readNodeDiagnostics } from './node-operation.mjs';

export async function nodeStatus({ root, run = command } = {}) {
  const diagnostics = await readNodeDiagnostics(root), connection = await readNodeConnection(root); if (!connection) return { joined: false, service: 'missing', diagnostics };
  const active = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]), panel = await run('systemctl', ['--user', 'is-active', 'codex-cloud-panel.service']);
  return { joined: true, origin: connection.origin, slug: connection.slug, path: connection.path, mode: connection.mode, service: active.stdout || 'inactive', panel: panel.stdout || 'inactive', diagnostics, relay: await relayDetails(run) };
}

export async function nodeDoctor({ root, run = command, request = centerRequest, secureHealth = httpsHealth, resolve = false } = {}) {
  const diagnostics = await readNodeDiagnostics(root); let recovery, connection;
  try { recovery = await readRecovery(root); connection = await readNodeConnection(root); }
  catch { return { ok: false, reason: 'configuration_invalid', diagnostics, issues: ['节点接入配置或恢复记录无法读取，请检查文件权限、大小和格式'], warnings: [] }; }
  if ([3, 4].includes(recovery?.value.version)) {
    const { target, credential, keepConnection } = recovery.value;
    let result;
    if (resolve && !credential && !keepConnection) {
      try { result = await queryEnrollment(recovery.value, { request }); }
      catch { result = { state: 'unknown', reason: 'query_failed' }; }
    }
    return { ok: false, origin: target.origin, path: target.path, nodeId: target.nodeId, diagnostics,
      ...(recovery.value.operation ? { operationId: recovery.value.operation.id } : {}),
      ...(result ? { enrollment: { state: result.state, ...(result.reason ? { reason: result.reason } : {}) } } : {}),
      issues: [credential || keepConnection || result?.state === 'accepted'
      ? '存在未完成的中心接入，请运行 server:leave --recover；本地配置尚未改写'
      : '中心接入结果未确认且尚无凭据；可运行 server:doctor --resolve 查询，或请管理员核对状态；恢复记录已保留，未重发接入请求'], warnings: [] };
  }
  if (!connection) return { ok: false, diagnostics, issues: [recovery ? '存在未完成的中继回滚，请运行 server:leave --recover' : '尚未执行 server:join'], warnings: [] };
  const issues = [], warnings = [];
  if (!diagnostics.available) warnings.push('节点诊断状态无法读取，未包含私有文件内容');
  let ca;
  try {
    const text = await optional(pathFor(root, 'frps-ca.pem'), 256 * 1024);
    if (text !== null) {
      if (text.length < 100 || !text.includes('-----BEGIN CERTIFICATE-----')) throw Error('节点 CA 文件内容无效');
      ca = text;
    }
  } catch { issues.push('节点 CA 文件无效，请检查文件权限、大小和 PEM 内容'); }
  const center = issues.length ? { ok: false, reason: 'ca_invalid' } : secureHealth === httpsHealth
    ? await centerHealthStatus(connection.origin, { request, ca })
    : { ok: await secureHealth(connection.origin, connection.frp.tlsServerName, ca).catch(() => false) };
  const health = center.ok;
  if (recovery) issues.push('存在未完成的中继回滚，请运行 server:leave --recover');
  if (!health) issues.push('中心健康检查失败');
  const entry = health ? await nodeEntryStatus(connection, { request, ca }) : { ok: false, reason: 'center_unavailable' }, entryReady = entry.ok;
  if (!entryReady) issues.push('节点入口尚未就绪或节点身份不匹配，请检查 frpc 到中心 7000 端口及节点任务/文件服务');
  const service = await run('systemctl', ['--user', 'is-active', NODE_SERVICE]), panel = await run('systemctl', ['--user', 'is-active', 'codex-cloud-panel.service']);
  if (service.stdout !== 'active') issues.push('中继服务未运行');
  if (panel.stdout !== 'active') issues.push('节点 Panel 未运行');
  const linger = process.env.USER ? await run('loginctl', ['show-user', process.env.USER, '-p', 'Linger', '--value']) : { stdout: '' };
  if (linger.stdout !== 'yes') warnings.push('systemd user linger 未启用');
  return { ok: issues.length === 0, origin: connection.origin, path: connection.path, service: service.stdout || 'inactive', panel: panel.stdout || 'inactive', health, entryReady, checks: { center, entry }, diagnostics, relay: await relayDetails(run), issues, warnings };
}
