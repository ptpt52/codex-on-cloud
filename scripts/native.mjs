import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../native/config.mjs';

const config = settings();
const command = process.argv[2] || 'doctor';
const path = `${join(config.root, 'data', 'host-tools', 'usr', 'bin')}:${process.env.PATH}`;
const serviceDir = join(process.env.HOME, '.config', 'systemd', 'user');
const units = ['codex-cloud-desktop.service', 'codex-cloud-panel.service'];
const dependencies = new Map([
  ['Xvfb', 'xvfb'], ['x11vnc', 'x11vnc'], ['xfwm4', 'xfwm4'],
  ['xfdesktop', 'xfdesktop4'], ['xfce4-panel', 'xfce4-panel'], ['xfsettingsd', 'xfce4-settings'],
  ['xterm', 'xterm'], ['tmux', 'tmux'], ['xclip', 'xclip'], ['xdotool', 'xdotool'],
  ['xauth', 'xauth'], ['xdpyinfo', 'x11-utils'], ['dbus-run-session', 'dbus'],
  ['python3', 'python3'], ['codex', null],
]);
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
  console.log(`显示：${config.display}；桌面尺寸：${config.size}；工作目录：${config.workspace}`);
  if (missing.length) {
    const packages = missing.filter(name => name !== 'codex');
    if (packages.length) console.log(`缺少系统组件，请在本机执行：\nsudo apt-get update\nsudo apt-get install -y --no-install-recommends ${[...new Set(packages)].join(' ')}`);
    if (missing.includes('codex')) console.log('未找到本机 Codex；请安装 Codex CLI 后重新运行。');
    return false;
  }
  const python = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)'], { env: { ...process.env, PATH: path } });
  if (python.status !== 0) throw new Error('需要 Python 3.8+；Ubuntu 18.04 自带的 Python 3.6 不适用，请先准备较新的 python3');
  const check = spawnSync('x11vnc', ['-help'], { env: { ...process.env, PATH: path }, encoding: 'utf8' });
  if (!`${check.stdout}${check.stderr}`.includes('-inetd')) throw new Error('x11vnc 必须支持 -inetd');
  return true;
}
// Values are data, not shell code. Escape systemd specifiers and argument expansion.
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('服务路径不能包含换行或 NUL');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
}
function unit(description, args, extra = '') {
  const directory = config.root.replaceAll('%', '%%').replaceAll(' ', '\\x20');
  return `# Managed by codex-on-cloud\n[Unit]\nDescription=${description}\n${extra}\n[Service]\nType=simple\nWorkingDirectory=${directory}\nEnvironment=${quote(`PATH=${path}`)}\nExecStart=${[process.execPath, ...args].map(quote).join(' ')}\nRestart=no\nKillMode=control-group\nTimeoutStopSec=15\nUMask=0077\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=codex-cloud\n\n[Install]\nWantedBy=default.target\n`;
}
try {
  if (process.getuid() === 0) throw new Error('请用普通用户执行 npm 命令，不要使用 sudo');
  if (command === 'doctor') process.exitCode = await doctor() ? 0 : 1;
  else if (command === 'install') {
    if (!await doctor()) process.exitCode = 1;
    else {
      await access(join(config.root, 'secrets', 'panel_password'));
      await mkdir(serviceDir, { recursive: true });
      const files = [
        [units[0], unit('Codex Cloud independent virtual desktop', [join(config.root, 'native', 'desktop.mjs')])],
        [units[1], unit('Codex Cloud browser gateway', [join(config.root, 'panel', 'main.mjs')], 'After=codex-cloud-desktop.service')],
        ['codex-cloud-tunnel.service', unit('Codex Cloud Cloudflare Tunnel', [join(config.root, 'native', 'tunnel.mjs')], 'After=codex-cloud-panel.service')],
      ];
      for (const [name, content] of files) {
        const file = join(serviceDir, name);
        let previous = '';
        try { previous = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (previous && !previous.startsWith('# Managed by codex-on-cloud')) throw new Error(`${file} 已存在且不是本项目生成的，不会覆盖`);
        await writeFile(file, content, { mode: 0o600 });
        await chmod(file, 0o600);
      }
      systemctl(['daemon-reload']);
      systemctl(['enable', ...units]);
      console.log('用户服务已安装，尚未启动。运行 npm run native:start。\n如需退出本机登录后及开机继续运行，请执行一次：sudo loginctl enable-linger ' + process.env.USER);
    }
  } else if (command === 'start') systemctl(['start', ...units]);
  else if (command === 'status') process.exitCode = systemctl(['status', ...units, '--no-pager'], false).status || 0;
  else if (command === 'stop') systemctl(['stop', 'codex-cloud-tunnel.service', units[1], units[0]]);
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
