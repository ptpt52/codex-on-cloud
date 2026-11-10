import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readStateFile, writeStateFile } from './state-files.mjs';
import { gatewayConfig } from '../gateway/protocol.mjs';
const gatewayProjectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function setupGateway({ origin, backendZone, root = gatewayProjectRoot }) {
  const desired = gatewayConfig({ version: 1, origin, backendZone }), path = join(root, 'data/gateway.json'), passwordFile = join(root, 'secrets/gateway_password');
  let prior = null;
  try { prior = await readStateFile(path, 2048, true); const current = gatewayConfig(JSON.parse(prior)); if (JSON.stringify(current) !== JSON.stringify(desired)) throw Error('已有其他网关配置，不会隐式改绑'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let password;
  try { password = (await readStateFile(passwordFile, 128, true)).trim(); if (!/^[a-f0-9]{64}$/.test(password)) throw Error('网关密码格式无效'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!password) await writeStateFile(passwordFile, randomBytes(32).toString('hex') + '\n', { expected: null });
  if (prior === null) await writeStateFile(path, JSON.stringify(desired, null, 2) + '\n', { expected: null });
  return { config: path, passwordFile, origin: desired.origin };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'backend-zone': { type: 'string' } } });
    const result = await setupGateway({ ...values, backendZone: values['backend-zone'] });
    console.log(`网关配置：${result.config}\n独立登录密码：${result.passwordFile}（未输出密码）\n下一步运行 npm run gateway:build；尚未更改 DNS 或部署 Worker。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
