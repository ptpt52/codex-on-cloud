import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readStateFile, writeStateFile } from './state-files.mjs';
import { gatewayConfig, GATEWAY_PREFIX } from '../gateway/protocol.mjs';
const gatewayBuildRoot = fileURLToPath(new URL('../', import.meta.url));
export const GATEWAY_COMPATIBILITY_DATE = '2026-11-01';
export async function buildGateway({ config = join(gatewayBuildRoot, 'data/gateway.json'), output = join(gatewayBuildRoot, 'data/gateway-build'), passwordFile = join(gatewayBuildRoot, 'secrets/gateway_password') } = {}) {
  let parsed; try { parsed = JSON.parse(await readStateFile(config, 2048, true)); } catch { throw Error('请先运行 gateway:setup，或检查网关配置'); }
  const settings = gatewayConfig(parsed), password = (await readStateFile(passwordFile, 128, true)).trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw Error('网关密码格式无效');
  const assets = {};
  for (const [name, type] of [['index.html', 'text/html; charset=utf-8'], ['gateway.js', 'text/javascript; charset=utf-8'], ['gateway.css', 'text/css; charset=utf-8']]) {
    const body = await readFile(join(gatewayBuildRoot, 'gateway', name), 'utf8'); if (Buffer.byteLength(body) > 65536) throw Error('网关资源超过 64 KiB');
    assets[GATEWAY_PREFIX + (name === 'index.html' ? '' : name)] = { body, type };
  }
  const sources = await Promise.all(['protocol.mjs', 'registry.mjs', 'worker.mjs'].map(name => readFile(join(gatewayBuildRoot, 'gateway', name), 'utf8')));
  const source = sources.map(text => text.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n') + '\nconst GATEWAY_BOOTSTRAP = ' + JSON.stringify(settings) + ';\nclass GatewayState extends GatewayRegistry { constructor(state, env) { super(state, env, GATEWAY_BOOTSTRAP); } }\nexport { GatewayState };\nexport default createGateway(' + JSON.stringify({ config: settings, assets }) + ');\n';
  if (Buffer.byteLength(source) > 262144) throw Error('网关 Worker 超过 256 KiB');
  const wrangler = { name: 'codex-cloud-gateway', main: 'worker.mjs', compatibility_date: GATEWAY_COMPATIBILITY_DATE, workers_dev: false, preview_urls: false,
    routes: [{ pattern: new URL(settings.origin).host, custom_domain: true }], durable_objects: { bindings: [{ name: 'GATEWAY_REGISTRY', class_name: 'GatewayState' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['GatewayState'] }] };
  await writeStateFile(join(output, 'worker.mjs'), source); await writeStateFile(join(output, 'wrangler.json'), JSON.stringify(wrangler, null, 2) + '\n');
  await writeStateFile(join(output, 'worker-secrets.json'), JSON.stringify({ GATEWAY_PASSWORD_HASH: createHash('sha256').update(password).digest('hex') }) + '\n');
  return { output: resolve(output), origin: settings.origin };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' }, 'password-file': { type: 'string' } } });
    const result = await buildGateway({ ...values, passwordFile: values['password-file'] });
    console.log(`网关已构建：${result.origin}\n配置：${result.output}/wrangler.json\n凭据文件未加入代码；尚未部署 Worker 或修改域名。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
