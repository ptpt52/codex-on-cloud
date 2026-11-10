import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readStateFile, writeStateFile } from '../scripts/state-files.mjs';
import {
  CREDENTIAL, KEY, NODE_ID, SELFHOST_LIMITS, displayName, entryBasePath, equalHash, expiration, nodeIdentity,
  proxyName, publicKey, randomToken, selfhostError, slug, tokenHash,
} from './protocol.mjs';

function normalizeStored(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.keys) || !Array.isArray(value.audit) || value.keys.length > SELFHOST_LIMITS.keys || value.audit.length > SELFHOST_LIMITS.audit) throw Error('中心状态文件格式无效');
  const ids = new Set(), slugs = new Set();
  const keys = value.keys.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['id', 'slug', 'name', 'keyHash', 'credentialHash', 'createdAt', 'expiresAt', 'revokedAt'].includes(key))) throw Error('中心授权记录格式无效');
    if (!/^[a-f0-9]{32}$/.test(item.id) || ids.has(item.id)) throw Error('中心授权记录身份重复');
    const nodeSlug = slug(item.slug); if (slugs.has(nodeSlug)) throw Error('中心授权记录路径重复');
    if (!item.name || item.name.length > SELFHOST_LIMITS.name || !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0 || !item.keyHash || !/^[a-f0-9]{64}$/.test(item.keyHash) || item.credentialHash !== null && !/^[a-f0-9]{64}$/.test(item.credentialHash) || item.expiresAt !== null && (!Number.isSafeInteger(item.expiresAt) || item.expiresAt <= 0) || item.revokedAt !== null && (!Number.isSafeInteger(item.revokedAt) || item.revokedAt <= 0)) throw Error('中心授权记录内容无效');
    ids.add(item.id); slugs.add(nodeSlug);
    return { ...item, slug: nodeSlug };
  });
  const audit = value.audit.map(item => {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.at) || item.at <= 0 || typeof item.type !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(item.type) || typeof item.slug !== 'string' || !slug(item.slug)) throw Error('中心审计记录格式无效');
    return { at: item.at, type: item.type, slug: item.slug };
  });
  return { version: 1, revision: value.revision, keys, audit };
}

export class SelfhostRegistry {
  constructor({ file, host = '', now = () => Date.now(), onClose = async () => {}, random = randomToken } = {}) {
    if (!file) throw Error('中心状态文件未配置');
    this.file = file; this.host = host.toLowerCase(); this.now = now; this.onClose = onClose; this.random = random;
    this.value = { version: 1, revision: 1, keys: [], audit: [] };
    this.text = null; this.sessions = new Map(); this.queue = Promise.resolve();
  }

  async open() {
    let text;
    try { text = await readStateFile(this.file, SELFHOST_LIMITS.stateBytes, true); }
    catch (error) { if (error.code === 'ENOENT') { await mkdir(dirname(this.file), { recursive: true, mode: 0o700 }); return this; } throw error; }
    try { this.value = normalizeStored(JSON.parse(text)); } catch (error) { throw Error('中心状态无法读取：' + error.message, { cause: error }); }
    this.text = text; return this;
  }

