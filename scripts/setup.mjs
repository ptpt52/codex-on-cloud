import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { origin: { type: 'string' }, username: { type: 'string', default: 'admin' }, 'allow-host': { type: 'string', multiple: true, default: [] } } });
const origin = new URL(values.origin || 'http://localhost:36080');
if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('--origin 必须是 HTTP(S) 根地址');
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(values.username)) throw new Error('用户名只支持字母、数字、下划线和短横线');
const hosts = values['allow-host'];
if (!hosts.every(host => /^[a-zA-Z0-9.:[\]-]+$/.test(host))) throw new Error('--allow-host 无效');
const secrets = join(root, 'secrets');
await mkdir(secrets, { recursive: true, mode: 0o700 });
await chmod(secrets, 0o700);
let existing = false;
try { await access(join(root, '.env')); existing = true; } catch {}
if (existing) {
  console.log('已有 .env，保留现有设置和密钥。需要修改域名时请编辑 .env。');
  process.exit(0);
}
async function createSecret(name) {
  const path = join(secrets, name);
  const value = randomBytes(32).toString('base64url');
  try { await writeFile(path, value + '\n', { flag: 'wx', mode: 0o600 }); return value; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`secrets/${name} 已存在，但没有 .env。请检查是否是未完成的初始化；不会覆盖旧密钥。`);
  }
}
const password = await createSecret('panel_password');
await createSecret('desktop_password');
await createSecret('agent_secret');
await writeFile(join(secrets, 'tunnel_token'), '', { flag: 'wx', mode: 0o600 });
await writeFile(join(secrets, 'credentials.txt'), `工作台：${origin.origin}\n用户名：${values.username}\n密码：${password}\n\n请妥善保管此文件，不要提交到 Git。\n`, { flag: 'wx', mode: 0o600 });
const extraHosts = [...new Set([...(origin.protocol === 'http:' ? ['127.0.0.1:36080'] : []), ...hosts])];
const env = `# 修改域名后用 docker compose up -d 重建面板，使配置生效。\nPUBLIC_ORIGIN=${origin.origin}\nALLOWED_HOSTS=${extraHosts.join(',')}\nADMIN_USER=${values.username}\nPANEL_PORT=36080\nWORKSPACE_DIR=./workspaces\nCODEX_VERSION=0.166.0\nTZ=Asia/Shanghai\n`;
await writeFile(join(root, '.env'), env, { flag: 'wx', mode: 0o600 });
await mkdir(join(root, 'workspaces', 'transfer'), { recursive: true });
console.log(`初始化完成：${resolve(root)}\n登录信息已保存到 secrets/credentials.txt（未在终端输出密码）。\n接下来运行 docker compose up -d --build。`);
