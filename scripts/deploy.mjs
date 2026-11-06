import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs, parseEnv } from 'node:util';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import http from 'node:http';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const services = ['codex-cloud-desktop.service', 'codex-cloud-manager.service', 'codex-cloud-panel.service', 'codex-cloud-actions.service'];
const packages = ['xvfb', 'x11vnc', 'xfwm4', 'xfdesktop4', 'xfce4-panel', 'xfce4-settings', 'xterm', 'tmux', 'xclip', 'xdotool', 'xauth', 'x11-utils', 'dbus', 'fontconfig', 'fonts-noto-cjk', 'python3'];
export const help = `用法：npm run deploy -- [选项]
需要普通 Linux 用户、systemd 用户服务、Node.js 22+ 和已安装的 Codex CLI。
默认自动执行 npm ci、初始化、依赖检查、安装并启动用户服务。
  --check                  只检查，不安装、不修改配置或服务
  --install-deps           使用 sudo apt-get 安装桌面系统依赖（Ubuntu/Debian）
  --enable-linger          使用 sudo loginctl 启用无人登录时的开机自启
  --origin URL             新部署的访问根地址；已有 .env 保持不变
  --domain HOST --zone ZONE --api-token-file FILE
                           配置 Cloudflare 公网入口；会重启已运行的面板
  --build-forward          构建四平台端口映射助手，需要已有 Go 1.26.4
  --help                   显示帮助
保留已有密码和配置，不安装或修改 Codex，不重启桌面。`;

export function options(args) {
  const { values } = parseArgs({ args, options: {
    check: { type:'boolean' }, 'install-deps': { type:'boolean' }, 'enable-linger': { type:'boolean' },
    'build-forward': { type:'boolean' }, origin: { type:'string' }, domain: { type:'string' },
    zone: { type:'string' }, 'api-token-file': { type:'string' }, help: { type:'boolean' },
  } });
  if (values.help) return values;
  const publication = [values.domain, values.zone, values['api-token-file']];
  if (publication.some(Boolean) && !publication.every(Boolean)) throw new Error('公网部署需同时填写 --domain、--zone 和 --api-token-file');
  if (values.domain && (!/^[a-z0-9.-]+$/i.test(values.domain) || !/^[a-z0-9.-]+$/i.test(values.zone) || !values.domain.toLowerCase().endsWith('.' + values.zone.toLowerCase()))) throw new Error('--domain 需为 --zone 下的子域名');
  if (values.origin) {
    const url = new URL(values.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('--origin 必须是 HTTP(S) 根地址');
    if (values.domain && url.origin !== 'https://' + values.domain.toLowerCase()) throw new Error('--origin 与 --domain 不一致');
  }
  return values;
}

async function execute(command, args, { cwd, capture = false } = {}) {
  if (capture) {
    try { const result = await promisify(execFile)(command, args, {cwd, timeout:15000, maxBuffer:8192}); return {status:0, stdout:result.stdout}; }
    catch (error) { return {status:typeof error.code === 'number' ? error.code : 1, stdout:error.stdout || ''}; }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio:'inherit'});
    child.once('error', () => reject(new Error('无法运行 ' + command)));
    child.once('exit', status => resolve({status:status ?? 1}));
  });
}

async function boundedFile(path, maximum) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('配置或授权文件不是普通文件，或超过大小限制');
    const bytes = Buffer.alloc(maximum + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) throw new Error('配置或授权文件超过大小限制');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

