import net from 'node:net';
import { serialConfig } from './serial-config.mjs';
import { rtcHints } from './public/rtc-hints.js';
const fail = (status, message) => Object.assign(new Error(message), { status, outcome: 'rejected' });
export function forwardDeviceName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 48 || Buffer.byteLength(value) > 192 || /[\p{Cc}\p{Cf}]/u.test(value)) throw fail(400, '设备名称需为 1–48 个字符，不含控制字符');
  return value.trim();
}
export function forwardPorts(value = '*') {
  if (value === '*') return '*';
  if (value === '') return [];
  const fields = String(value).split(',').map(item => item.trim());
  if (fields.length > 16 || fields.some(item => !/^[1-9]\d{0,4}$/.test(item) || Number(item) > 65535)) throw new Error('TCP_FORWARD_PORTS 需为 *、最多 16 个以逗号分隔的端口，或留空禁用');
  return [...new Set(fields.map(Number))];
}

export function forwardTargetHost(value = '127.0.0.1') {
  if (typeof value !== 'string' || value.length > 64) throw fail(400, '目标 IP 需为 IPv4 或 IPv6 地址');
  let host = value.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const family = net.isIP(host);
  if (!family || host.includes('%')) throw fail(400, '目标 IP 需为 IPv4 或 IPv6 地址，不含端口、域名或网卡标识');
  if (family === 6) {
    host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(host);
    if (mapped) { const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16); host = [high >> 8, high & 255, low >> 8, low & 255].join('.'); }
  }
  const ipv4 = net.isIP(host) === 4;
  if (host === '::' || !ipv4 && host.startsWith('ff') || ipv4 && (host === '0.0.0.0' || Number(host.split('.')[0]) >= 224)) throw fail(400, '目标 IP 需为具体的单播地址');
  return host;
}

export function normalizeForwardRule(config, body, policy = true) {
  const blockedPort = port => [config.port, config.agentPort, config.fileAgentPort, config.tunnelMetricsPort].includes(port);
  const allPorts = () => (config.forwardPorts ?? '*') === '*';
  const ports = () => config.forwardPorts || [];
  let hints;
  try { hints = rtcHints(body?.hints); } catch (error) { throw fail(400, error.message); }
  if (body && Object.hasOwn(body, 'hints')) { body = { ...body }; delete body.hints; }
  const reversed = body?.direction === 'reverse', serial = reversed && body.protocol === 'serial' ? serialConfig(body.serial) : null;
  const fieldsValid = serial ? Object.keys(body).sort().join(',') === 'deviceName,direction,localPort,protocol,serial' : body && (reversed ? Object.keys(body).every(key => ['direction', 'localPort', 'targetHost', 'targetPort', 'deviceName', 'protocol'].includes(key)) : ['localPort,targetPort', 'localPort,targetHost,targetPort'].includes(Object.keys(body).sort().join(',')));
  if (!fieldsValid || !Number.isInteger(body.localPort) || body.localPort < 1024 || body.localPort > 65535 || policy && reversed && blockedPort(body.localPort)) throw fail(400, '监听端口需在 1024–65535 之间，不能占用工作台管理端口');
  if (!serial && (!Number.isInteger(body.targetPort) || body.targetPort < 1 || body.targetPort > 65535 || policy && (!reversed && blockedPort(body.targetPort) || !allPorts() && !ports().includes(body.targetPort)))) throw fail(400, '目标端口需在 1–65535 之间且符合服务器端口限制，不能映射工作台管理端口');
  const targetHost = serial ? undefined : forwardTargetHost(body.targetHost);
  const deviceName = reversed ? forwardDeviceName(body.deviceName ?? '本地设备') : undefined;
  if (reversed && (body.protocol !== undefined && !['ssh', 'telnet', 'tcp', 'serial'].includes(body.protocol))) throw fail(400, '映射协议无效');
  body = { ...body, ...(!serial ? { targetHost } : {}), ...(reversed ? { deviceName } : {}) };
  return { body, hints, reversed, serial, targetHost, deviceName };
}
export function validateForwardRule(body, { policy = true } = {}) { const value = normalizeForwardRule({ forwardPorts: '*' }, body, policy); return { ...value.body, hints: value.hints }; }
