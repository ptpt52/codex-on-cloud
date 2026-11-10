import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import http from 'node:http';
import { lstat } from 'node:fs/promises';
import { portalRead, portalWrite, portalRemove } from './portal-files.mjs';
import { acquireDeploymentLease } from './deployment-lease.mjs';
import { validateGatewayConnection } from '../native/gateway-config.mjs';
import { gatewayOrigin, gatewayHex, gatewayProxyHeaders, decodeGatewayCode, gatewayJSON } from '../gateway/protocol.mjs';

const gatewayOptional = async (path, limit) => { try { return await portalRead(path, limit, true); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const gatewayEncode = value => JSON.stringify(value, null, 2) + '\n';
const gatewayParse = text => { try { return JSON.parse(text); } catch { throw Error('网关接入恢复记录格式无效'); } };
export async function privateGatewayReady(socketPath, connection) {
  try { const info = await lstat(socketPath); if (!info.isSocket() || info.uid !== process.getuid() || info.mode & 0o077) return false; } catch { return false; }
  return new Promise(resolve => {
    const req = http.get({ socketPath, path: '/readyz', headers: { host: new URL(connection.backendOrigin).host, ...gatewayProxyHeaders({ ...connection, id: connection.nodeId }, connection.origin) }, signal: AbortSignal.timeout(1000) }, res => {
      const chunks = []; let size = 0;
      res.on('data', bytes => { size += bytes.length; if (size > 4096) res.destroy(); else chunks.push(bytes); }); res.on('error', () => resolve(false)); res.on('aborted', () => resolve(false));
      res.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks)); resolve(res.statusCode === 200 && value.ok === true && value.host === true && value.files === true && value.nodeId === connection.nodeId); } catch { resolve(false); } });
    }); req.on('error', () => resolve(false));
  });
}
export function createGatewayJoin({ root, socketPath, request = fetch, ready = privateGatewayReady, reload, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const pendingPath = join(root, 'data/gateway-join.json'), configPath = join(root, 'data/gateway-node.json');
  const files = { env: [join(root, '.env'), 65536], credentials: [join(root, 'secrets/credentials.txt'), 4096], config: [configPath, 4096] };
  return { async join(values) {
    const lease = await acquireDeploymentLease(root), valid = () => lease.check();
    const save = async (stage, expected) => { const text = gatewayEncode(stage); if (Buffer.byteLength(text) > 262144) throw Error('网关恢复状态超过 256 KiB'); await portalWrite(pendingPath, text, { expected, valid }); return text; };
    try {
      for (const name of ['cloudflare-publication.json', 'cloudflare-activation.json']) if (await gatewayOptional(join(root, 'data', name), 262144) !== null) throw Error('已有域名维护待核对，请先完成或解除原操作');
      let text = await gatewayOptional(pendingPath, 262144), stage = text === null ? null : gatewayParse(text);
      if (stage) {
        if (stage.version !== 1 || !gatewayHex(stage.operation) || !['prepared', 'registered'].includes(stage.phase) || !stage.files || typeof stage.codeFile !== 'string' || !stage.codeFile || Buffer.byteLength(stage.codeFile) > 4096 || /[\0\r\n]/.test(stage.codeFile) || !['desktop', 'terminal'].includes(stage.mode)) throw Error('网关接入恢复记录无效');
        validateGatewayConnection(stage.connection);
        for (const [key, [, limit]] of Object.entries(files)) { const file = stage.files[key]; if (!file || typeof file.after !== 'string' || Buffer.byteLength(file.after) > limit || !(file.before === null && key === 'config') && (typeof file.before !== 'string' || Buffer.byteLength(file.before) > limit)) throw Error('网关接入恢复文件无效'); }
        const desired = parseEnv(stage.files.env.after);
        if (stage.files.config.after !== gatewayEncode(stage.connection) || desired.PUBLIC_ORIGIN !== stage.connection.origin || desired.NODE_ID !== stage.connection.nodeId || desired.SHARED_ENTRY !== '1') throw Error('恢复配置与节点身份不一致');
        if (stage.phase === 'registered' && !stage.completed) throw Error('已登记恢复记录缺少完成身份');
        if (stage.completed) {
          validateGatewayConnection(stage.completed);
          if (!stage.completed.registeredAt || Object.entries(stage.connection).some(([key, value]) => key !== 'registeredAt' && stage.completed[key] !== value)) throw Error('已登记身份与准备身份不一致');
        }
        if (values.gateway && gatewayOrigin(values.gateway) !== stage.connection.origin || values.backend && gatewayOrigin(values.backend) !== stage.connection.backendOrigin || values.name && values.name !== stage.connection.name) throw Error('已有不同目标的网关接入待完成');
      } else {
        if (values.abort) throw Error('没有待撤销的网关接入记录');
        const before = {};
        for (const [key, [path, limit]] of Object.entries(files)) before[key] = await gatewayOptional(path, limit);
        if (!before.env || !before.credentials) throw Error('请先完成本机部署初始化');
        const env = parseEnv(before.env), previous = before.config === null ? null : validateGatewayConnection(gatewayParse(before.config));
        const origin = gatewayOrigin(values.gateway || previous?.origin), backendOrigin = gatewayOrigin(values.backend || previous?.backendOrigin);
        if (previous && (previous.origin !== origin || previous.backendOrigin !== backendOrigin)) throw Error('本机已接入其他网关或后端地址，不会隐式改绑');
        const connection = validateGatewayConnection({ version: 1, origin, backendOrigin, nodeId: previous?.nodeId || (gatewayHex(env.NODE_ID) ? env.NODE_ID : randomBytes(16).toString('hex')), name: values.name || previous?.name || new URL(backendOrigin).hostname, secret: previous?.secret || randomBytes(32).toString('hex'), registeredAt: previous?.registeredAt || 0 });
        if (env.NODE_ID && env.NODE_ID !== connection.nodeId) throw Error('节点身份与本机配置不一致');
        let afterEnv = before.env;
        for (const [key, value] of Object.entries({ PUBLIC_ORIGIN: origin, NODE_ID: connection.nodeId, SHARED_ENTRY: '1' })) afterEnv = new RegExp('^' + key + '=.*$', 'm').test(afterEnv) ? afterEnv.replace(new RegExp('^' + key + '=.*$', 'm'), key + '=' + value) : afterEnv + '\n' + key + '=' + value + '\n';
        const parsed = parseEnv(afterEnv); if (parsed.PUBLIC_ORIGIN !== origin || parsed.NODE_ID !== connection.nodeId || parsed.SHARED_ENTRY !== '1') throw Error('环境配置存在重复或冲突项，未修改');
        stage = { version: 1, phase: 'prepared', operation: randomBytes(16).toString('hex'), connection, mode: env.DEPLOY_MODE === 'terminal' ? 'terminal' : 'desktop', codeFile: resolve(values.codeFile || join(root, 'secrets/gateway_code')), files: {
          env: { before: before.env, after: afterEnv }, credentials: { before: before.credentials, after: before.credentials.replace(/^工作台：.*$/m, '工作台：' + origin) }, config: { before: before.config, after: gatewayEncode(connection) } } };
        text = await save(stage, null);
      }
      if (values.abort) {
        if (stage.sent || stage.phase === 'registered') {
          const response = await request(stage.connection.origin + '/__nodes/api/node-status', { method: 'POST', headers: { 'content-type': 'application/json', origin: stage.connection.origin }, body: JSON.stringify({ nodeId: stage.connection.nodeId, secret: stage.connection.secret }), redirect: 'error', signal: AbortSignal.timeout(10000) });
          const result = await gatewayJSON(response); valid();
          if (!response.ok || typeof result.registered !== 'boolean' || typeof result.active !== 'boolean') throw Error('不能确认远端登记状态，未撤销；请先核对网关');
          if (result.registered || result.active) throw Error('节点已在网关登记，请先在网页切换到其他节点并移除此登记，再撤销本机准备');
        }
        for (const [key, [path, limit]] of Object.entries(files)) {
          const item = stage.files[key], current = await gatewayOptional(path, limit), completed = key === 'config' && stage.completed ? gatewayEncode(validateGatewayConnection(stage.completed)) : null;
          if (!item || ![item.before, item.after, ...(completed ? [completed] : [])].includes(current) || item.before !== null && (typeof item.before !== 'string' || Buffer.byteLength(item.before) > limit)) throw Error('准备文件已被人工修改，未撤销或覆盖');
        }
        for (const [key, [path, limit]] of Object.entries(files)) {
          const current = await gatewayOptional(path, limit), before = stage.files[key].before;
          const completed = key === 'config' && stage.completed ? gatewayEncode(validateGatewayConnection(stage.completed)) : null;
          if (![before, stage.files[key].after, ...(completed ? [completed] : [])].includes(current)) throw Error('恢复期间文件已被人工修改，未覆盖');
          if (current === before) continue;
          if (before === null) await portalRemove(path, { expected: current, valid }); else await portalWrite(path, before, { expected: current, valid });
        }
        await reload(lease); valid(); await portalRemove(pendingPath, { expected: text, valid }); return { aborted: true, origin: stage.connection.origin };
      }
      for (const [key, [path, limit]] of Object.entries(files)) {
        const item = stage.files[key], current = await gatewayOptional(path, limit), completed = key === 'config' && stage.completed ? gatewayEncode(validateGatewayConnection(stage.completed)) : null;
        if (!item || typeof item.after !== 'string' || Buffer.byteLength(item.after) > limit || ![item.before, item.after, ...(completed ? [completed] : [])].includes(current)) throw Error('接入准备文件已被修改，未覆盖');
        if (current !== item.after && (completed === null || current !== completed)) await portalWrite(path, item.after, { expected: current, valid });
      }
      if (values.prepareOnly) return { prepared: true, nodeId: stage.connection.nodeId, origin: stage.connection.origin };
      if (stage.phase !== 'registered') {
        if (!await ready(socketPath, stage.connection)) {
          await reload(lease); valid();
          let loaded = false; for (let count = 0; count < 20; count++) { if (await ready(socketPath, stage.connection)) { loaded = true; break; } await pause(250); }
          if (!loaded) throw Error('本机尚未加载网关身份或尚未就绪，未发送登记');
        }
        let authorizationCode = '';
        const codeText = await gatewayOptional(stage.codeFile, 1024);
        if (codeText) { const code = decodeGatewayCode(codeText.trim()); if (code.origin !== stage.connection.origin) throw Error('接入码属于其他网关'); authorizationCode = code.key; }
        else if (!stage.connection.registeredAt) throw Error('首次登记需要私有 secrets/gateway_code；准备状态已保留');
        for (const [key, [path, limit]] of Object.entries(files)) if (await gatewayOptional(path, limit) !== stage.files[key].after) throw Error('登记前本机准备状态被修改，未发送登记');
        valid();
        stage.sent = true; text = await save(stage, text);
        const response = await request(stage.connection.origin + '/__nodes/api/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: stage.connection.origin }, body: JSON.stringify({ authorizationCode, secret: stage.connection.secret, node: { id: stage.connection.nodeId, name: stage.connection.name, backendOrigin: stage.connection.backendOrigin, mode: stage.mode } }), redirect: 'error', signal: AbortSignal.timeout(10000) });
        const result = await gatewayJSON(response); valid();
        if (!response.ok) throw Error('网关拒绝登记（HTTP ' + response.status + '），请核对接入码与后端就绪状态');
        if (result.ok !== true || result.nodeId !== stage.connection.nodeId || result.origin !== stage.connection.origin || result.backendOrigin !== stage.connection.backendOrigin || !Number.isSafeInteger(result.registeredAt) || result.registeredAt <= 0) throw Error('登记响应未确认，请手动核对；不会自动重试');
        stage.completed = { ...stage.connection, registeredAt: result.registeredAt }; stage.phase = 'registered'; text = await save(stage, text);
      }
      for (const key of ['env', 'credentials']) if (await gatewayOptional(files[key][0], files[key][1]) !== stage.files[key].after) throw Error('登记已确认，但本机配置已变化，请核对恢复记录；未覆盖人工修改');
      const current = await gatewayOptional(configPath, 4096), completedText = gatewayEncode(validateGatewayConnection(stage.completed));
      if (![stage.files.config.after, completedText].includes(current)) throw Error('登记后本机接入文件已变化，未覆盖');
      if (current !== completedText) await portalWrite(configPath, completedText, { expected: current, valid });
      await portalRemove(pendingPath, { expected: text, valid });
      return { registered: true, nodeId: stage.connection.nodeId, origin: stage.connection.origin, backendOrigin: stage.connection.backendOrigin };
    } finally { await lease.release(); }
  } };
}
