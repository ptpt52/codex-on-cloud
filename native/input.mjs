import { spawn } from 'node:child_process';
import { terminalTarget } from './terminals.mjs';

const KEYS = Object.freeze({ Enter: 'Return', Tab: 'Tab', Escape: 'Escape', Backspace: 'BackSpace',
  'Ctrl+C': 'ctrl+c', 'Ctrl+D': 'ctrl+d', 'Ctrl+L': 'ctrl+l', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  'Ctrl+J': 'ctrl+j', 'Ctrl+R': 'ctrl+r', 'Ctrl+O': 'ctrl+o', 'Ctrl+G': 'ctrl+g',
  'Ctrl+A': 'ctrl+a', 'Ctrl+E': 'ctrl+e', 'Ctrl+U': 'ctrl+u', 'Ctrl+K': 'ctrl+k', 'Ctrl+W': 'ctrl+w', 'Ctrl+Y': 'ctrl+y',
  // This xterm's default Meta mode sets the high bit. Fixed ESC prefixes are
  // the terminal encoding of Alt chords and work without restarting xterm.
  'Alt+Backspace': Object.freeze(['Escape', 'BackSpace']), 'Alt+D': Object.freeze(['Escape', 'd']),
  'Alt+B': Object.freeze(['Escape', 'b']), 'Alt+F': Object.freeze(['Escape', 'f']),
  'Ctrl+ArrowLeft': 'ctrl+Left', 'Ctrl+ArrowRight': 'ctrl+Right', 'Shift+Tab': 'shift+Tab',
  'Shift+ArrowLeft': 'shift+Left', 'Shift+ArrowRight': 'shift+Right',
  Home: 'Home', End: 'End', Delete: 'Delete', PageUp: 'Prior', PageDown: 'Next',
  'Ctrl+Shift+V': 'ctrl+shift+v', 'Ctrl+V': 'ctrl+v', 'Ctrl+Z': 'ctrl+z',
  'Escape Escape': Object.freeze(['Escape', 'Escape']),
});
export function validateInput(body) {
  if (body?.action === 'terminal') return { action: 'terminal' };
  if (body?.action === 'key' && typeof body.key === 'string' && Object.hasOwn(KEYS, body.key)) return { action: 'key', key: body.key, ...terminalTarget(body) };
  if (body?.action === 'edit') {
    if (typeof body.text !== 'string' || body.text.includes('\0') || Buffer.byteLength(body.text) > 32768 || !Number.isInteger(body.erase) || body.erase < 0 || body.erase > 512 || !body.erase && !body.text) throw Error('文字改写参数无效');
    const focus = body.focus;
    if (body.target !== 'focused' || body.terminalId !== undefined || body.terminalToken !== undefined || !focus || typeof focus.window !== 'string' || !/^[1-9]\d{0,9}$/.test(focus.window) || Number(focus.window) > 0xffffffff || !['terminal', 'application'].includes(focus.target)) throw Error('文字改写需要已确认的原输入窗口');
    return { action: 'edit', text: body.text, erase: body.erase, target: 'focused', focus: { window: focus.window, target: focus.target } };
  }
  if (body?.action === 'paste') {
    if (typeof body.text !== 'string' || !body.text || body.text.includes('\0') || Buffer.byteLength(body.text) > 32 * 1024) throw new Error('请输入不超过 32 KiB 的文字');
    const target = body.target ?? 'terminal';
    if (!['terminal', 'application', 'focused'].includes(target)) throw new Error('粘贴目标无效');
    const terminal = terminalTarget(body);
    if (terminal.terminalId && target !== 'terminal') throw new Error('指定终端时请使用终端粘贴');
    return { action: 'paste', text: body.text, target, ...terminal };
  }
  throw new Error('不支持的输入动作');
}
// Each fixed command has a hard deadline. No stdin text is ever shell code.
export function runInputCommand(command, args, { env, input, timeout = 2000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'ignore', 'ignore'] });
    let failure;
    const timer = setTimeout(() => { failure = new Error('input command timed out'); child.kill('SIGKILL'); }, timeout);
    child.once('error', error => { failure = error; });
    child.stdin.on('error', error => { failure ||= error; });
    child.once('close', code => { clearTimeout(timer); if (failure || code !== 0) reject(failure || new Error('input command failed')); else resolve(); });
    child.stdin.end(input);
  });
}
export async function focusedInputTarget(run) {
  const deadline = Date.now() + 1500;
  const query = (command, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('输入窗口检查超时');
    return run(command, args, { timeout: Math.min(500, remaining), maxBuffer: 16384 });
  };
  // Keep the real X11 input child for the focus check. Its WM_CLASS may live
  // on an ancestor; checking only that ancestor would miss a widget change.
  const window = await query('xdotool', ['getwindowfocus', '-f']);
  if (!/^[1-9]\d{0,9}$/.test(window) || Number(window) > 0xffffffff) throw new Error('没有可接收文字的窗口');
  let client = window;
  for (let depth = 0; depth < 16; depth++) {
    const properties = await query('xprop', ['-id', client, 'WM_CLASS']);
    if (properties.length > 4096) throw new Error('输入窗口信息过大');
    if (/^WM_CLASS\(STRING\) = /.test(properties)) {
      const terminal = /"(?:codex-on-cloud-terminal(?:-aux[1-7])?|[Xx][Tt]erm|UXTerm|[Xx]fce4-terminal)"/.test(properties);
      return { window, target: terminal ? 'terminal' : 'application' };
    }
    const tree = await query('xwininfo', ['-id', client, '-children']);
    const parent = Number.parseInt(tree.match(/Parent window id:\s+(0x[0-9a-f]+)/i)?.[1], 16);
    if (!Number.isInteger(parent) || parent <= 0 || parent > 0xffffffff || String(parent) === client) break;
    client = String(parent);
  }
  throw new Error('无法识别输入窗口');
}
export async function executeInput(body, env, run = runInputCommand, writeClipboard, focus) {
  if (body.action === 'paste' || body.action === 'edit') {
    const destination = body.target === 'focused' ? await focus() : null;
    const changed = () => { throw Object.assign(new Error('桌面输入窗口已变化，文字未修改'), { status: 409, outcome: 'rejected' }); };
    if (body.action === 'edit' && (!destination || destination.window !== body.focus.window || destination.target !== body.focus.target)) changed();
    if (body.text) {
      if (writeClipboard) await writeClipboard(body.text);
      else await run('xclip', ['-selection', 'clipboard', '-i'], { env, input: body.text });
    }
    if (destination) {
      const after = await focus();
      if (after.window !== destination.window || after.target !== destination.target) changed();
    }
    const pasteKey = (destination?.target || body.target) === 'terminal' ? 'ctrl+shift+v' : 'ctrl+v';
    await run('xdotool', ['key', '--clearmodifiers', ...(body.action === 'edit' ? ['--delay', '0', ...Array(body.erase).fill('BackSpace'), ...(body.text ? [pasteKey] : [])] : [pasteKey])], { env });
    return destination ? { focus: destination } : undefined;
  } else if (body.action === 'key' && typeof body.key === 'string' && Object.hasOwn(KEYS, body.key)) {
    const keys = KEYS[body.key];
    await run('xdotool', ['key', '--clearmodifiers', ...(Array.isArray(keys) ? ['--delay', body.key === 'Escape Escape' ? '80' : '0', ...keys] : [keys])], { env });
  }
  else throw new Error('terminal input requires the desktop controller');
}
