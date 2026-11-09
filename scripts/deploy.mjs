import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as util from 'node:util';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import http from 'node:http';
import { deploymentMode, modeServices } from '../native/deployment-mode.mjs';
import { configureWSLNetwork } from './wsl-network.mjs';
import { randomBytes } from 'node:crypto';
import { acquireDeploymentLease } from './deployment-lease.mjs';
import { publicationClient } from './cloudflare-client.mjs';

// Keep the version guard reachable even when older Node lacks util.parseEnv.
const { parseArgs, parseEnv } = util;

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packages = ['xvfb', 'x11vnc', 'xfwm4', 'xfdesktop4', 'xfce4-panel', 'xfce4-settings', 'xterm', 'tmux', 'xclip', 'xdotool', 'xauth', 'x11-utils', 'dbus', 'fontconfig', 'fonts-noto-cjk', 'python3'];
export const help = `用法：npm run deploy -- [选项]
需要普通 Linux 用户、systemd 用户服务和 Node.js 22+；桌面模式另需 Codex CLI，纯终端模式可不安装。
默认自动执行 npm ci、初始化、依赖检查、安装并启动用户服务。
纯终端依赖 tmux、Python 和 util-linux/flock；Codex 可选。
WSL 镜像网络自动配置 hostAddressLoopback 并备份；重启 WSL 需自行保存任务后执行。
  --check                  只检查，不安装、不修改配置或服务
  --mode desktop|terminal  新部署选择桌面或纯网页终端；默认 desktop，已有模式保持
  --install-deps           使用 sudo apt-get 按模式安装系统依赖（Ubuntu/Debian）
  --enable-linger          使用 sudo loginctl 启用无人登录时的开机自启
  --skip-wsl-network       保留 Windows WSL 网络配置，不执行自动检查或修改
  --origin URL             新部署的访问根地址；已有 .env 保持不变
  --domain HOST --zone ZONE --api-token-file FILE
                           配置 Cloudflare 公网入口；会重启已运行的面板
  --build-forward          构建四平台端口映射助手，需要已有 Go 1.26.4
  --help                   显示帮助
保留已有密码和配置，不安装或修改 Codex，不重启桌面。`;

