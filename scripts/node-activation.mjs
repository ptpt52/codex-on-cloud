import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { portalRead, portalWrite, portalRemove } from './portal-files.mjs';
import { acquireDeploymentLease } from './deployment-lease.mjs';
import { privateIngressReady } from './cloudflare-publication.mjs';

export const ACTIVATION_LIMITS = Object.freeze({ profile: 8192, pending: 262144, configuration: 16384, comment: 100 });
const HEX = /^[a-f0-9]{32}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const optional = async (path, limit) => { try { return await portalRead(path, limit, true); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const encode = value => JSON.stringify(value, null, 2) + '\n';
const parse = (text, label) => { try { return JSON.parse(text); } catch { throw Error(label + '格式无效'); } };
const canonical = (value, depth = 0) => {
  if (depth > 16) throw Error('公网配置嵌套超过限制');
  return Array.isArray(value) ? value.map(item => canonical(item, depth + 1)) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)])) : value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const compact = value => Buffer.from(value, 'hex').toString('base64url');
function expand(value) { const bytes = Buffer.from(value, 'base64url'); if (bytes.length !== 16 || bytes.toString('base64url') !== value) throw Error('共享入口标记损坏'); return bytes.toString('hex'); }
export function activationMarker(comment = '') {
  comment ??= '';
  if (typeof comment !== 'string') throw Error('DNS备注格式无效，不会覆盖');
  const match = comment.match(/(?:^| )\[codex-cloud:v1:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22})\]$/);
  if (!match) { if (comment.includes('[codex-cloud:')) throw Error('共享入口标记无效，不会覆盖'); return null; }
  return { group: expand(match[1]), node: expand(match[2]), operation: expand(match[3]), prefix: comment.slice(0, match.index) };
}
function markerComment(record, profile, operation) {
  const marker = activationMarker(record?.comment), prefix = marker ? marker.prefix : record?.comment || '';
  const value = (prefix ? prefix + ' ' : '') + '[codex-cloud:v1:' + [profile.group, profile.nodeId, operation].map(compact).join(':') + ']';
  if ([...value].length > ACTIVATION_LIMITS.comment) throw Error('DNS 备注没有足够空间保留共享入口标记；请先在控制台保留原备注备份并缩短');
  return value;
}
const recordBody = record => Object.fromEntries(['type', 'name', 'content', 'proxied', 'ttl', 'comment', 'tags', 'settings'].filter(key => record?.[key] !== undefined).map(key => [key, record[key]]));
function target(domain, zone) {
  if (typeof domain !== 'string' || typeof zone !== 'string' || domain.length > 253 || zone.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || !/^[a-z0-9.-]+$/.test(zone) || !domain.endsWith('.' + zone)) throw Error('需要有效的 --domain 与 --zone');
}
function profileValue(value) {
  if (!value || Object.keys(value).some(key => !['version', 'domain', 'zone', 'tokenFile', 'accountId', 'zoneId', 'nodeId', 'group', 'tunnelId'].includes(key)) || value.version !== 1 || !HEX.test(value.nodeId) || !HEX.test(value.group) || !HEX.test(value.accountId) || !HEX.test(value.zoneId) || typeof value.tokenFile !== 'string' || !value.tokenFile || Buffer.byteLength(value.tokenFile) > 4096 || /[\0\r\n]/.test(value.tokenFile) || value.tunnelId !== undefined && !UUID.test(value.tunnelId)) throw Error('本机节点接入记录损坏');
  target(value.domain, value.zone); return value;
}
export async function readActivationProfile(root) {
  const text = await optional(join(root, 'data/cloudflare-node.json'), ACTIVATION_LIMITS.profile);
  return text === null ? null : profileValue(parse(text, '本机节点记录'));
}

