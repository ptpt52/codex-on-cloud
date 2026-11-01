import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { settings } from './config.mjs';

const config = settings();
if (!config.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('Tunnel 需要配置实际的 HTTPS PUBLIC_ORIGIN');
const tokenFile = join(config.root, 'secrets', 'tunnel_token');
if (!(await readFile(tokenFile, 'utf8')).trim()) throw new Error('Tunnel token 未配置');
// Credentials stay in a private file, never in process arguments or unit files.
const env = { ...config.env };
delete env.TUNNEL_TOKEN;
delete env.TUNNEL_TOKEN_FILE;
const ipVersion = config.env.TUNNEL_EDGE_IP_VERSION || 'auto';
const protocol = config.env.TUNNEL_PROTOCOL || 'auto';
if (!['auto', '4', '6'].includes(ipVersion)) throw new Error('TUNNEL_EDGE_IP_VERSION 必须是 auto / 4 / 6');
if (!['auto', 'quic', 'http2'].includes(protocol)) throw new Error('TUNNEL_PROTOCOL 必须是 auto / quic / http2');
let command = 'cloudflared';
let args = ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--metrics', '127.0.0.1:0',
  '--edge-ip-version', ipVersion, '--protocol', protocol, 'run', '--token-file', tokenFile];
const servers = (config.env.TUNNEL_DNS_SERVERS || '').split(',').map(value => value.trim()).filter(Boolean);
if (servers.length) {
  if (servers.length > 3 || servers.some(server => !isIP(server))) throw new Error('TUNNEL_DNS_SERVERS 最多接受 3 个 DNS 服务器 IP，以逗号分隔');
  const directory = join(config.root, 'data', 'tunnel');
  const resolver = join(directory, 'resolv.conf');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolver, servers.map(server => `nameserver ${server}\n`).join('') + 'options timeout:2 attempts:2\n', { mode: 0o600 });
  // A private mount namespace changes resolv.conf only for this process tree.
  // --dns-resolver-addrs configures WARP/private-network DNS, not edge discovery.
  command = 'unshare';
  args = ['--user', '--map-root-user', '--mount', '--propagation', 'private', '--',
    'bash', join(config.root, 'native', 'with-resolver.sh'), resolver, 'cloudflared', ...args];
  console.log(`Tunnel 使用独立 DNS：${servers.join(', ')}；系统 DNS 保持原配置。`);
}
let stopping = false;
const child = spawn(command, args, { stdio: 'inherit', env });
child.once('error', error => { console.error(`cloudflared 启动失败：${error.message}`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? (stopping ? 0 : 1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child.kill(signal); });