export function options(args) {
  const { values } = parseArgs({ args, options: {
    check: { type:'boolean' }, 'install-deps': { type:'boolean' }, 'enable-linger': { type:'boolean' },
    'build-forward': { type:'boolean' }, 'skip-wsl-network': { type:'boolean' }, origin: { type:'string' }, domain: { type:'string' },
    zone: { type:'string' }, 'api-token-file': { type:'string' }, help: { type:'boolean' }, mode: { type:'string' },
  } });
  if (values.help) return values;
  if (values.mode) deploymentMode(values.mode);
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

export async function checkHealth(config, { attempts = 20, interval = 400 } = {}) {
  if (!config) {
    const [{ readConfig }, { environment }] = await Promise.all([import('../panel/config.mjs'), import('../native/config.mjs')]);
    // A shell inside an older task inherits the host's startup configuration.
    // Generated systemd units load today's .env, not those inherited values.
    config = readConfig(environment({}));
  }
  const request = (port, path, headers) => new Promise(resolve => {
    const req = http.get({hostname:'127.0.0.1', port, path, headers, timeout:2500}, res => {
      const chunks = []; let size = 0;
      res.on('data', bytes => { size += bytes.length; if (size > 4096) res.destroy(); else chunks.push(bytes); });
      res.on('error', () => resolve(null));
      res.on('aborted', () => resolve(null));
      res.on('close', () => resolve(null));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks)) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [panel, files] = await Promise.all([
      request(config.port, '/readyz', {host:new URL(config.origin).host}),
      request(config.fileAgentPort ?? config.agentPort, '/health', {authorization:'Bearer ' + config.agentSecret}),
    ]);
    if (panel?.ok && panel.host && panel.files && files?.ready && files.uploadProtocol === 1 && files.quotaProtocol === 1) return;
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('面板、任务宿主或独立文件服务尚未就绪；请运行 npm run native:status，检查 journalctl --user -u codex-cloud-manager.service -u codex-cloud-files.service -u codex-cloud-panel.service -n 50');
}

export async function deploy(values, context = {}) {
  const { platform = process.platform, uid = process.getuid?.(), nodeVersion = process.versions.node } = context;
  if (platform !== 'linux' || uid === 0 || Number(nodeVersion.split('.')[0]) < 22) return deployUnderLease(values, context);
  if (values.check) return deployUnderLease(values, context);
  const lease = await acquireDeploymentLease(context.root || projectRoot);
  try { return await deployUnderLease(values, { ...context, lease, operationId: randomBytes(16).toString('hex') }); }
  finally { await lease.release(); }
}
async function deployUnderLease(values, { root = projectRoot, run = execute, health = checkHealth, log = console.log, lease, operationId, publicationFactory = publicationClient,
  platform = process.platform, uid = process.getuid?.(), username = userInfo().username, nodeVersion = process.versions.node,
  wslNetwork = configureWSLNetwork } = {}) {
  if (platform !== 'linux') throw new Error('服务端需要 Linux 和 systemd；Mac/Windows 可运行端口映射助手');
  if (uid === 0) throw new Error('请以普通用户运行安装命令；只有显式选择的系统依赖和开机自启步骤使用 sudo');
  if (Number(nodeVersion.split('.')[0]) < 22) throw new Error('需要 Node.js 22+；安装器不会替换现有 Node 或 Codex');
  let existingMode, existingEnv = {};
  try { existingEnv = parseEnv(await boundedFile(join(root, '.env'), 65536)); existingMode = deploymentMode(existingEnv.DEPLOY_MODE); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const mode = deploymentMode(values.mode || existingMode);
  if (!values.check && existingMode && values.mode && existingMode !== mode) throw Error('已有部署模式不同，不会自动切换或停止任务；请在新部署中选择模式');
  const selectedServices = modeServices(mode);
  const call = async (command, args, capture = false) => { lease?.check(); const result = await run(command, args, {cwd:root, capture}); lease?.check(); return result; };
  const step = async (label, command, args) => { log(label); if ((await call(command, args)).status !== 0) throw new Error(label + '失败，请处理上述错误后重新运行'); };
  const native = (command) => step('服务：' + command, process.execPath, ['scripts/native.mjs', command, ...(values.check && values.mode ? ['--mode', mode] : [])]);
  const configureWSL = check => !values['skip-wsl-network'] && existingEnv.WEBRTC_ENABLED !== '0'
    ? wslNetwork({ check, run: (command, args) => call(command, args, true), log }) : undefined;
  const bus = await call('systemctl', ['--user', 'is-system-running'], true);
  if (!/^(running|degraded|starting|initializing)\s*$/.test(bus.stdout || '')) throw new Error('无法连接 systemd 用户服务，请通过普通用户登录主机后重试');
  if (values['api-token-file']) {
    const token = (await boundedFile(resolve(values['api-token-file']), 4096)).trim();
    if (!token || /[\s\0]/.test(token)) throw new Error('Cloudflare API token 文件需为单行 token');
  }
  if (values.check) {
    const wsl = await configureWSL(true);
    await native('doctor');
    if (wsl?.needsConfiguration) throw Error('WSL 镜像网络直连配置待修复；运行 npm run deploy 自动配置。本次检查未修改文件或服务。');
    log('环境检查通过。未安装依赖、修改配置、启动或重启服务。'); return;
  }
  const oppositeHost = mode === 'terminal' ? 'codex-cloud-desktop.service' : 'codex-cloud-terminal.service';
  if ((await call('systemctl', ['--user', 'is-active', '--quiet', oppositeHost], true)).status === 0) throw Error('另一部署模式仍在运行，不会覆盖服务或停止任务；请保留当前部署');
  const active = await Promise.all(selectedServices.map(service => call('systemctl', ['--user', 'is-active', '--quiet', service], true)));
  const running = active.some(item => item.status === 0);
  if (running && (await call('npm', ['ls', '--depth=0', ...(mode === 'terminal' ? ['--omit=dev', '--omit=optional'] : [])], true)).status !== 0) throw new Error('已有服务运行，但项目依赖不完整或版本不符；本次停止安装，保留当前任务。请另行安排依赖维护');
  if (values['install-deps']) {
    if ((await call('apt-get', ['--version'], true)).status !== 0) throw new Error('--install-deps 仅支持有 apt-get 的 Ubuntu/Debian');
    await step('更新系统软件包索引', 'sudo', ['apt-get', 'update']);
    await step('安装系统依赖', 'sudo', ['apt-get', 'install', '-y', '--no-install-recommends', '--no-upgrade', '--no-remove', ...(mode === 'terminal' ? ['tmux', 'python3', 'util-linux'] : packages)]);
  }
  if (!running) await step('安装锁定的项目依赖', 'npm', ['ci', ...(mode === 'terminal' ? ['--omit=dev', '--omit=optional'] : [])]);
  else log('保留运行中的服务和现有项目依赖。');
  const origin = values.origin || (values.domain ? 'https://' + values.domain.toLowerCase() : undefined);
  await step('初始化（保留已有密码与配置）', process.execPath, ['scripts/setup.mjs', ...(values.mode ? ['--mode', mode] : []), ...(origin ? ['--origin', origin] : [])]);
  await native('install');
  const wsl = await configureWSL(false);
  if (values['enable-linger']) await step('启用开机自启（无需用户登录）', 'sudo', ['loginctl', 'enable-linger', username]);
  if (values.domain) {
    await step('安装固定版本 cloudflared', process.execPath, ['scripts/install-cloudflared.mjs']);
  }
  const publication = values.domain ? await publicationFactory(values, { root, deploymentLease: lease, operationId }) : null;
  const target = values.domain ? { domain: values.domain.toLowerCase(), zone: values.zone.toLowerCase() } : null;
  const publish = async (label, action) => { log(label); lease.check(); return publication[action](target); };
  let prepared = false, panelTouched = false;
  try {
    if (publication) { prepared = true; await publish('准备 Cloudflare 本机配置（保留当前公网入口）', 'prepare'); }
    if (values['build-forward']) await step('构建端口映射助手', process.execPath, ['scripts/build-forward.mjs']);
    await native('start');
    for (const service of ['codex-cloud-files.service', 'codex-cloud-manager.service', 'codex-cloud-panel.service']) {
      if (active[selectedServices.indexOf(service)].status === 0) {
        if (service === 'codex-cloud-panel.service') panelTouched = true;
        await step('更新后台：' + service + '（原任务保留；面板重启后映射需重新配对）', 'systemctl', ['--user', 'restart', service]);
      }
    }
    const env = parseEnv(await boundedFile(join(root, '.env'), 65536));
    let tunnel = false;
    try { tunnel = env.PUBLIC_ORIGIN?.startsWith('https://') && (await boundedFile(join(root, 'secrets', 'tunnel_token'), 4096)).trim().length > 0; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (tunnel) {
      if (!values.domain) await step('检查固定版本 cloudflared', process.execPath, ['scripts/install-cloudflared.mjs']);
      await native('tunnel');
    }
    for (const service of [...selectedServices, ...(tunnel ? ['codex-cloud-tunnel.service'] : [])]) {
      if ((await call('systemctl', ['--user', 'is-active', '--quiet', service], true)).status !== 0) throw new Error(service + ' 未运行，请执行 npm run native:status 检查');
    }
    await health(); lease.check();
    if (publication) await publish('服务已就绪：提交 Cloudflare 公网入口', 'commit');
  } catch (error) {
    if (prepared) {
      try {
        const rollback = await publish('发布失败：回退本次配置', 'rollback');
        if (panelTouched && rollback.rolledBack) await step('恢复原入口配置的面板（保留任务）', 'systemctl', ['--user', 'restart', 'codex-cloud-panel.service']);
      } catch { throw new Error(error.message + '；回退未能确认，请检查 data/cloudflare-publication.json 并执行 --rollback'); }
    }
    throw error;
  }
  const env = parseEnv(await boundedFile(join(root, '.env'), 65536));
  log(`部署完成，面板和${mode === 'terminal' ? '终端后台' : '桌面'}已就绪。入口：` + (env.PUBLIC_ORIGIN || 'http://localhost:36080'));
  log('登录信息：' + join(root, 'secrets', 'credentials.txt') + '（密码不打印到日志）');
  if (wsl?.restartRequired) log('WSL 网络配置待生效：保存任务后重启 WSL，再刷新网页验证直连；wsl --shutdown 会结束所有 WSL 任务。');
  if (!env.PUBLIC_ORIGIN?.startsWith('https://')) log('本机访问使用 localhost；远程服务器可通过 SSH 本地端口转发访问，或按 README 配置 Cloudflare 公网入口。');
  if (!values['enable-linger']) log('如需开机且无需登录时运行，可加 --enable-linger，或执行 sudo loginctl enable-linger ' + username);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { const values = options(process.argv.slice(2)); if (values.help) console.log(help); else await deploy(values); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
