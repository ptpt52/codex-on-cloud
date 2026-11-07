import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNodeDirectory } from '../panel/public/node-directory.js';
import { portalRead, portalWrite } from './portal-files.mjs';
export const PORTAL_COMPATIBILITY_DATE = '2026-11-01';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildPortal({ config = join(root, 'data/portal-nodes.json'), output = join(root, 'data/portal-build'), passwordFile = join(root, 'secrets/portal_password') }) {
  const directory = parseNodeDirectory(await portalRead(resolve(config), 32768)), password = (await portalRead(passwordFile, 128, true)).trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw Error('请先执行 npm run portal:setup，生成随机门户密码');
  const definitions = [['/', 'index.html', 'text/html; charset=utf-8'], ['/portal.js', 'portal.js', 'text/javascript; charset=utf-8'], ['/portal.css', 'portal.css', 'text/css; charset=utf-8'], ['/node-directory.js', '../panel/public/node-directory.js', 'text/javascript; charset=utf-8']];
  const assets = {};
  for (const [route, name, type] of definitions) { const body = await readFile(new URL('../portal/' + name, import.meta.url), 'utf8'); if (Buffer.byteLength(body) > 65536) throw Error('门户资源超过 64 KiB'); assets[route] = { body, type }; }
  const sources = await Promise.all(['panel/public/node-directory.js', 'portal/registry.mjs', 'portal/worker.mjs'].map(name => readFile(join(root, name), 'utf8')));
  const bootstrap = JSON.stringify(directory);
  const source = sources.map(text => text.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n') + '\nconst PORTAL_BOOTSTRAP = ' + bootstrap + ';\nclass NodeRegistry extends PortalRegistry { constructor(state, env) { super(state, env, PORTAL_BOOTSTRAP); } }\nexport { NodeRegistry };\nexport default createPortal(' + JSON.stringify({ directory, assets }) + ');\n';
  if (Buffer.byteLength(source) > 262144) throw Error('门户 Worker 超过 256 KiB');
  const wrangler = { name: 'codex-cloud-portal', main: 'worker.mjs', compatibility_date: PORTAL_COMPATIBILITY_DATE, workers_dev: false, preview_urls: false,
    routes: [{ pattern: new URL(directory.portalOrigin).host, custom_domain: true }], durable_objects: { bindings: [{ name: 'NODE_REGISTRY', class_name: 'NodeRegistry' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['NodeRegistry'] }] };
  await portalWrite(join(output, 'worker.mjs'), source);
  await portalWrite(join(output, 'wrangler.json'), JSON.stringify(wrangler, null, 2) + '\n');
  await portalWrite(join(output, 'worker-secrets.json'), JSON.stringify({ PORTAL_PASSWORD_HASH: createHash('sha256').update(password).digest('hex') }) + '\n');
  return { output: resolve(output), origin: directory.portalOrigin, nodes: directory.nodes.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' }, 'password-file': { type: 'string' } } });
  const result = await buildPortal({ ...values, passwordFile: values['password-file'] });
  console.log(`门户已构建：${result.origin}，初始 ${result.nodes} 台服务器\n部署配置：${result.output}/wrangler.json\n新部署会导入初始目录；后续发布保留 Durable Object 中的动态目录。`);
}
