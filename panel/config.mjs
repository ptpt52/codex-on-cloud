import { readCenterCA } from './center-http.mjs';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { environment, settings } from '../native/config.mjs';
import { rtcAddress, rtcIPv6Address } from './rtc.mjs';
import { stunURL } from './rtc-network.mjs';
import { desktopEnvironment } from '../native/desktop-controls.mjs';
import { terminalEnvironment } from '../native/deployment-mode.mjs';
import { forwardPorts } from './forward.mjs';
import { readGatewayConnection } from '../native/gateway-config.mjs';
import { normalizeEntryBasePath } from './entry-path.mjs';
import { readSelfhostNode } from './selfhost-config.mjs';

function selfhostCa(root, value) {
  if (!value) return undefined;
  const file = resolve(root, value), base = resolve(root);
  if (file !== base && !file.startsWith(base + sep)) throw new Error('SELFHOST_CA_FILE 必须位于部署目录内');
  return readCenterCA(file);
}

function secret(env, name) {
  const file = env[`${name}_FILE`];
  if (!file) throw new Error(`缺少 ${name}_FILE，请先执行 npm run setup`);
  const value = readFileSync(file, 'utf8').trim();
  if (value.length < 16 || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} 必须是 16–512 个字符的单行密钥`);
  }
  return value;
}

export function readConfig(env = environment()) {
  const native = settings(env);
  const origin = new URL(env.PUBLIC_ORIGIN || 'http://localhost:36080');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTP(S) 根地址');
  }
  const entryBasePath = normalizeEntryBasePath(env.ENTRY_BASE_PATH);
  const selfhostNode = readSelfhostNode(native.root, env);
  const selfhostCaBundle = selfhostCa(native.root, env.SELFHOST_CA_FILE);
  if (selfhostNode && (selfhostNode.origin !== origin.origin || selfhostNode.path !== entryBasePath)) throw new Error('自建节点配置与 PUBLIC_ORIGIN / ENTRY_BASE_PATH 不一致');
  const agentUrl = `http://127.0.0.1:${native.agentPort}`;
  const hosts = new Set([origin.host.toLowerCase()]);
  for (const host of (env.ALLOWED_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)) {
    if (!/^[a-z0-9.:[\]-]+$/.test(host)) throw new Error('ALLOWED_HOSTS 只接受域名或 IP，可带端口，不接受通配符');
    hosts.add(host);
  }
  const port = Number(env.PORT ?? native.panelPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 无效');
  if (env.WEBRTC_ENABLED !== undefined && !['0', '1'].includes(env.WEBRTC_ENABLED)) throw new Error('WEBRTC_ENABLED 必须为 0 或 1');
  if (env.WEBRTC_IPV6 !== undefined && !['0', '1'].includes(env.WEBRTC_IPV6)) throw new Error('WEBRTC_IPV6 必须为 0 或 1');
  if (env.NODE_ID !== undefined && !/^[a-f0-9]{32}$/.test(env.NODE_ID)) throw new Error('NODE_ID 必须为 32 位小写十六进制节点身份');
  if (env.SHARED_ENTRY !== undefined && !['0', '1'].includes(env.SHARED_ENTRY)) throw new Error('SHARED_ENTRY 必须为 0 或 1');
  if (env.SHARED_ENTRY === '1' && !env.NODE_ID) throw new Error('共享入口需要固定 NODE_ID');
  const gatewayNode = readGatewayConnection(native.root);
  if (gatewayNode && (gatewayNode.origin !== origin.origin || gatewayNode.nodeId !== env.NODE_ID || env.SHARED_ENTRY !== '1')) throw new Error('网关节点配置与 PUBLIC_ORIGIN / NODE_ID 不一致，请完成 gateway:join 准备');
  const webrtcAddress = env.WEBRTC_ENABLED === '0' ? undefined : rtcAddress(env.WEBRTC_LAN_ADDRESS);
  const webrtcIPv6 = env.WEBRTC_IPV6 !== '0';
  return {
    mode: native.mode,
    nodeId: env.NODE_ID || '', sharedEntry: env.SHARED_ENTRY === '1', gatewayNode, entryBasePath, selfhostNode, selfhostCaBundle,
    host: '127.0.0.1', port, origin: origin.origin,
    agentPort: native.agentPort, fileAgentPort: native.fileAgentPort, tunnelMetricsPort: native.tunnelMetricsPort,
    forwardPorts: forwardPorts(env.TCP_FORWARD_PORTS), forwardDownloadDir: join(native.root, 'data', 'forward-client'),
    secureCookies: origin.protocol === 'https:', hosts,
    dataDir: join(native.root, 'data', 'panel'),
    username: env.ADMIN_USER || 'admin',
    password: secret({ ADMIN_PASSWORD_FILE: join(native.root, 'secrets', 'panel_password') }, 'ADMIN_PASSWORD'),
    agentSecret: secret({ AGENT_SECRET_FILE: join(native.root, 'secrets', 'agent_secret') }, 'AGENT_SECRET'),
    vncSocket: native.socket, agentUrl, fileAgentUrl: `http://127.0.0.1:${native.fileAgentPort}`, transferDir: native.transfer,
    tunnelDiagnosticsUrl: `http://127.0.0.1:${native.tunnelMetricsPort}/diag/tunnel`,
    managerSocket: native.managerSocket, tunnelSocket: native.tunnelSocket,
    terminalSocket: join(native.runtime, 'tmux.sock'), terminalEnv: native.mode === 'terminal' ? terminalEnvironment(native) : desktopEnvironment(native),
    sessionMs: 7 * 24 * 60 * 60 * 1000,
    webrtc: env.WEBRTC_ENABLED !== '0', fastConnect: true, streamProtocol: 1,
    webrtcAddress,
    webrtcAddressAuto: !env.WEBRTC_LAN_ADDRESS,
    webrtcIPv6,
    webrtcIPv6Address: webrtcAddress && webrtcIPv6 ? rtcIPv6Address(env.WEBRTC_IPV6_ADDRESS, webrtcAddress) : undefined,
    webrtcIPv6AddressAuto: !env.WEBRTC_IPV6_ADDRESS,
    webrtcStunUrl: stunURL(env.WEBRTC_STUN_URL ?? (selfhostNode ? `stun:${new URL(selfhostNode.origin).hostname}:3478` : undefined)),
  };
}
