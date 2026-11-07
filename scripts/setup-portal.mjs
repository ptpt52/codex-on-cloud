import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portalRead, portalWrite } from './portal-files.mjs';
import { parseNodeDirectory } from '../panel/public/node-directory.js';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function setupPortal({ origin, home, work, rotatePassword = false, root = projectRoot }) {
  const passwordFile = join(root, 'secrets/portal_password'); let password;
  try { password = (await portalRead(passwordFile, 128, true)).trim(); if (!/^[a-f0-9]{64}$/.test(password)) throw Error('门户密码文件无效'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!password || rotatePassword) await portalWrite(passwordFile, randomBytes(32).toString('hex') + '\n');
  const config = join(root, 'data/portal-nodes.json');
  try { parseNodeDirectory(await portalRead(config, 32768)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const nodes = home ? [{ id: 'home', name: 'home', origin: home, mode: 'desktop', description: '家里的服务器', enabled: true }] : [];
    if (work) nodes.push({ id: 'work', name: 'work', origin: work, mode: 'desktop', description: '工作服务器', enabled: false });
    const directory = parseNodeDirectory({ version: 1, portalOrigin: origin, nodes }); await portalWrite(config, JSON.stringify(directory, null, 2) + '\n', { exclusive: true });
  }
  return { config, passwordFile };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, home: { type: 'string' }, work: { type: 'string' }, 'rotate-password': { type: 'boolean' } } });
  const result = await setupPortal({ ...values, rotatePassword: values['rotate-password'] });
  console.log(`门户已准备。初始目录：${result.config}\n门户密码保存在 ${result.passwordFile}，未输出密码。\n后续增删服务器在门户管理，不需重新部署。`);
}
