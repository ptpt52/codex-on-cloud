import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../native/config.mjs';
import { serviceUnits } from '../native/service-units.mjs';
import { deploymentMode, modeServices } from '../native/deployment-mode.mjs';
import { parseArgs } from 'node:util';

const config = settings();
const command = process.argv[2] || 'doctor';
const { values } = parseArgs({ args: process.argv.slice(3), options: { mode: { type: 'string' } } });
if (values.mode) {
  const mode = deploymentMode(values.mode);
  if (command !== 'doctor' && mode !== config.mode) throw Error('已有部署模式不同，不会切换或停止现有任务');
  config.mode = mode;
}
const path = `${join(config.root, 'data', 'host-tools', 'usr', 'bin')}:${process.env.PATH}`;
const serviceDir = join(process.env.HOME, '.config', 'systemd', 'user');
const selectedUnits = modeServices(config.mode);
const dependencies = new Map([
  ['Xvfb', 'xvfb'], ['x11vnc', 'x11vnc'], ['xfwm4', 'xfwm4'],
  ['xfdesktop', 'xfdesktop4'], ['xfce4-panel', 'xfce4-panel'], ['xfsettingsd', 'xfce4-settings'],
  ['xterm', 'xterm'], ['tmux', 'tmux'], ['xclip', 'xclip'], ['xdotool', 'xdotool'],
  ['xauth', 'xauth'], ['xdpyinfo', 'x11-utils'], ['dbus-run-session', 'dbus'],
  ['python3', 'python3'], ['codex', null],
]);
if (config.mode === 'terminal') {
  for (const name of [...dependencies.keys()]) if (!['tmux', 'python3'].includes(name)) dependencies.delete(name);
}
if (config.env.TUNNEL_DNS_SERVERS?.trim()) {
  dependencies.set('unshare', 'util-linux');
  dependencies.set('mount', 'mount');
}
async function executable(name) {
  for (const directory of path.split(':')) {
    const file = join(directory, name);
    try { await access(file, constants.X_OK); return file; } catch {}
  }
  return null;
}
function systemctl(args, check = true) {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (check && result.status !== 0) throw new Error(`systemctl --user ${args.join(' ')} 失败`);
  return result;
}
async function doctor() {
  const missing = [];
  for (const [name, pkg] of dependencies) {
    const binary = await executable(name);
    console.log(`${binary ? '✓' : '✗'} ${name}${binary ? `  ${binary}` : ''}`);
    if (!binary) missing.push(pkg || name);
  }
  console.log(config.mode === 'terminal' ? `部署模式：纯网页终端；工作目录：${config.workspace}` : `显示：${config.display}；桌面尺寸：${config.size}；工作目录：${config.workspace}`);
  if (missing.length) {
    const packages = missing.filter(name => name !== 'codex');
    if (packages.length) console.log(`缺少系统组件，请在本机执行：\nsudo apt-get update\nsudo apt-get install -y --no-install-recommends ${[...new Set(packages)].join(' ')}`);
    if (missing.includes('codex')) console.log('未找到本机 Codex；请安装 Codex CLI 后重新运行。');
    return false;
  }
  const python = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)'], { env: { ...process.env, PATH: path } });
  if (python.status !== 0) throw new Error('需要 Python 3.8+；Ubuntu 18.04 自带的 Python 3.6 不适用，请先准备较新的 python3');
  if (config.env.TUNNEL_DNS_SERVERS?.trim()) {
    const probe = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--propagation', 'private', '--', 'true'], { encoding: 'utf8', timeout: 3000 });
    if (probe.status !== 0) throw new Error('独立 DNS 需要允许非特权 user/mount namespace；也可修复系统 DNS 后移除 TUNNEL_DNS_SERVERS');
  }
  if (config.mode !== 'terminal') {
    try { await access(join(config.root, 'node_modules', '@novnc', 'novnc', 'core', 'rfb.js')); }
    catch { throw Error('桌面模式需要 noVNC，请运行 npm ci（不要省略 optional 依赖）'); }
    const check = spawnSync('x11vnc', ['-help'], { env: { ...process.env, PATH: path }, encoding: 'utf8' });
    if (!`${check.stdout}${check.stderr}`.includes('-inetd')) throw new Error('x11vnc 必须支持 -inetd');
  }
  return true;
}
try {
  if (process.getuid() === 0) throw new Error('请用普通用户执行 npm 命令，不要使用 sudo');
  if (command === 'doctor') process.exitCode = await doctor() ? 0 : 1;
  else if (command === 'install') {
    const other = config.mode === 'terminal' ? 'codex-cloud-desktop.service' : 'codex-cloud-terminal.service';
    if (spawnSync('systemctl', ['--user', 'is-active', '--quiet', other], { stdio: 'ignore' }).status === 0) throw Error('另一部署模式仍在运行，不会覆盖服务或停止任务');
    if (!await doctor()) process.exitCode = 1;
    else {
      await access(join(config.root, 'secrets', 'panel_password'));
      await mkdir(serviceDir, { recursive: true });
      const files = serviceUnits(config.root, path, process.execPath, config.mode);
      const preserved = new Set();
      let previousFiles = '';
      try { previousFiles = await readFile(join(serviceDir, 'codex-cloud-files.service'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const hostUnit = config.mode === 'terminal' ? 'codex-cloud-terminal.service' : 'codex-cloud-desktop.service';
      if (!previousFiles && config.fileAgentPort === config.agentPort && spawnSync('systemctl', ['--user', 'is-active', '--quiet', hostUnit], { stdio: 'ignore' }).status === 0) {
        throw Error('旧任务宿主仍持有文件端口。请在 .env 配置独立且空闲的 FILE_AGENT_PORT（例如 36904）后重试；不会重启宿主或停止任务');
      }
      // Validate every unit before writing any; preserve the previously deployed
      // sidecar migration and its port drop-in without taking over its lifetime.
      for (const name of files.keys()) {
        let previous = '';
        try { previous = await readFile(join(serviceDir, name), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (name === 'codex-cloud-files.service' && previous.startsWith('# Managed migration for codex-on-cloud file helper')) { preserved.add(name); continue; }
        if (previous && !previous.startsWith('# Managed by codex-on-cloud')) throw new Error(`${join(serviceDir, name)} 已存在且不是本项目生成的，不会覆盖`);
      }
      for (const [name, content] of files) {
        if (preserved.has(name)) continue;
        const file = join(serviceDir, name);
        await writeFile(file, content, { mode: 0o600 });
        await chmod(file, 0o600);
      }
      systemctl(['daemon-reload']);
      systemctl(['enable', ...selectedUnits.filter(name => !preserved.has(name))]);
      console.log('用户服务已安装，尚未启动。运行 npm run native:start。\n如需退出本机登录后及开机继续运行，请执行一次：sudo loginctl enable-linger ' + process.env.USER);
    }
  } else if (command === 'start') systemctl(['start', ...selectedUnits]);
  else if (command === 'status') {
    process.exitCode = systemctl(['status', ...selectedUnits, '--no-pager'], false).status || 0;
    console.log('面板异常退出后间隔 5 秒重启，60 秒内最多启动 3 次；手动停止不恢复。达到上限后请先检查日志，再执行 systemctl --user reset-failed codex-cloud-panel.service 和 npm run native:start。桌面不会自动重建。');
  }
  else if (command === 'stop') systemctl(['stop', 'codex-cloud-tunnel.service', ...[...selectedUnits].reverse()]);
  else if (command === 'tunnel') {
    if (!config.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('请先将 .env 的 PUBLIC_ORIGIN 配为实际 HTTPS 域名，并重启 panel 服务');
    const token = (await readFile(join(config.root, 'secrets', 'tunnel_token'), 'utf8')).trim();
    if (!token) throw new Error('请先在 secrets/tunnel_token 中填写 Tunnel token，并按 docs/cloudflare.md 配置域名与 Access');
    if (!await executable('cloudflared')) throw new Error('缺少 cloudflared；请按 docs/cloudflare.md 安装');
    systemctl(['enable', '--now', 'codex-cloud-tunnel.service']);
  } else throw new Error('命令必须是 doctor / install / start / status / stop / tunnel');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