// Each host owns one profile and one bounded recovery record. No node directory,
// input queue, shared runtime credentials, automatic DNS retries or DNS rollback.
export function createNodeActivation({ root, socketPath, api, services, ready = privateIngressReady, publicReady = async () => {}, connected = async () => {} }) {
  const profilePath = join(root, 'data/cloudflare-node.json'), pendingPath = join(root, 'data/cloudflare-activation.json'), deploymentPath = join(root, 'data/cloudflare-deployment.json');
  const files = { env: [join(root, '.env'), 65536], credentials: [join(root, 'secrets/credentials.txt'), 4096], token: [join(root, 'secrets/tunnel_token'), 4096] };
  let lease;
  const check = () => { if (!lease) throw Error('节点切换锁已释放'); lease.check(); };
  const call = async (...args) => { check(); const result = await api(...args); check(); return result; };
  const write = async (path, value, expected) => { const text = encode(value); if (Buffer.byteLength(text) > (path === profilePath ? ACTIVATION_LIMITS.profile : ACTIVATION_LIMITS.pending)) throw Error('节点接入状态超过大小限制'); await portalWrite(path, text, { expected, valid: check }); return text; };
  async function records(profile) {
    const result = await call('/zones/' + profile.zoneId + '/dns_records?name=' + encodeURIComponent(profile.domain));
    if (!Array.isArray(result) || result.length > 1) throw Error('域名存在多条记录，不会接管');
    const record = result[0] || null;
    if (record && (record.type !== 'CNAME' || record.name !== profile.domain || !/^[a-f0-9-]{36}\.cfargotunnel\.com$/.test(record.content))) throw Error('域名指向其他服务，不会接管');
    return record;
  }
  function recognized(record, profile, owned) {
    const marker = activationMarker(record?.comment);
    if (marker) { if (marker.group !== profile.group) throw Error('域名属于另一组共享入口，不会接管'); return marker; }
    if (record && !(owned?.hostname === profile.domain && owned.accountId === profile.accountId && owned.zoneId === profile.zoneId && owned.tunnelId && record.content === owned.tunnelId + '.cfargotunnel.com' && record.id === owned.dnsRecordId)) throw Error('请先在当前拥有此域名的原节点运行一次 native:activate，启用共享入口');
    return null;
  }
  const isOurs = (record, profile, operation) => {
    const marker = activationMarker(record?.comment);
    return !!record && record.content === profile.tunnelId + '.cfargotunnel.com' && record.proxied === true && marker?.group === profile.group && marker.node === profile.nodeId && (operation === undefined || marker.operation === operation);
  };
  async function loadPending() {
    const text = await optional(pendingPath, ACTIVATION_LIMITS.pending); if (text === null) return { text, value: null };
    const value = parse(text, '节点切换恢复记录');
    if (value.version !== 1 || !['prepared', 'committing', 'committed'].includes(value.phase) || !HEX.test(value.operation) || !value.profile || !value.files) throw Error('节点切换恢复记录损坏');
    profileValue(value.profile); return { text, value };
  }
  async function status() {
    const profile = await readActivationProfile(root); if (!profile) throw Error('本机尚未接入共享入口');
    const record = await records(profile), pending = await loadPending();
    const owned = await optional(deploymentPath, 65536);
    recognized(record, profile, owned === null ? null : parse(owned, '本机部署记录'));
    return { domain: profile.domain, nodeId: profile.nodeId, active: isOurs(record, profile), pending: pending.value?.phase || null };
  }
  async function finalize(stage, pendingText, record) {
    if (!isOurs(record, stage.profile, stage.operation)) throw Error('入口已指向另一节点，本次不会覆盖或回退；请运行 --status 核对');
    const plan = { hostname: stage.profile.domain, accountId: stage.profile.accountId, zoneId: stage.profile.zoneId, tunnelId: stage.profile.tunnelId, dnsRecordId: record.id };
    const current = await optional(deploymentPath, 65536);
    if (current !== stage.deploymentBefore && current !== encode(plan)) throw Error('本机部署归属已被修改，入口已提交；请核对状态');
    await write(deploymentPath, plan, current);
    await portalRemove(pendingPath, { expected: pendingText, valid: check });
    let reachable = false;
    try { await publicReady(stage.profile); reachable = true; } catch {}
    return { domain: stage.profile.domain, nodeId: stage.profile.nodeId, active: true, published: true, reachable };
  }
  async function prepare(values) {
    if (await optional(join(root, 'data/gateway-node.json'), 4096) !== null || await optional(join(root, 'data/gateway-join.json'), ACTIVATION_LIMITS.pending) !== null) throw Error('本机使用固定网关，请在 /__nodes/ 切换；不再通过 DNS 激活');
    if (await optional(join(root, 'data/cloudflare-publication.json'), ACTIVATION_LIMITS.pending) !== null) throw Error('已有普通公网发布待完成，请先按原目标完成或回退，再切换共享入口');
    const prior = await loadPending();
    if (prior.value) {
      const stage = prior.value;
      const current = await readActivationProfile(root);
      if (!same(current, stage.profile) || stage.desiredConfig?.ingress?.length !== 2 || stage.desiredConfig.ingress[0].hostname !== stage.profile.domain || stage.desiredConfig.ingress[0].service !== 'unix:' + socketPath || stage.desiredConfig.ingress[1].service !== 'http_status:404') throw Error('节点准备记录与本机身份不一致，未执行');
      if (values.domain && values.domain !== stage.profile.domain || values.zone && values.zone !== stage.profile.zone) throw Error('已有其他目标的切换待核对');
      if (stage.phase === 'committing' || stage.phase === 'committed') {
        const record = await records(stage.profile);
        if (isOurs(record, stage.profile, stage.operation)) return { completed: await finalize(stage, prior.text, record) };
        throw Error('上次切换结果未知，未重复提交或回退；请运行 --status 核对，确认后用 --resolve-unknown 解除本机记录');
      }
      return { stage, text: prior.text };
    }
    const oldProfileText = await optional(profilePath, ACTIVATION_LIMITS.profile), existing = oldProfileText === null ? null : profileValue(parse(oldProfileText, '本机节点记录'));
    const domain = values.domain || existing?.domain, zone = values.zone || existing?.zone, tokenFile = values.tokenFile || existing?.tokenFile; target(domain, zone);
    if (existing && (domain !== existing.domain || zone !== existing.zone || tokenFile !== existing.tokenFile)) throw Error('本机已绑定其他共享入口或凭据路径，不会隐式改绑');
    if (!tokenFile || Buffer.byteLength(tokenFile) > 4096 || /[\0\r\n]/.test(tokenFile)) throw Error('首次接入需要有效的 --api-token-file');
    const zones = await call('/zones?name=' + encodeURIComponent(zone)), selected = zones.find(value => value.name === zone);
    if (!selected || !HEX.test(selected.id) || !HEX.test(selected.account?.id)) throw Error('API token看不到目标区域');
    const deploymentBefore = await optional(deploymentPath, 65536), owned = deploymentBefore === null ? null : parse(deploymentBefore, '本机部署记录');
    if (owned && (owned.hostname !== domain || owned.accountId !== selected.account.id || owned.zoneId !== selected.id || !UUID.test(owned.tunnelId))) throw Error('本机已有其他域名部署，请先明确迁移到固定入口，不能自动覆盖');
    const profile = existing || { version: 1, domain, zone, tokenFile, accountId: selected.account.id, zoneId: selected.id, nodeId: randomBytes(16).toString('hex'), group: randomBytes(16).toString('hex'), ...(owned ? { tunnelId: owned.tunnelId } : {}) };
    if (profile.accountId !== selected.account.id || profile.zoneId !== selected.id) throw Error('共享入口账户或区域发生变化');
    const beforeDNS = await records(profile), marker = activationMarker(beforeDNS?.comment);
    if (!existing && marker) profile.group = marker.group;
    recognized(beforeDNS, profile, owned);
    markerComment(beforeDNS, profile, randomBytes(16).toString('hex'));
    await write(profilePath, profile, oldProfileText);
    const base = '/accounts/' + profile.accountId + '/cfd_tunnel';
    if (!profile.tunnelId) {
      const name = 'codex-on-cloud-node-' + profile.nodeId;
      const found = await call(base + '?is_deleted=false&name=' + name);
      if (!Array.isArray(found) || found.length > 1 || found.some(item => item.name !== name || !UUID.test(item.id))) throw Error('本节点Tunnel名称冲突');
      // Name is persisted first, so a later explicit call can reconcile a lost
      // create acknowledgement without creating another tunnel.
      const tunnel = found[0] || await call(base, 'POST', { name, config_src: 'cloudflare' });
      if (!UUID.test(tunnel.id)) throw Error('Tunnel创建结果未确认，请重新运行以只读核对名称');
      profile.tunnelId = tunnel.id;
      await write(profilePath, profile, await optional(profilePath, ACTIVATION_LIMITS.profile));
    }
    const configuration = (await call(base + '/' + profile.tunnelId + '/configurations')).config || { ingress: [{ service: 'http_status:404' }] };
    if (Buffer.byteLength(JSON.stringify(configuration)) > ACTIVATION_LIMITS.configuration) throw Error('Tunnel配置超过16 KiB，不会覆盖');
    const rules = configuration.ingress || [], named = rules.filter(rule => rule.hostname);
    if (named.length > 1 || named.some(rule => rule.hostname !== domain || rule.path) || rules.some(rule => !rule.hostname && rule.service !== 'http_status:404')) throw Error('Tunnel含其他路由，不会覆盖');
    const desiredConfig = { ...configuration, ingress: [{ ...named[0], hostname: domain, service: 'unix:' + socketPath, originRequest: named[0]?.originRequest || {} }, { service: 'http_status:404' }] };
    const token = await call(base + '/' + profile.tunnelId + '/token');
    if (typeof token !== 'string' || !token || token.length > 4095 || /\s/.test(token)) throw Error('Tunnel运行令牌无效');
    const stage = { version: 1, phase: 'prepared', operation: randomBytes(16).toString('hex'), profile, deploymentBefore, beforeDNS, configuration, desiredConfig, files: {} };
    for (const [key, [path, limit]] of Object.entries(files)) stage.files[key] = { before: await optional(path, limit), after: null };
    if (stage.files.env.before === null || stage.files.credentials.before === null) throw Error('请先完成本机部署初始化');
    const originalEnvironment = parseEnv(stage.files.env.before);
    if (originalEnvironment.SHARED_ENTRY === '1' && originalEnvironment.NODE_ID !== profile.nodeId) throw Error('本机配置与固定节点身份不一致，未覆盖');
    let env = stage.files.env.before;
    for (const [key, value] of Object.entries({ PUBLIC_ORIGIN: 'https://' + domain, NODE_ID: profile.nodeId, SHARED_ENTRY: '1' })) env = new RegExp('^' + key + '=.*$', 'm').test(env) ? env.replace(new RegExp('^' + key + '=.*$', 'm'), key + '=' + value) : env + '\n' + key + '=' + value + '\n';
    const parsed = parseEnv(env);
    if (parsed.PUBLIC_ORIGIN !== 'https://' + domain || parsed.NODE_ID !== profile.nodeId || parsed.SHARED_ENTRY !== '1') throw Error('本机配置存在冲突的重复项，未修改');
    stage.files.env.after = env;
    stage.files.credentials.after = stage.files.credentials.before.replace(/^工作台：.*$/m, '工作台：https://' + domain);
    stage.files.token.after = token + '\n';
    const text = await write(pendingPath, stage, null); return { stage, text };
  }
  async function activate(values) {
    const prepared = await prepare(values); if (prepared.completed) return prepared.completed;
    let { stage, text } = prepared;
    const profile = stage.profile, tunnel = '/accounts/' + profile.accountId + '/cfd_tunnel/' + profile.tunnelId;
    const currentConfig = (await call(tunnel + '/configurations')).config || { ingress: [{ service: 'http_status:404' }] };
    if (!same(currentConfig, stage.configuration) && !same(currentConfig, stage.desiredConfig)) throw Error('准备后Tunnel配置已变化，未切换入口');
    if (!same(currentConfig, stage.desiredConfig)) await call(tunnel + '/configurations', 'PUT', { config: stage.desiredConfig });
    let panelChanged = false, tunnelChanged = false;
    for (const [key, [path, limit]] of Object.entries(files)) {
      const value = stage.files[key], current = await optional(path, limit);
      if (!value || typeof value.after !== 'string' || Buffer.byteLength(value.after) > limit || ![value.before, value.after].includes(current)) throw Error('本机准备配置已被修改，未覆盖或切换入口');
      if (current !== value.after) await portalWrite(path, value.after, { expected: current, valid: check });
      if (key === 'env' && value.before !== value.after) panelChanged = true;
      if (key === 'token' && value.before !== value.after) tunnelChanged = true;
    }
    await services({ panelChanged, tunnelChanged, profile, lease }); check();
    await ready(socketPath, profile.domain, profile.nodeId); check();
    await connected(profile); check();
    for (const [key, [path, limit]] of Object.entries(files)) if (await optional(path, limit) !== stage.files[key].after) throw Error('服务加载后本机配置已变化，未切换入口');
    if (!same(await readActivationProfile(root), profile)) throw Error('准备后本机节点身份已被修改，未切换入口');
    if (!same((await call(tunnel + '/configurations')).config, stage.desiredConfig)) throw Error('节点Tunnel配置未确认或已被修改，未切换入口');
    const currentDNS = await records(profile);
    if (!same(currentDNS, stage.beforeDNS)) throw Error('准备后入口已由其他操作变更，未覆盖；请核对后解除本机准备记录');
    const desired = { ...recordBody(currentDNS), type: 'CNAME', name: profile.domain, content: profile.tunnelId + '.cfargotunnel.com', proxied: true, ttl: 1, comment: markerComment(currentDNS, profile, stage.operation) };
    stage.phase = 'committing'; text = await write(pendingPath, stage, text);
    let failure;
    try { await call('/zones/' + profile.zoneId + '/dns_records' + (currentDNS ? '/' + currentDNS.id : ''), currentDNS ? 'PUT' : 'POST', desired); }
    catch (error) { failure = error; }
    let actual;
    try { actual = await records(profile); } catch { throw Error('切换结果未知，未重试或回退；请运行 --status 核对'); }
    if (!isOurs(actual, profile, stage.operation)) {
      if (!failure || failure.status >= 400 && failure.status < 500) await portalRemove(pendingPath, { expected: text, valid: check });
      throw Error('入口未确认指向本机，未重试或回退；请运行 --status 核对');
    }
    stage.phase = 'committed'; text = await write(pendingPath, stage, text);
    return finalize(stage, text, actual);
  }
  async function resolveUnknown() {
    const pending = await loadPending(); if (!pending.value) return status();
    const record = await records(pending.value.profile), owned = await optional(deploymentPath, 65536);
    recognized(record, pending.value.profile, owned === null ? null : parse(owned, '本机部署记录'));
    if (isOurs(record, pending.value.profile, pending.value.operation)) return finalize(pending.value, pending.text, record);
    await portalRemove(pendingPath, { expected: pending.text, valid: check }); return status();
  }
  const locked = action => async (...args) => {
    const held = await acquireDeploymentLease(root); lease = held;
    try { return await action(...args); } finally { lease = null; await held.release(); }
  };
  return { activate: locked(activate), status: locked(status), resolveUnknown: locked(resolveUnknown) };
}
