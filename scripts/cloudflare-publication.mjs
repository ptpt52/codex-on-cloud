import http from 'node:http';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readStateFile, writeStateFile, removeStateFile } from './state-files.mjs';
import { cloudflareDomainPlan, assertManagedIngress, renamedDNSRecord } from '../native/cloudflare-domain.mjs';
import { acquireFileLock } from '../native/file-lock.mjs';
import { randomBytes } from 'node:crypto';
import { acquireDeploymentLease } from './deployment-lease.mjs';

const LIMIT = 262144;
const parse = (text, label) => { try { return JSON.parse(text); } catch { throw Error(`${label}格式无效`); } };
const canonical = (value, depth = 0) => {
  if (depth > 16) throw Error('公网配置嵌套过深');
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)])) : value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const dnsBody = record => Object.fromEntries(['type', 'name', 'content', 'proxied', 'ttl', 'comment', 'tags', 'settings'].filter(key => record[key] !== undefined).map(key => [key, record[key]]));
const ownedDNS = (record, stage) => record?.type === 'CNAME' && record.name === stage.domain && record.content === `${stage.plan.tunnelId}.cfargotunnel.com`;
const desiredDNS = stage => ({ type: 'CNAME', name: stage.domain, content: `${stage.plan.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });

export async function privateIngressReady(socketPath, hostname, nodeId) {
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('私有 Tunnel 接口尚未就绪');
  await new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/readyz', headers: { host: hostname }, signal: AbortSignal.timeout(3000) }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 4096) res.destroy(); else chunks.push(chunk); });
      res.once('error', reject); res.once('aborted', () => reject(Error('私有入口就绪响应中断')));
      res.once('end', () => {
        try { const value = JSON.parse(Buffer.concat(chunks)); if (res.statusCode !== 200 || value.ok !== true || value.host !== true || value.files !== true || nodeId && value.nodeId !== nodeId) throw Error(); resolve(); }
        catch { reject(Error('私有入口、任务宿主或文件服务未就绪，未切换公网路由')); }
      });
    });
    req.once('error', () => reject(Error('私有 Tunnel 接口无法验证，未切换公网路由')));
  });
}

// One private <=256 KiB recovery record per deployment; no API token is stored.
// A failed/ambiguous write is reconciled by reading state, never blindly replayed.
export function createCloudflarePublication({ root, socketPath, api: request, ready = privateIngressReady, deploymentLease, operationId }) {
  if (!!deploymentLease !== (operationId !== undefined) || operationId !== undefined && (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId))) throw Error('部署发布身份无效');
  let lease, pendingText, whole;
  const valid = () => { if (!lease) throw Error('公网发布锁已释放'); whole.check(); lease.check(); };
  const api = async (...args) => { valid(); const result = await request(...args); valid(); return result; };
  const statePath = join(root, 'data/cloudflare-deployment.json'), pendingPath = join(root, 'data/cloudflare-publication.json');
  const local = { env: [join(root, '.env'), 65536], credentials: [join(root, 'secrets/credentials.txt'), 4096], token: [join(root, 'secrets/tunnel_token'), 4096] };
  const optional = async (path, limit) => { try { return await readStateFile(path, limit, true); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const encode = value => JSON.stringify(value, null, 2) + '\n';
  const write = (path, value, expected) => writeStateFile(path, encode(value), { expected, valid });
  async function pending() {
    const text = await optional(pendingPath, LIMIT); pendingText = text; if (text === null) return null;
    const value = parse(text, '公网发布恢复记录');
    if (value.operationId !== undefined && !/^[a-f0-9]{32}$/.test(value.operationId)) throw Error('公网发布恢复身份损坏');
    if (value.version !== 1 || !['prepared', 'committing', 'committed', 'rollback-needed'].includes(value.phase) || typeof value.domain !== 'string' || !/^[a-z0-9.-]+$/.test(value.domain) || !value.plan?.tunnelId || !value.plan.accountId || !value.plan.zoneId || !value.files || !value.desiredConfig || !value.beforeConfig) throw Error('公网发布恢复记录损坏，请检查');
    return value;
  }
  const endpoints = stage => ({ tunnel: `/accounts/${stage.plan.accountId}/cfd_tunnel/${stage.plan.tunnelId}`, dns: `/zones/${stage.plan.zoneId}/dns_records` });
  const records = async stage => {
    const value = await api(endpoints(stage).dns + '?name=' + encodeURIComponent(stage.domain));
    if (!Array.isArray(value) || value.length > 1) throw Error('公网域名出现多个记录，不会覆盖');
    return value;
  };
  async function save(stage) { await write(pendingPath, stage, pendingText); pendingText = encode(stage); }
  async function removePending() { await removeStateFile(pendingPath, { expected: pendingText, valid }); pendingText = null; }
  async function prepareLocal(stage) {
    for (const [key, [path, limit]] of Object.entries(local)) {
      const value = stage.files[key], current = await optional(path, limit);
      if (!value || ![value.before, value.after].every(text => text === null || typeof text === 'string' && Buffer.byteLength(text) <= limit) || value.after === null) throw Error('本机发布恢复记录无效');
      if (current === value.after) continue;
      if (current !== value.before) throw Error('准备期间本机配置已被修改，未覆盖');
      await writeStateFile(path, value.after, { expected: value.before, valid });
    }
  }
  async function verifyPreparedLocal(stage) {
    for (const [key, [path, limit]] of Object.entries(local)) {
      const value = stage.files[key]?.after;
      if (typeof value !== 'string' || Buffer.byteLength(value) > limit) throw Error('本机发布恢复记录无效');
      if (await optional(path, limit) !== value) throw Error('准备后本机配置已变化，未切换公网入口；请核对配置后重试');
    }
  }
  async function restoreLocal(stage) {
    let conflict = false;
    for (const [key, [path, limit]] of Object.entries(local)) {
      const value = stage.files[key];
      if (!value || ![value.before, value.after].every(text => text === null || typeof text === 'string' && Buffer.byteLength(text) <= limit)) throw Error('本机发布恢复记录无效');
      const current = await optional(path, limit);
      if (current === value.before) continue;
      if (current !== value.after) { conflict = true; continue; }
      try {
        if (value.before === null) await removeStateFile(path, { expected: value.after, valid });
        else await writeStateFile(path, value.before, { expected: value.after, valid });
      } catch (error) { if (error.status !== 409) throw error; conflict = true; }
    }
    if (conflict) throw Error('本机配置已被其他操作修改，未覆盖；保留发布恢复记录');
  }
  function belongs(stage, target = {}) {
    if (operationId !== undefined && stage.operationId !== operationId || target.domain !== undefined && target.domain !== stage.domain || target.zone !== undefined && target.zone !== stage.zone) throw Object.assign(Error('已有待处理的公网发布属于其他操作或目标，未修改'), { status: 409, outcome: 'rejected' });
  }
  async function rollback(target) {
    const stage = await pending(); if (!stage) return { rolledBack: false };
    if (operationId !== undefined && stage.operationId !== operationId) return { rolledBack: false, otherOperation: true };
    belongs(stage, target);
    if (stage.phase === 'committed') throw Error('公网发布已提交；不会把已生效的发布当成失败回退');
    const { tunnel, dns } = endpoints(stage);
    try {
      if (stage.phase !== 'prepared') {
        const current = (await api(tunnel + '/configurations')).config ?? null;
        if (!same(current, stage.beforeConfig) && !same(current, stage.observedConfig)) {
          if (!same(current, stage.desiredConfig)) throw Error('Tunnel配置已被其他操作修改');
          await api(tunnel + '/configurations', 'PUT', { config: stage.beforeConfig });
          if (!same((await api(tunnel + '/configurations')).config, stage.beforeConfig)) throw Error('旧Tunnel配置未确认恢复');
        }
        const found = await records(stage), record = found[0];
        if (stage.beforeDNS) {
          if (!record || record.id !== stage.beforeDNS.id || !ownedDNS(record, stage)) throw Error('DNS配置已被其他操作修改');
          if (!same(dnsBody(record), dnsBody(stage.beforeDNS))) {
            if (!same(dnsBody(record), { ...dnsBody(stage.beforeDNS), ...desiredDNS(stage) })) throw Error('DNS配置已被其他操作修改');
            await api(`${dns}/${record.id}`, 'PUT', dnsBody(stage.beforeDNS));
          }
        } else if (record) {
          if (!ownedDNS(record, stage)) throw Error('新域名已被其他操作修改');
          await api(`${dns}/${record.id}`, 'DELETE');
        }
        const restored = (await records(stage))[0] || null;
        if (stage.beforeDNS ? !restored || restored.id !== stage.beforeDNS.id || !same(dnsBody(restored), dnsBody(stage.beforeDNS)) : restored) throw Error('DNS回退未确认');
      }
      if (stage.beforeState || stage.nextState) {
        const stateText = await optional(statePath, 65536), currentState = parse(stateText, '本机部署记录');
        if (!same(currentState, stage.beforeState) && !same(currentState, stage.nextState) && !same(currentState, stage.plan)) throw Error('本机部署归属已变化');
        await write(statePath, stage.beforeState || stage.plan, stateText);
      }
      await restoreLocal(stage); await removePending();
      return { rolledBack: true };
    } catch {
      stage.phase = 'rollback-needed'; await save(stage);
      throw Error('发布回退未能确认或配置已被修改，恢复记录已保留；检查后使用 --rollback，不会覆盖其他配置');
    }
  }
  async function prepare({ domain, zone, rename = false }) {
    if (typeof domain !== 'string' || typeof zone !== 'string' || !/^[a-z0-9.-]+$/.test(domain) || !/^[a-z0-9.-]+$/.test(zone) || !domain.endsWith('.' + zone)) throw Error('公网域名和区域无效');
    const previous = await pending();
    if (previous) {
      belongs(previous, { domain, zone });
      if (previous.domain !== domain || previous.zone !== zone || !['prepared', 'committed'].includes(previous.phase)) throw Error('已有待处理的公网发布，请先完成或 --rollback');
      if (previous.phase === 'prepared') await prepareLocal(previous);
      return { prepared: true, resumed: true };
    }
    const zones = await api('/zones?name=' + encodeURIComponent(zone)), selected = zones.find(value => value.name === zone);
    if (!selected) throw Error('当前API token看不到指定区域');
    const text = await optional(statePath, 65536), beforeState = text === null ? null : parse(text, '本机部署记录');
    let plan = cloudflareDomainPlan(beforeState, { domain, accountId: selected.account.id, zoneId: selected.id, rename });
    if (!plan) {
      const name = `codex-on-cloud-${domain.split('.')[0]}`, base = `/accounts/${selected.account.id}/cfd_tunnel`;
      if ((await api(base + '?is_deleted=false&name=' + encodeURIComponent(name))).some(item => item.name === name)) throw Error('同名Tunnel存在但没有本机部署状态，不会接管');
      const created = await api(base, 'POST', { name, config_src: 'cloudflare' });
      plan = { hostname: domain, accountId: selected.account.id, zoneId: selected.id, tunnelId: created.id };
      // Keep ownership if preparation is interrupted; reruns reuse this tunnel.
      await write(statePath, plan, text);
    }
    const stage = { version: 1, operationId: operationId || randomBytes(16).toString('hex'), phase: 'prepared', domain, zone, plan, beforeState, files: {} };
    const { tunnel } = endpoints(stage), configuration = await api(tunnel + '/configurations'); assertManagedIngress(plan, configuration);
    stage.observedConfig = configuration.config ?? null;
    stage.beforeConfig = configuration.config || { ingress: [{ service: 'http_status:404' }] };
    if (Buffer.byteLength(JSON.stringify(stage.beforeConfig)) > 65536) throw Error('已有Tunnel配置超过64KiB，未修改入口');
    const rules = stage.beforeConfig.ingress || [], named = rules.filter(rule => rule.hostname);
    if (named.length > 1 || named.some(rule => rule.path) || rules.some(rule => !rule.hostname && rule.service !== 'http_status:404')) throw Error('Tunnel含有额外路由，不会覆盖');
    stage.desiredConfig = { ...stage.beforeConfig, ingress: [{ ...named[0], hostname: domain, service: `unix:${socketPath}`, originRequest: named[0]?.originRequest || {} }, { service: 'http_status:404' }] };
    const found = await records(stage); stage.beforeDNS = found[0] || null;
    if (stage.beforeDNS && !ownedDNS(stage.beforeDNS, stage)) throw Error('此域名已有其他DNS记录，不会覆盖');
    for (const [key, [path, limit]] of Object.entries(local)) stage.files[key] = { before: await optional(path, limit), after: null };
    if (stage.files.env.before === null || stage.files.credentials.before === null) throw Error('请先初始化本机配置和登录信息');
    let env = stage.files.env.before;
    env = /^PUBLIC_ORIGIN=.*$/m.test(env) ? env.replace(/^PUBLIC_ORIGIN=.*$/m, `PUBLIC_ORIGIN=https://${domain}`) : env + `\nPUBLIC_ORIGIN=https://${domain}\n`;
    parseEnv(env); stage.files.env.after = env;
    stage.files.credentials.after = stage.files.credentials.before.replace(/^工作台：.*$/m, `工作台：https://${domain}`);
    const token = await api(tunnel + '/token');
    if (typeof token !== 'string' || !token || token.length > 4095 || /\s/.test(token)) throw Error('Tunnel运行令牌无效');
    stage.files.token.after = token + '\n'; await save(stage);
    try { await prepareLocal(stage); }
    catch (error) { await rollback(); throw error; }
    return { prepared: true, resumed: false };
  }
  async function cleanup(stage) {
    if (stage.plan.previousHostname) {
      const { dns } = endpoints(stage);
      const old = renamedDNSRecord(stage.plan, await api(dns + '?name=' + encodeURIComponent(stage.plan.previousHostname)));
      if (old) await api(`${dns}/${old.id}`, 'DELETE');
    }
    await removePending();
  }
  async function commit({ domain, zone }) {
    const stage = await pending(); if (!stage || stage.domain !== domain || stage.zone !== zone) throw Error('没有匹配的公网准备记录');
    belongs(stage, { domain, zone });
    if (stage.phase === 'committed') { await cleanup(stage); return { published: true }; }
    if (stage.phase !== 'prepared') throw Error('发布曾被中断，请先 --rollback 后重新准备');
    await ready(socketPath, domain); valid();
    await verifyPreparedLocal(stage);
    const { tunnel, dns } = endpoints(stage);
    const current = (await api(tunnel + '/configurations')).config ?? null;
    if (!same(current, stage.observedConfig)) throw Error('准备后Tunnel配置已变化，未切换入口');
    const found = await records(stage);
    if (!same(found[0] || null, stage.beforeDNS)) throw Error('准备后DNS配置已变化，未切换入口');
    await verifyPreparedLocal(stage);
    stage.phase = 'committing'; await save(stage);
    try {
      await api(tunnel + '/configurations', 'PUT', { config: stage.desiredConfig });
      if (!same((await api(tunnel + '/configurations')).config, stage.desiredConfig)) throw Error('入口切换未确认');
      const desired = { ...dnsBody(stage.beforeDNS || {}), ...desiredDNS(stage) };
      const record = stage.beforeDNS && same(dnsBody(stage.beforeDNS), desired) ? stage.beforeDNS : await api(stage.beforeDNS ? `${dns}/${stage.beforeDNS.id}` : dns, stage.beforeDNS ? 'PUT' : 'POST', desired);
      const verified = (await records(stage))[0]; if (!verified || verified.id !== record.id || !ownedDNS(verified, stage) || !verified.proxied) throw Error('DNS提交未确认');
      const next = { ...stage.plan, dnsRecordId: verified.id }; delete next.previousHostname; delete next.previousDnsRecordId;
      stage.nextState = next; await save(stage);
      const stateText = await optional(statePath, 65536), currentState = parse(stateText, '本机部署记录');
      if (!same(currentState, stage.beforeState) && !same(currentState, stage.plan)) throw Error('本机部署归属已变化');
      await write(statePath, next, stateText); stage.phase = 'committed'; await save(stage);
    } catch (error) { await rollback(); throw error; }
    // Failure removing an obsolete alias never rolls back a working new entry.
    await cleanup(stage); return { published: true };
  }
  const locked = action => async (...args) => {
    await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
    const directory = await lstat(join(root, 'data'));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) throw Error('公网发布目录无效');
    let shared, held;
    try {
      if (deploymentLease) deploymentLease.check(); else shared = await acquireDeploymentLease(root);
      if (await optional(join(root, 'data/gateway-node.json'), 4096) !== null || await optional(join(root, 'data/gateway-join.json'), LIMIT) !== null) throw Error('固定网关节点不通过 DNS 发布，请完成网关接入并使用 /__nodes/ 切换');
      if (await optional(join(root, 'data/cloudflare-activation.json'), LIMIT) !== null) throw Error('共享入口切换待核对，请先用 native:activate -- --status 或 --resolve-unknown 处理');
      held = await acquireFileLock(pendingPath + '.operation-lock'); lease = held; whole = deploymentLease || shared;
      const result = await action(...args); valid(); return result;
    } finally { if (held && lease === held) { lease = undefined; whole = undefined; } await held?.release(); await shared?.release(); }
  };
  return { prepare: locked(prepare), commit: locked(commit), rollback: locked(rollback) };
}
