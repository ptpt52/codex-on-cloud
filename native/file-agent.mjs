import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { settings } from './config.mjs';

if (process.getuid() === 0) throw Error('请以普通用户运行文件服务');
const config = settings();
const child = spawn('python3', [join(config.root, 'desktop', 'agent.py')], {
  env: { ...config.env, FILE_AGENT_ONLY: '1', AGENT_PORT: String(config.fileAgentPort),
    AGENT_SECRET_FILE: join(config.root, 'secrets', 'agent_secret'), TRANSFER_DIR: config.transfer },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let window = Date.now(), bytes = 0, stopping = false, deadline;
const output = chunk => {
  if (Date.now() - window >= 30000) { window = Date.now(); bytes = 0; }
  const part = chunk.subarray(0, Math.max(0, 32768 - bytes)); bytes += part.length; process.stderr.write(part);
};
child.stdout.on('data', output); child.stderr.on('data', output);
child.stdin.on('error', () => {});
child.once('error', () => { console.error('无法启动文件助手'); process.exitCode = 1; });
child.once('close', code => { clearTimeout(deadline); process.exitCode = stopping ? 0 : code || 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  child.stdin.end(); child.kill('SIGTERM');
  deadline = setTimeout(() => child.kill('SIGKILL'), 1500).unref();
});
