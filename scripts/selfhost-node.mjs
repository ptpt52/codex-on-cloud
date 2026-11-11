import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { maintenanceSettings, root } from '../native/config.mjs';
import { joinNode, leaveNode, nodeDoctor, nodeStatus } from '../selfhost/node.mjs';

async function line(prompt) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await readline.question(prompt)).trim(); } finally { readline.close(); }
}

async function secret(prompt) {
  if (!process.stdin.isTTY) {
    const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try { for await (const value of readline) return value.trim(); } finally { readline.close(); }
    throw Error('没有从标准输入读取到授权 key');
  }
  process.stdout.write(prompt);
  const input = process.stdin, previousRaw = input.isRaw; let value = '';
  input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  const cleanup = () => { input.setRawMode(previousRaw); input.pause(); };
  try {
    while (true) {
      const [chunk] = await once(input, 'data');
      for (const character of chunk) {
        if (character === '\u0003') throw Error('已取消');
        if (character === '\r' || character === '\n') { process.stdout.write('\n'); return value.trim(); }
        if (character === '\u007f' || character === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } }
        else if (character >= ' ' && character <= '~') { value += character; process.stdout.write('*'); }
      }
    }
  } finally { cleanup(); }
}

try {
  const command = process.argv[2] || 'help', { values } = parseArgs({ args: process.argv.slice(3), options: {
    server: { type: 'string' }, slug: { type: 'string' }, replace: { type: 'boolean' }, reauthorize: { type: 'boolean' }, 'switch-existing': { type: 'boolean' }, recover: { type: 'boolean' }, 'ca-file': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || command === 'help') {
    console.log(`用法：\n  npm run server:join -- [--server https://desk.example.com] [--slug node-a]\n  npm run server:leave [--recover]\n  npm run server:status\n  npm run server:doctor\n\njoin 的授权 key 只从隐藏终端或标准输入读取，不能作为命令行参数传入。\n--ca-file 用于中心证书不来自系统信任库的导入证书场景。\n--reauthorize 在当前中心和路径上读取新的 key，替换失效的旧节点凭据。\n--replace 允许用新 key 替换本机已有的其他中心或路径配置。\n--switch-existing 允许接管已有 Cloudflare/Gateway 发布；server:leave 会恢复原 Panel 配置。\n--recover 处理上次 join 回滚未完全确认的记录。`);
  } else if (command === 'join') {
    if (process.platform !== 'linux') throw Error('节点接入当前只支持 Linux/Ubuntu');
    const native = maintenanceSettings(), server = values.server || await line('中心服务器地址：'), slug = values.slug || await line('节点路径 slug：');
    const result = await joinNode({ root, server, slug, mode: native.mode, panelPort: native.panelPort, caFile: values['ca-file'], replace: values.replace === true, reauthorize: values.reauthorize === true, switchExisting: values['switch-existing'] === true, promptKey: () => secret('授权 key：') });
    console.log(`节点已接入：${result.connection.origin}${result.connection.path}`);
    console.log(`中继服务：${result.unit}`);
    for (const warning of result.warnings) console.log(`警告：${warning}`);
  } else if (command === 'leave') {
    const result = await leaveNode({ root, recover: values.recover === true });
    console.log(`已停止并清理本机节点中继：${result.origin}${result.slug ? '/node/' + result.slug + '/' : ''}`);
    if (result.warning) console.log(`提示：${result.warning}`);
  } else if (command === 'status') {
    console.log(JSON.stringify(await nodeStatus({ root }), null, 2));
  } else if (command === 'doctor') {
    const result = await nodeDoctor({ root });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else throw Error('未知命令：' + command);
} catch (error) { console.error(error.message); process.exitCode = 1; }
