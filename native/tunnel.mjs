import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { settings } from './config.mjs';

const config = settings();
if (!config.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('Tunnel 需要配置实际的 HTTPS PUBLIC_ORIGIN');
const tokenFile = join(config.root, 'secrets', 'tunnel_token');
if (!(await readFile(tokenFile, 'utf8')).trim()) throw new Error('Tunnel token 未配置');
// Credentials stay in a private file, never in process arguments or unit files.
const env = { ...process.env };
delete env.TUNNEL_TOKEN;
delete env.TUNNEL_TOKEN_FILE;
const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--metrics', '127.0.0.1:0', 'run', '--token-file', tokenFile], { stdio: 'inherit', env });
child.once('error', error => { console.error(`cloudflared 启动失败：${error.message}`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