  mutate(action) {
    const operation = this.queue.then(async () => {
      const value = structuredClone(this.value);
      const sessions = new Map([...this.sessions].map(([key, session]) => [key, { ...session }]));
      const result = action({ value, sessions, now: this.now(), close: [] });
      const text = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(text) > SELFHOST_LIMITS.stateBytes) throw selfhostError(413, '中心状态超过容量上限');
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeStateFile(this.file, text, { expected: this.text });
      this.value = value; this.sessions = sessions; this.text = text;
      for (const item of result?.close || []) await this.onClose(item.slug, item.reason);
      return result?.value;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  audit(value, type, item, now) {
    value.audit.push({ at: now, type, slug: item.slug });
    if (value.audit.length > SELFHOST_LIMITS.audit) value.audit.splice(0, value.audit.length - SELFHOST_LIMITS.audit);
    value.revision++;
  }

  findKey(value, keyId) { return value.keys.find(item => item.id === keyId); }

  async createKey(input = {}) {
    const name = displayName(input.name), nodeSlug = slug(input.slug), expiresAt = expiration(input.expiresAt, this.now());
    return this.mutate(({ value, now, close }) => {
      if (value.keys.length >= SELFHOST_LIMITS.keys) throw selfhostError(429, '最多保存 ' + SELFHOST_LIMITS.keys + ' 个授权');
      if (value.keys.some(item => item.slug === nodeSlug)) throw selfhostError(409, '该节点路径已有授权，不能重复创建');
      const token = this.random('coc_'), item = { id: tokenHash(token).slice(0, 32), slug: nodeSlug, name, keyHash: tokenHash(token), credentialHash: null, createdAt: now, expiresAt, revokedAt: null };
      value.keys.push(item); this.audit(value, 'key_created', item, now);
      return { value: { ...publicKey(item, null, now), key: token }, close };
    });
  }

  keyStatus(item, now) { return item.revokedAt ? 'revoked' : item.expiresAt !== null && item.expiresAt <= now ? 'expired' : 'ready'; }

  liveSessions(close, now) {
    const live = new Map();
    for (const [key, session] of this.sessions) {
      const item = this.findKey(this.value, session.keyId);
      if (!item || this.keyStatus(item, now) !== 'ready') { close.push({ slug: key, reason: 'authorization_revoked' }); continue; }
      if (session.status === 'grace') continue;
      live.set(key, session);
    }
    return live;
  }

  async list() {
    await this.queue;
    const now = this.now();
    return this.value.keys.map(item => publicKey(item, this.sessions.get(item.slug), now)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async status() {
    const keys = await this.list(), now = this.now();
    return {
      revision: this.value.revision,
      maximumNodes: SELFHOST_LIMITS.nodes,
      onlineNodes: keys.filter(item => ['online', 'connecting', 'authenticated'].includes(item.status)).length,
      graceNodes: keys.filter(item => item.status === 'grace').length,
      activeKeys: keys.filter(item => !item.revokedAt && (item.expiresAt === null || item.expiresAt > now)).length,
      totalKeys: keys.length,
    };
  }

  credentialOwner(value, credential) {
    if (typeof credential !== 'string' || !CREDENTIAL.test(credential)) return null;
    const hash = tokenHash(credential);
    return value.keys.find(item => item.credentialHash && equalHash(item.credentialHash, hash)) || null;
  }

  joinPlan(input, draft, now, close) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) throw selfhostError(400, '接入请求无效');
    const nodeSlug = slug(input.slug), nodeId = nodeIdentity(input.node?.id);
    if (!['desktop', 'terminal'].includes(input.node?.mode)) throw selfhostError(400, '节点模式无效');
    const key = draft.value.keys.find(item => item.slug === nodeSlug);
    if (!key) throw selfhostError(401, '授权不存在');
    if (this.keyStatus(key, now) !== 'ready') throw selfhostError(401, this.keyStatus(key, now) === 'expired' ? '授权已过期' : '授权已撤销');
    let credential = null;
    if (typeof input.key === 'string') {
      if (!KEY.test(input.key) || !equalHash(key.keyHash, tokenHash(input.key))) throw selfhostError(401, '授权 key 无效');
      credential = this.random('cocn_'); key.credentialHash = tokenHash(credential);
    } else {
      const owner = this.credentialOwner(draft.value, input.credential);
      if (!owner || owner.id !== key.id) throw selfhostError(401, '节点接入凭据无效');
      credential = input.credential;
    }
    let current = draft.sessions.get(nodeSlug);
    if (current?.status === 'grace' && current.graceUntil <= now) { draft.sessions.delete(nodeSlug); current = undefined; }
    const graceMatch = current?.status === 'grace' && current.graceUntil > now && equalHash(key.credentialHash, current.credentialHash);
    const keyRecovery = typeof input.key === 'string' && (!current || current.status === 'grace');
    if (current && !graceMatch && !keyRecovery) throw selfhostError(409, '该节点已有在线连接，拒绝重复接入');
    if (!current && this.liveSessions(close, now).size >= SELFHOST_LIMITS.nodes) throw selfhostError(429, '在线节点已达到上限');
    const session = {
      slug: nodeSlug, keyId: key.id, credentialHash: key.credentialHash, nodeId, mode: input.node.mode,
      source: typeof input.source === 'string' ? input.source.slice(0, 128) : '', status: 'connecting', connectedAt: now,
      authenticatedAt: null, onlineAt: null, lastSeenAt: now, graceUntil: null, runId: '',
    };
    draft.sessions.set(nodeSlug, session); this.audit(draft.value, 'node_joined', key, now);
    return { value: { version: 1, slug: nodeSlug, name: key.name, entryBasePath: entryBasePath(nodeSlug), credential, expiresAt: key.expiresAt, sessionId: key.id }, close };
  }

  async join(input) {
    return this.mutate(draft => this.joinPlan(input, draft, this.now(), []));
  }

  async revoke(keyId) {
    return this.mutate(({ value, sessions, now, close }) => {
      const item = this.findKey(value, keyId); if (!item) throw selfhostError(404, '授权不存在');
      if (item.revokedAt) return { value: publicKey(item, sessions.get(item.slug), now), close };
      item.revokedAt = now; item.credentialHash = null; sessions.delete(item.slug); close.push({ slug: item.slug, reason: 'authorization_revoked' }); this.audit(value, 'key_revoked', item, now);
      return { value: publicKey(item, null, now), close };
    });
  }

  async disconnect(nodeSlug) {
    return this.mutate(({ value, sessions, now, close }) => {
      const item = this.value.keys.find(key => key.slug === nodeSlug); if (!item) throw selfhostError(404, '节点授权不存在');
      if (!sessions.delete(nodeSlug)) throw selfhostError(409, '节点当前未接入');
      close.push({ slug: nodeSlug, reason: 'disconnected_by_admin' }); this.audit(value, 'node_disconnected', item, now);
      return { value: { ok: true }, close };
    });
  }

  async leave(input = {}) {
    return this.mutate(({ value, sessions, now, close }) => {
      const nodeSlug = slug(input.slug), item = value.keys.find(key => key.slug === nodeSlug);
      if (!item) throw selfhostError(401, '节点授权不存在');
      const owner = this.credentialOwner(value, input.credential);
      if (!owner || owner.id !== item.id || !sessions.has(nodeSlug)) throw selfhostError(401, '节点接入凭据无效或已经离线');
      sessions.delete(nodeSlug); close.push({ slug: nodeSlug, reason: 'node_left' }); this.audit(value, 'node_left', item, now);
      return { value: { ok: true }, close };
    });
  }

  loginMeta(metas) {
    if (!metas || typeof metas !== 'object' || Array.isArray(metas)) return null;
    const values = ['credential', 'slug', 'nodeId'];
    if (values.some(key => typeof metas[key] !== 'string' || metas[key].length > 512)) return null;
    return { credential: metas.credential, slug: metas.slug, nodeId: metas.nodeId, mode: ['desktop', 'terminal'].includes(metas.mode) ? metas.mode : 'desktop' };
  }

  async authorizeLogin({ metas, runId, source = '' } = {}) {
    const meta = this.loginMeta(metas); if (!meta || runId !== undefined && typeof runId !== 'string') return false;
    return this.mutate(({ value, sessions, now, close }) => {
      const item = this.credentialOwner(value, meta.credential);
      if (!item || item.slug !== meta.slug) return { value: false, close };
      if (this.keyStatus(item, now) !== 'ready') return { value: false, close };
      let session = sessions.get(item.slug);
      if (!session) {
        if (this.liveSessions(close, now).size >= SELFHOST_LIMITS.nodes) return { value: false, close };
        session = { slug: item.slug, keyId: item.id, credentialHash: item.credentialHash, nodeId: meta.nodeId, mode: meta.mode, source, status: 'connecting', connectedAt: now, authenticatedAt: null, onlineAt: null, lastSeenAt: now, graceUntil: null, runId: '' };
        sessions.set(item.slug, session);
      }
      if (!NODE_ID.test(meta.nodeId) || session.nodeId !== meta.nodeId || session.status === 'online' || session.status === 'authenticated') return { value: false, close };
      session.status = 'authenticated'; session.authenticatedAt = now; session.lastSeenAt = now; session.runId = runId || ''; session.source = source.slice(0, 128); session.graceUntil = null;
      this.audit(value, 'frp_login', item, now); return { value: true, close };
    });
  }

  async authorizeProxy({ metas, runId, name, type, host, locations } = {}) {
    const meta = this.loginMeta(metas); if (!meta || typeof runId !== 'string') return false;
    return this.mutate(({ value, sessions, now, close }) => {
      const item = this.credentialOwner(value, meta.credential), session = item && sessions.get(item.slug);
      if (session?.status === 'authenticated' && !session.runId) session.runId = runId;
      const allowed = !!item && this.keyStatus(item, now) === 'ready' && item.slug === meta.slug && session && session.nodeId === meta.nodeId && session.runId === runId && session.status === 'authenticated' && name === proxyName(item.slug) && type === 'http' && host === this.host && Array.isArray(locations) && locations.length === 1 && locations[0] === entryBasePath(item.slug);
      if (!allowed) return { value: false, close };
      session.status = 'online'; session.onlineAt = session.onlineAt || now; session.lastSeenAt = now; this.audit(value, 'node_online', item, now); return { value: true, close };
    });
  }

  async authorizePing({ metas, runId } = {}) {
    const meta = this.loginMeta(metas); if (!meta || typeof runId !== 'string') return false;
    await this.queue;
    const item = this.credentialOwner(this.value, meta.credential), session = item && this.sessions.get(item.slug), now = this.now();
    if (!item || this.keyStatus(item, now) !== 'ready' || !session || session.nodeId !== meta.nodeId || session.status === 'grace') return false;
    if (session.status === 'authenticated' && !session.runId) session.runId = runId;
    if (session.runId !== runId) return false;
    session.lastSeenAt = now; return true;
  }

  async closeProxy({ metas, runId } = {}) {
    const meta = this.loginMeta(metas); if (!meta || typeof runId !== 'string') return;
    await this.mutate(({ value, sessions, now, close }) => {
      const item = this.credentialOwner(this.value, meta.credential), session = item && sessions.get(item.slug);
      if (!item || !session || session.runId !== runId || session.status !== 'online') return { value: undefined, close };
      session.status = 'grace'; session.graceUntil = now + SELFHOST_LIMITS.graceMs; session.lastSeenAt = now; session.runId = '';
      this.audit(value, 'node_grace', item, now); return { value: undefined, close };
    });
  }

  async sweep() {
    await this.queue;
    const now = this.now();
    const due = [...this.sessions.entries()].some(([key, session]) => {
      const item = this.findKey(this.value, session.keyId);
      return !item || this.keyStatus(item, now) !== 'ready' || (session.status === 'grace' && session.graceUntil <= now) ||
        (['connecting', 'authenticated'].includes(session.status) && session.connectedAt + SELFHOST_LIMITS.connectMs <= now) ||
        (session.status === 'online' && session.lastSeenAt + SELFHOST_LIMITS.heartbeatMs <= now);
    });
    if (!due) return false;
    const result = await this.mutate(({ value, sessions, now, close }) => {
      for (const [key, session] of sessions) {
        const item = this.findKey(value, session.keyId);
        if (!item || this.keyStatus(item, now) !== 'ready') { sessions.delete(key); close.push({ slug: key, reason: 'authorization_revoked' }); }
        else if (session.status === 'grace' && session.graceUntil <= now) sessions.delete(key);
        else if (['connecting', 'authenticated'].includes(session.status) && session.connectedAt + SELFHOST_LIMITS.connectMs <= now) sessions.delete(key);
        else if (session.status === 'online' && session.lastSeenAt + SELFHOST_LIMITS.heartbeatMs <= now) { sessions.delete(key); close.push({ slug: key, reason: 'heartbeat_timeout' }); }
      }
      return { value: true, close };
    });
    return result;
  }
}