export async function checkHealth(config) {
  if (!config) { const { readConfig } = await import('../panel/config.mjs'); config = readConfig(); }
  const request = (port, path, headers) => new Promise(resolve => {
    const req = http.get({hostname:'127.0.0.1', port, path, headers, timeout:1000}, res => {
      const chunks = []; let size = 0;
      res.on('data', bytes => { size += bytes.length; if (size > 4096) res.destroy(); else chunks.push(bytes); });
      res.on('error', () => resolve(null));
      res.on('aborted', () => resolve(null));
      res.on('close', () => resolve(null));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks)) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    const [panel, desktop] = await Promise.all([
      request(config.port, '/healthz', {host:new URL(config.origin).host}),
      request(config.agentPort, '/health', {authorization:'Bearer ' + config.agentSecret}),
    ]);
    if (panel?.ok && desktop?.ready) return;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('面板或桌面尚未就绪；请运行 npm run native:status，检查 journalctl --user -u codex-cloud-desktop.service -u codex-cloud-panel.service -n 50');
}

export async function deploy(values, { root = projectRoot, run = execute, health = checkHealth, log = console.log,
  platform = process.platform, uid = process.getuid?.(), username = userInfo().username, nodeVersion = process.versions.node } = {}) {
  if (platform !== 'linux') throw new Error('服务端需要 Linux 和 systemd；Mac/Windows 可运行端口映射助手');
  if (uid === 0) throw new Error('请以普通用户运行安装命令；只有显式选择的系统依赖和开机自启步骤使用 sudo');
  if (Number(nodeVersion.split('.')[0]) < 22) throw new Error('需要 Node.js 22+；安装器不会替换现有 Node 或 Codex');
  const call = (command, args, capture = false) => run(command, args, {cwd:root, capture});
  const step = async (label, command, args) => { log(label); if ((await call(command, args)).status !== 0) throw new Error(label + '失败，请处理上述错误后重新运行'); };
  const native = (command) => step('服务：' + command, process.execPath, ['scripts/native.mjs', command]);
  const bus = await call('systemctl', ['--user', 'is-system-running'], true);
  if (!/^(running|degraded|starting|initializing)\s*$/.test(bus.stdout || '')) throw new Error('无法连接 systemd 用户服务，请通过普通用户登录主机后重试');
  if (values['api-token-file']) {
    const token = (await boundedFile(resolve(values['api-token-file']), 4096)).trim();
    if (!token || /[\s\0]/.test(token)) throw new Error('Cloudflare API token 文件需为单行 token');
  }
  if (values.check) {
    await native('doctor');
    log('环境检查通过。未安装依赖、修改配置、启动或重启服务。'); return;
  }
  const active = await Promise.all(services.map(service => call('systemctl', ['--user', 'is-active', '--quiet', service], true)));
  const running = active.some(item => item.status === 0);
  if (running && (await call('npm', ['ls', '--depth=0'], true)).status !== 0) throw new Error('已有服务运行，但项目依赖不完整或版本不符；本次停止安装，保留当前任务。请另行安排依赖维护');
  if (values['install-deps']) {
    if ((await call('apt-get', ['--version'], true)).status !== 0) throw new Error('--install-deps 仅支持有 apt-get 的 Ubuntu/Debian');
    await step('更新系统软件包索引', 'sudo', ['apt-get', 'update']);
    await step('安装桌面系统依赖', 'sudo', ['apt-get', 'install', '-y', '--no-install-recommends', '--no-upgrade', '--no-remove', ...packages]);
  }
  if (!running) await step('安装锁定的项目依赖', 'npm', ['ci']);
  else log('保留运行中的服务和现有项目依赖。');
  const origin = values.origin || (values.domain ? 'https://' + values.domain.toLowerCase() : undefined);
  await step('初始化（保留已有密码与配置）', process.execPath, ['scripts/setup.mjs', ...(origin ? ['--origin', origin] : [])]);
  await native('install');
  if (values['enable-linger']) await step('启用开机自启（无需用户登录）', 'sudo', ['loginctl', 'enable-linger', username]);
  if (values.domain) {
    await step('安装固定版本 cloudflared', process.execPath, ['scripts/install-cloudflared.mjs']);
    await step('配置 Cloudflare 公网入口', process.execPath, ['scripts/provision-cloudflare.mjs', '--domain', values.domain.toLowerCase(), '--zone', values.zone.toLowerCase(), '--api-token-file', resolve(values['api-token-file'])]);
  }
  if (values['build-forward']) await step('构建端口映射助手', process.execPath, ['scripts/build-forward.mjs']);
  await native('start');
  if (values.domain && active[2].status === 0) await step('公网配置生效：重启面板（端口映射需重新配对，桌面任务保留）', 'systemctl', ['--user', 'restart', 'codex-cloud-panel.service']);
  const env = parseEnv(await boundedFile(join(root, '.env'), 65536));
  let tunnel = false;
  try { tunnel = env.PUBLIC_ORIGIN?.startsWith('https://') && (await boundedFile(join(root, 'secrets', 'tunnel_token'), 4096)).trim().length > 0; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (tunnel) {
    if (!values.domain) await step('检查固定版本 cloudflared', process.execPath, ['scripts/install-cloudflared.mjs']);
    await native('tunnel');
  }
  for (const service of [...services, ...(tunnel ? ['codex-cloud-tunnel.service'] : [])]) {
    if ((await call('systemctl', ['--user', 'is-active', '--quiet', service], true)).status !== 0) throw new Error(service + ' 未运行，请执行 npm run native:status 检查');
  }
  await health();
  log('部署完成，面板和桌面已就绪。入口：' + (env.PUBLIC_ORIGIN || 'http://localhost:36080'));
  log('登录信息：' + join(root, 'secrets', 'credentials.txt') + '（密码不打印到日志）');
  if (!tunnel) log('本机访问使用 localhost；远程服务器可通过 SSH 本地端口转发访问，或按 README 配置 Cloudflare 公网入口。');
  if (!values['enable-linger']) log('如需开机且无需登录时运行，可加 --enable-linger，或执行 sudo loginctl enable-linger ' + username);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { const values = options(process.argv.slice(2)); if (values.help) console.log(help); else await deploy(values); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
