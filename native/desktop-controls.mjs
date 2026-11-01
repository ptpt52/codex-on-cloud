import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readPreferences, writePreferences, preferenceRevision, validatePreferences } from './preferences.mjs';
import { validateInput, executeInput } from './input.mjs';

const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const RESUME_COMMAND = 'exec codex resume --cd "$PWD" "$CODEX_CLOUD_RESUME_ID"';
export class ControlError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function smallFile(path) {
  const fd = await open(path, 'r');
  try { const bytes = Buffer.alloc(8193); const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0); if (bytesRead > 8192) throw new Error('metadata too large'); return bytes.subarray(0, bytesRead).toString(); }
  finally { await fd.close(); }
}
async function sessionId(pid) {
  const queue = [pid], found = new Set();
  for (let count = 0; queue.length && count < 16; count++) {
    const current = queue.shift();
    try {
      const args = (await smallFile(`/proc/${current}/cmdline`)).split('\0').filter(Boolean);
      const at = args.indexOf('resume');
      if (at >= 0) for (const value of args.slice(at + 1)) if (UUID.test(value)) found.add(value);
      const children = (await smallFile(`/proc/${current}/task/${current}/children`)).trim().split(/\s+/).map(Number).filter(value => Number.isInteger(value) && value > 1);
      queue.push(...children.slice(0, Math.max(0, 16 - count - queue.length)));
    } catch {}
  }
  return found.size === 1 ? [...found][0] : null;
}
export function desktopEnvironment(config) {
  const directory = join(config.root, 'data', 'desktop');
  const env = { ...config.env, DISPLAY: config.display, XAUTHORITY: join(config.runtime, 'Xauthority'),
    PATH: `${join(config.root, 'data', 'host-tools', 'usr', 'bin')}:${config.env.PATH}`,
    WORKSPACE_DIR: config.workspace, TRANSFER_DIR: config.transfer, TMUX_SOCKET: join(config.runtime, 'tmux.sock'),
    FONTCONFIG_FILE: join(directory, 'fonts.conf'), XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'share'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  delete env.DBUS_SESSION_BUS_ADDRESS; delete env.SESSION_MANAGER;
  return env;
}
export function createDesktopControls(config, dependencies = {}) {
  const env = desktopEnvironment(config);
  const run = dependencies.run || (async (command, args, options = {}) => (await exec(command, args, { env, encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024, ...options })).stdout.trim());
  const inspectSession = dependencies.sessionId || sessionId;
  const launch = dependencies.launch || (() => {
    const child = spawn(join(config.root, 'desktop', 'open-codex-terminal'), [], { env, stdio: 'ignore' });
    child.on('error', () => {}); child.unref(); return child;
  });
  let job = null, preparing = false, terminalChild = null, inputActive = false, lastInput = null;
  const maintenance = () => preparing || job?.status === 'running';
  const busy = () => maintenance() || inputActive;
  const status = () => ({ available: true, maintenance: !!maintenance(), inputBusy: inputActive, input: lastInput ? { ...lastInput } : null });
  const saved = () => readPreferences(config.preferencesFile, config.defaultPreferences);
  async function geometry() {
    try {
      const result = await run('xdotool', ['getdisplaygeometry']);
      if (!/^\d{3,4} \d{3,4}$/.test(result)) return null;
      const [width, height] = result.split(' ').map(Number);
      return width >= 320 && width <= 4096 && height >= 320 && height <= 4096 ? { width, height } : null;
    } catch { return null; }
  }
  async function pane() {
    try {
      const text = await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}']);
      const lines = text.split('\n');
      if (lines.length !== 1) return null;
      const [target, pidText, command, cwd] = lines[0].split('\t');
      const pid = Number(pidText);
      if (target !== 'codex:0.0' || !Number.isInteger(pid) || pid <= 1 || !cwd?.startsWith('/') || /[\r\n\0]/.test(cwd)) return null;
      const resumeId = /codex/i.test(command) ? await inspectSession(pid) : null;
      return { pid, command: command.slice(0, 64), cwd, resumeId, recoverable: command === 'bash' || !!resumeId };
    } catch { return null; }
  }
  async function windows(runner = run) {
    try { return (await runner('xdotool', ['search', '--class', '^codex-on-cloud-terminal$'])).split(/\s+/).filter(value => /^\d+$/.test(value)).slice(0, 8); }
    catch { return []; }
  }
  async function openTerminal() {
    const deadline = Date.now() + 4000;
    const bounded = (command, args) => {
      if (Date.now() >= deadline) throw new Error('terminal opening timed out');
      return run(command, args, { timeout: Math.min(2000, deadline - Date.now()) });
    };
    const ids = await windows(bounded);
    if (ids.length) {
      try { await bounded('xdotool', ['windowactivate', '--sync', ids[0]]); }
      catch { await bounded('xdotool', ['windowfocus', ids[0]]); }
      return;
    }
    // An existing private tmux server belongs to the desktop, never create it here.
    await bounded('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-a', '-F', '#{pane_pid}']);
    if (terminalChild && terminalChild.exitCode === null && terminalChild.signalCode === null) throw new Error('terminal opening');
    terminalChild = launch();
    while (Date.now() < deadline) {
      if ((await windows(bounded)).length) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('terminal did not open');
  }
  const performInput = dependencies.performInput || (body => body.action === 'terminal' ? openTerminal() : executeInput(body, env));
  async function input(body) {
    let value;
    try { value = validateInput(body); } catch (error) { throw new ControlError(400, error.message); }
    if (busy()) throw new ControlError(409, '输入或桌面操作正在进行，本次输入未发送');
    inputActive = true;
    const current = { id: randomBytes(12).toString('hex'), action: value.action, status: 'running', startedAt: Date.now(), finishedAt: null };
    lastInput = current;
    try {
      await performInput(value);
      current.status = 'success';
      return { ok: true, outcome: 'success', id: current.id };
    } catch {
      current.status = 'unknown';
      const error = new ControlError(502, '输入结果未知，请先查看桌面确认，避免重复执行');
      error.outcome = 'unknown'; throw error;
    } finally { current.finishedAt = Date.now(); inputActive = false; }
  }
  async function get() {
    const preferences = saved();
    const wasBusy = busy(), snapshot = job ? { ...job } : null;
    const [actual, session] = await Promise.all([geometry(), pane()]);
    return { saved: preferences, revision: preferenceRevision(preferences), actual, session,
      restartRequired: !!actual && (actual.width !== preferences.width || actual.height !== preferences.height),
      busy: wasBusy || busy(), job: snapshot };
  }
  function startJob(type, task) {
    if (busy()) throw new ControlError(409, '已有桌面操作进行中，请等待完成');
    const current = { id: randomBytes(12).toString('hex'), type, status: 'running', message: '正在处理', startedAt: Date.now(), finishedAt: null };
    job = current;
    Promise.resolve().then(() => task(current)).then(message => { current.status = 'complete'; current.message = message || '终端显示已更新'; })
      .catch(() => { current.status = 'failed'; current.message = '操作未完成，请检查本机服务；不会自动重试或重放任务'; })
      .finally(() => { current.finishedAt = Date.now(); });
    return { ...current };
  }
  function save(body) {
    if (busy()) throw new ControlError(409, '已有桌面操作进行中');
    if (body?.revision !== preferenceRevision(saved())) throw new ControlError(409, '设置已变化，请刷新后重新保存');
    let value;
    try { value = validatePreferences({ width: body.width, height: body.height, fontSize: body.fontSize }); }
    catch (error) { throw new ControlError(400, error.message); }
    writePreferences(config.preferencesFile, value);
    job = null;
    return { saved: value, revision: preferenceRevision(value) };
  }
  async function apply(body) {
    if (busy()) throw new ControlError(409, '已有桌面操作进行中');
    if (body?.confirm !== true) throw new ControlError(400, '应用分辨率需要明确确认重启');
    preparing = true;
    let view;
    try {
      view = await get();
      if (body.revision !== view.revision || body.panePid !== view.session?.pid || (body.resumeId ?? null) !== view.session?.resumeId) throw new ControlError(409, '设置或会话已变化，请刷新后重新确认');
      if (!view.actual || !view.restartRequired || !view.session?.recoverable) throw new ControlError(409, '当前无法安全应用；请确认只有一个可恢复会话，或先结束前台任务');
    } finally { preparing = false; }
    return startJob('apply', async current => {
      current.message = '正在重启独立桌面';
      await run('systemctl', ['--user', 'restart', 'codex-cloud-desktop.service'], { env: config.env, timeout: 25000 });
      const deadline = current.startedAt + 45000;
      let ready = false;
      while (Date.now() < deadline) {
        const actual = await geometry(), session = await pane();
        if (actual?.width === view.saved.width && actual?.height === view.saved.height && session?.command === 'bash' && session.pid !== view.session.pid) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error('desktop startup timed out');
      if (view.session.resumeId) {
        current.message = '正在恢复已确认的会话';
        // Keep all shell text fixed. The cwd and ID cross tmux as separate argv data.
        await run('tmux', ['-S', env.TMUX_SOCKET, 'set-environment', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID', view.session.resumeId]);
        try {
          await run('tmux', ['-S', env.TMUX_SOCKET, 'respawn-pane', '-k', '-t', 'codex:0.0', '-c', view.session.cwd, RESUME_COMMAND]);
        } finally {
          await run('tmux', ['-S', env.TMUX_SOCKET, 'set-environment', '-u', '-t', 'codex', 'CODEX_CLOUD_RESUME_ID']);
        }
        let resumed = false;
        while (Date.now() < deadline) {
          if ((await pane())?.resumeId === view.session.resumeId) { resumed = true; break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!resumed) throw new Error('session launch not observed');
      }
      return view.session.resumeId ? '桌面设置已应用，已按准确 ID 启动会话恢复' : '桌面设置已应用，新的 shell 已就绪';
    });
  }
  function terminal(body) {
    if (!['font', 'maximize', 'restore'].includes(body?.action)) throw new ControlError(400, '不支持的终端显示动作');
    if (body.action === 'font' && body.revision !== preferenceRevision(saved())) throw new ControlError(409, '字号配置已变化，请刷新后重试');
    return startJob('terminal', async current => {
      if (!await geometry()) throw new Error('display unavailable');
      const ids = await windows();
      if (body.action === 'font') {
        current.message = '正在更新终端窗口，tmux 任务保留';
        const before = await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-a', '-F', '#{pane_pid}']);
        for (const id of ids) await run('xdotool', ['windowclose', id]);
        const deadline = Date.now() + 6000;
        while ((await windows()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        if ((await windows()).length) throw new Error('terminal did not close');
        while (terminalChild && terminalChild.exitCode === null && terminalChild.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        if (terminalChild && terminalChild.exitCode === null && terminalChild.signalCode === null) throw new Error('terminal still running');
        terminalChild = launch();
        while (!(await windows()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        if (!(await windows()).length) throw new Error('terminal did not open');
        const after = await run('tmux', ['-S', env.TMUX_SOCKET, 'list-panes', '-a', '-F', '#{pane_pid}']);
        if (before !== after) throw new Error('tmux process changed');
      } else {
        if (ids.length !== 1) throw new Error('one managed terminal required');
        await run('python3', [join(config.root, 'desktop', 'terminal-display.py'), body.action, ids[0]]);
      }
    });
  }
  return { get, save, apply, terminal, input, status };
}
