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
  Home: 'Home', End: 'End', Delete: 'Delete', PageUp: 'Prior', PageDown: 'Next',
  'Ctrl+Shift+V': 'ctrl+shift+v', 'Ctrl+V': 'ctrl+v', 'Ctrl+Z': 'ctrl+z',
  'Escape Escape': Object.freeze(['Escape', 'Escape']),
});
export function validateInput(body) {
  if (body?.action === 'terminal') return { action: 'terminal' };
  if (body?.action === 'key' && typeof body.key === 'string' && Object.hasOwn(KEYS, body.key)) return { action: 'key', key: body.key, ...terminalTarget(body) };
  if (body?.action === 'paste') {
    if (typeof body.text !== 'string' || !body.text || body.text.includes('\0') || Buffer.byteLength(body.text) > 32 * 1024) throw new Error('请输入不超过 32 KiB 的文字');
    const target = body.target ?? 'terminal';
    if (!['terminal', 'application'].includes(target)) throw new Error('粘贴目标无效');
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
export async function executeInput(body, env, run = runInputCommand) {
  if (body.action === 'paste') {
    await run('xclip', ['-selection', 'clipboard', '-i'], { env, input: body.text });
    await run('xdotool', ['key', '--clearmodifiers', body.target === 'terminal' ? 'ctrl+shift+v' : 'ctrl+v'], { env });
  } else if (body.action === 'key' && typeof body.key === 'string' && Object.hasOwn(KEYS, body.key)) {
    const keys = KEYS[body.key];
    await run('xdotool', ['key', '--clearmodifiers', ...(Array.isArray(keys) ? ['--delay', body.key === 'Escape Escape' ? '80' : '0', ...keys] : [keys])], { env });
  }
  else throw new Error('terminal input requires the desktop controller');
}
