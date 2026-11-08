import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { TERMINAL_IDS, terminalLimit } from '../panel/public/terminal-slots.js';

export const TERMINALS = Object.freeze([
  { id: 'main', session: 'codex', name: 'Codex 主终端', className: 'codex-on-cloud-terminal' },
  ...TERMINAL_IDS.slice(1).map(id => ({ id, session: `codex-${id}`, name: `辅助终端 ${id.slice(3)}`, className: `codex-on-cloud-terminal-${id}` })),
].map(Object.freeze));
const definitions = new Map(TERMINALS.map(item => [item.id, item]));
const fail = (status, message) => Object.assign(new Error(message), { status, outcome: 'rejected' });
export function terminalTarget(body) {
  if (body.terminalId === undefined && body.terminalToken === undefined) return {};
  if (!definitions.has(body.terminalId) || typeof body.terminalToken !== 'string' || !/^%\d{1,10}:\d{1,10}$/.test(body.terminalToken)) throw fail(400, '终端目标无效');
  return { terminalId: body.terminalId, terminalToken: body.terminalToken };
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 24 || Buffer.byteLength(value) > 96 || /[\x00-\x1f\x7f]/.test(value)) throw fail(400, '名称需为 1–24 个字符，不含控制字符');
  return value.trim();
}
async function processParent(pid) {
  const file = await open(`/proc/${pid}/status`, 'r');
  try {
    const buffer = Buffer.alloc(8193), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) return '';
    return buffer.subarray(0, bytesRead).toString().match(/^PPid:\s*(\d+)$/m)?.[1] || '';
  } finally { await file.close(); }
}
export function createTerminalManager(config, { run, launch, parentPid = processParent }) {
  const limit = terminalLimit(config.maxTerminals);
  const tmux = args => run('tmux', ['-S', join(config.runtime, 'tmux.sock'), ...args]);
  const children = new Map(); // Eight fixed window slots; no queue or persisted intents.
  async function list() {
    let text;
    try { text = await tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{window_index}\t#{pane_index}\t#{@codex_cloud_name}']); }
    catch { throw fail(503, '私有终端服务未就绪'); }
    if (Buffer.byteLength(text) > 16 * 1024 || text.split('\n').length > 32) throw fail(409, '终端布局超出管理范围');
    const terminals = [];
    for (const definition of TERMINALS) {
      const rows = text.split('\n').map(line => line.split('\t')).filter(fields => fields[0] === definition.session);
      if (!rows.length) continue;
      const [session, paneId, pid, command, window, pane, label = ''] = rows[0];
      const supported = rows.length === 1 && /^%\d{1,10}$/.test(paneId) && /^\d{1,10}$/.test(pid) && Number(pid) > 1 && window === '0' && pane === '0';
      let title = definition.name;
      try { if (label) title = name(label); } catch {}
      terminals.push({ id: definition.id, name: title, command: String(command || '').slice(0, 64), supported,
        token: supported ? `${paneId}:${pid}` : null, primary: session === 'codex' });
    }
    return { terminals, limit, slots: TERMINALS.slice(0, limit).map(({ id, name }) => ({ id, name })) };
  }
  async function selected(body) {
    terminalTarget(body);
    const terminal = (await list()).terminals.find(item => item.id === body.terminalId);
    if (!terminal?.supported || terminal.token !== body.terminalToken) throw fail(409, '终端已结束或布局已变化，请刷新终端列表后重新选择');
    return terminal;
  }
  async function windows(id) {
    let text;
    try { text = await run('xdotool', ['search', '--class', `^${definitions.get(id).className}$`]); } catch { return []; }
    const values = text.trim().split(/\s+/).filter(value => /^\d{1,12}$/.test(value));
    if (values.length > 1) throw fail(409, '该终端有多个窗口，请先保留一个窗口');
    return values;
  }
  async function windowClient(windowId) {
    let windowPid;
    const starting = () => Object.assign(fail(409, '终端窗口进程无法识别，本次输入未发送'), { code: 'terminal_window_starting' });
    try { windowPid = await run('xdotool', ['getwindowpid', windowId]); } catch { throw starting(); }
    if (!/^\d{1,10}$/.test(windowPid)) throw starting();
    const clients = await tmux(['list-clients', '-F', '#{client_pid}\t#{client_tty}\t#{session_name}']);
    if (Buffer.byteLength(clients) > 8192 || clients.split('\n').length > 16) throw fail(409, '终端连接超出管理范围，本次输入未发送');
    const matches = [];
    for (const line of clients.split('\n')) {
      const [pid, tty, session] = line.split('\t');
      if (/^\d{1,10}$/.test(pid) && /^\/dev\/pts\/\d{1,10}$/.test(tty) && await parentPid(pid).catch(() => '') === windowPid) matches.push({ tty, session });
    }
    if (matches.length !== 1) throw Object.assign(fail(409, '窗口的 tmux 连接无法识别，本次输入未发送'), { code: matches.length ? 'terminal_window_ambiguous' : 'terminal_window_starting' });
    return matches[0];
  }
  async function assertFocused(body) {
    await selected(body);
    const ids = await windows(body.terminalId);
    if (ids.length !== 1 || (await run('xdotool', ['getactivewindow'])) !== ids[0]) throw fail(409, '终端焦点已变化，本次输入未发送，请重新选择目标');
    if ((await windowClient(ids[0])).session !== definitions.get(body.terminalId).session) throw fail(409, '窗口已连接其他 tmux 会话，本次输入未发送，请在终端管理中重新打开所选终端');
  }
  async function focus(body, reopen = false) {
    const terminal = await selected(body);
    let ids = await windows(terminal.id);
    let opening = false;
    const deadline = Date.now() + 3500;
    if (!ids.length && reopen) {
      const previous = children.get(terminal.id);
      if (previous && previous.exitCode === null && previous.signalCode === null) throw fail(409, '终端窗口正在打开，请稍后刷新');
      const child = await launch(terminal.id); if (child) children.set(terminal.id, child);
      opening = true;
      while (!ids.length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); ids = await windows(terminal.id); }
    }
    if (ids.length !== 1) throw fail(409, '终端窗口已关闭，请先在终端管理中打开');
    let client;
    if (reopen) {
      // A new xterm maps its X window before its tmux client has registered.
      // Wait only for that new client's read-only identity check, within the
      // same opening deadline. Launch, task creation and input are never retried.
      while (true) {
        try { client = await windowClient(ids[0]); break; }
        catch (error) {
          if (!opening || error.code !== 'terminal_window_starting' || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      await selected(body);
    }
    await run('xdotool', ['windowactivate', '--sync', ids[0]]);
    if (reopen) {
      const session = definitions.get(terminal.id).session;
      if (client.session !== session) await tmux(['switch-client', '-c', client.tty, '-t', session]);
    }
    await assertFocused(body);
    return terminal;
  }
  async function manage(body) {
    if (body?.view !== undefined && body.view !== 'terminal') throw fail(400, '终端视图无效');
    if (body?.action === 'create') {
      const label = name(body.name);
      if (body.terminalToken !== undefined || (body.terminalId !== undefined && !TERMINALS.slice(0, limit).some(item => item.id === body.terminalId))) throw fail(400, '新终端位置无效');
      const before = await list();
      if (before.terminals.length >= limit) throw fail(409, `最多保留 ${limit} 个终端，请先退出不用的终端`);
      if (before.terminals.some(item => item.id === 'main' && !item.supported)) throw fail(409, '主终端布局无法识别，暂不创建辅助终端');
      const slot = body.terminalId ? definitions.get(body.terminalId) : TERMINALS.slice(0, limit).find(item => !before.terminals.some(terminal => terminal.id === item.id));
      if (!slot) throw fail(409, `最多保留 ${limit} 个终端，请先退出不用的终端`);
      if (before.terminals.some(item => item.id === slot.id)) throw fail(409, '该位置已有终端，请刷新列表后选择');
      // Share the primary shell's initialization, including the user bashrc and
      // selected tool PATH. Multiple argv entries avoid a shell-command string;
      // the script path and workspace stay literal, even with shell characters.
      // Migrate the default for new panes on an already-running private server.
      // tmux keeps the history limit of every existing pane unchanged.
      await tmux(['set-option', '-g', 'history-limit', '10000']);
      await tmux(['new-session', '-d', '-s', slot.session, '-c', config.workspace, 'bash', join(config.root, 'desktop', 'codex-session')]);
      try {
        await tmux(['set-option', '-t', slot.session, '@codex_cloud_name', label]);
        const result = await list();
        const created = result.terminals.find(item => item.id === slot.id);
        if (body.view !== 'terminal') await focus({ terminalId: created.id, terminalToken: created.token }, true);
        return { ...result, created: slot.id, opened: slot.id };
      } catch { throw Object.assign(new Error('终端可能已创建，请刷新列表确认，不要重复新建'), { status: 503, outcome: 'unknown' }); }
    }
    if (!['rename', 'open', 'close'].includes(body?.action)) throw fail(400, '不支持的终端操作');
    if (body.action === 'close' && body.confirm !== true) throw fail(400, '结束终端需要确认');
    const terminal = await selected(body);
    if (body.action === 'close') {
      const session = definitions.get(terminal.id).session, [pane, pid] = terminal.token.split(':');
      // tmux evaluates this format and executes the fixed command in its own
      // command queue. No shell runs, and a reused slot or changed layout cannot
      // be killed between the identity check and the mutation.
      const guard = `#{==:#{session_name}:#{pane_id}:#{pane_pid}:#{session_windows}:#{window_panes}:#{window_index}:#{pane_index},${session}:${pane}:${pid}:1:1:0:0}`;
      const guarded = async command => {
        let result;
        try { result = await tmux(['if-shell', '-F', '-t', pane, guard, command, 'display-message -p STALE_TARGET']); }
        catch { throw Object.assign(new Error('结束结果未知，请刷新列表确认，不会自动重试'), { status: 503, outcome: 'unknown' }); }
        if (result.includes('STALE_TARGET')) throw fail(409, '终端已变化，未执行结束；请刷新列表');
      };
      // Older desktop deployments have no hidden keeper. Create at most one on
      // the *existing* server before closing, so even closing the final terminal
      // preserves that server's desktop/host lifetime. if-shell cannot start a
      // replacement tmux server owned by the panel or manager.
      try { await tmux(['has-session', '-t', '=codex-host']); }
      catch {
        if (config.mode === 'terminal') throw fail(503, '终端后台保活会话缺失，请检查后台');
        await guarded('new-session -d -s codex-host sleep infinity');
      }
      await guarded(`kill-session -t =${session}`);
      try { return { ...(await list()), closed: terminal.id }; }
      catch { throw Object.assign(new Error('结束结果未知，请刷新列表确认，不会自动重试'), { status: 503, outcome: 'unknown' }); }
    }
    if (body.action === 'rename') await tmux(['set-option', '-t', definitions.get(terminal.id).session, '@codex_cloud_name', name(body.name)]);
    else if (body.view !== 'terminal') await focus(body, true);
    return { ...(await list()), opened: body.action === 'open' ? terminal.id : undefined };
  }
  return { list, manage, focus, assertFocused };
}
