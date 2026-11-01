import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { root } from '../native/config.mjs';

const { values } = parseArgs({ options: { origin: { type: 'string' }, username: { type: 'string', default: 'admin' }, 'allow-host': { type: 'string', multiple: true, default: [] } } });
const origin = new URL(values.origin || 'http://localhost:36080');
if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('--origin 必须是 HTTP(S) 根地址');
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(values.username)) throw new Error('用户名只支持字母、数字、下划线和短横线');
if (!values['allow-host'].every(host => /^[a-zA-Z0-9.:[\]-]+$/.test(host))) throw new Error('--allow-host 无效');
const directory = join(root, 'secrets');
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
async function keepOrCreate(name, value) {
  const file = join(directory, name);
  try { await writeFile(file, value, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(file, 0o600);
  return readFile(file, 'utf8');
}
const password = (await keepOrCreate('panel_password', randomBytes(32).toString('base64url') + '\n')).trim();
await keepOrCreate('agent_secret', randomBytes(32).toString('base64url') + '\n');
await keepOrCreate('tunnel_token', '');
await keepOrCreate('credentials.txt', `工作台：${origin.origin}\n用户名：${values.username}\n密码：${password}\n\n实际入口以 .env 为准。请妥善保管，不要提交到 Git。\n`);
const extraHosts = [...new Set([...(origin.protocol === 'http:' ? ['127.0.0.1:36080'] : []), ...values['allow-host']])];
const env = `# 本机原生部署。修改后只重启需要更新配置的服务。\nPUBLIC_ORIGIN=${origin.origin}\nALLOWED_HOSTS=${extraHosts.join(',')}\nADMIN_USER=${values.username}\nPANEL_PORT=36080\nAGENT_PORT=36902\nDISPLAY_NUMBER=93\nDESKTOP_SIZE=1280x1000\nWORKSPACE_DIR=./workspaces\nTZ=Asia/Shanghai\n`;
try { await writeFile(join(root, '.env'), env, { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; console.log('保留已有 .env 和密钥；旧 Docker 的 CODEX_VERSION 配置在原生模式不再使用。'); }
await mkdir(join(root, 'workspaces', 'transfer'), { recursive: true });
await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
console.log('初始化完成，登录信息保存在 secrets/credentials.txt。\n下一步：npm run native:doctor，然后 npm run native:install。');
