import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resetPassword, validatePassword } from '../native/password-reset.mjs';

export const help = `用法：npm run reset-password -- [选项]
在服务器本机或 SSH 中使用项目部署用户运行，不要 sudo。
  --admin       重置管理员登录密码（交互输入两次，不回显）
  --screen      重设并开启屏幕锁（交互输入两次，不回显）
  --unlock      关闭屏幕锁，保留其他访问设置
  --generate    配合 --admin 自动生成，保存到私有凭据文件，不打印密码
  --help        显示帮助
不带选项时显示操作菜单。不接受命令行密码参数。
运行中的网页面板会停止并恢复，现有映射需重新配对；不会重启桌面或 Codex。
原本未运行的面板保持停止状态；管理员重置不改变屏幕锁。`;

export function options(args) {
  let values;
  try { ({ values } = parseArgs({ args, options: Object.fromEntries(['admin', 'screen', 'unlock', 'generate', 'help'].map(key => [key, { type: 'boolean' }])) })); }
  catch { throw Error('参数无效，不接受命令行密码参数。请运行 npm run reset-password -- --help 查看用法。'); }
  if (values.help) return { help: true };
  const selected = ['admin', 'screen', 'unlock'].filter(key => values[key]);
  if (selected.length > 1 || values.generate && selected[0] !== 'admin') throw Error('请选择 --admin、--screen 或 --unlock 中的一项；--generate 仅配合 --admin 使用');
  return { target: selected[0], generate: !!values.generate };
}
function cancellation() { return Object.assign(Error('已取消，未开始提交的密码不会修改'), { code: 'CANCELLED' }); }
async function terminalQuestion(read, { hidden, signal }) {
  if (!process.stdin.isTTY) throw Error('需要交互式终端输入；自动化可使用 --admin --generate 或 --unlock，不接受明文密码参数');
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stderr;
  const rl = createInterface({ input: process.stdin, output, terminal: true }), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('输入超时，请重新执行')), 120000);
  rl.on('SIGINT', () => controller.abort(cancellation())); rl.on('close', () => controller.abort(cancellation()));
  try { return await read(async label => { if (hidden) process.stderr.write(label); const value = await rl.question(hidden ? '' : label, { signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) }); if (hidden) process.stderr.write('\n'); return value; }); }
  catch (error) { if (controller.signal.aborted) throw controller.signal.reason; if (signal?.aborted) throw signal.reason; throw error; }
  finally { clearTimeout(timer); rl.close(); if (hidden) { process.stderr.write('\n'); output.end(); } }
}
export async function passwordPrompt(target, signal) {
  return terminalQuestion(async ask => {
    const first = await ask('输入新密码：'); validatePassword(first, target);
    const second = await ask('再次输入新密码：'); if (first !== second) throw Error('两次输入不一致，未修改密码');
    return first;
  }, { hidden: true, signal });
}
async function main() {
  const parsed = options(process.argv.slice(2)); if (parsed.help) return console.log(help);
  const controller = new AbortController(), abort = () => controller.abort(cancellation());
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, abort);
  try {
    if (!parsed.target) parsed.target = await terminalQuestion(async ask => {
      const selected = (await ask('1. 重置管理员密码\n2. 重设屏幕锁密码\n3. 关闭屏幕锁\n请选择 1 / 2 / 3：')).trim();
      if (!['1', '2', '3'].includes(selected)) throw Error('选择无效，未修改密码');
      return ['admin', 'screen', 'unlock'][Number(selected) - 1];
    }, { hidden: false, signal: controller.signal });
    await resetPassword(parsed, { root: fileURLToPath(new URL('../', import.meta.url)), signal: controller.signal, prompt: target => passwordPrompt(target, controller.signal) });
  } finally { for (const event of ['SIGINT', 'SIGTERM']) process.removeListener(event, abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = error.code === 'CANCELLED' || error.cause?.code === 'CANCELLED' ? 130 : 1; });
}
