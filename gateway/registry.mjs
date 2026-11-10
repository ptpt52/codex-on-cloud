import { GATEWAY_LIMITS, gatewayConfig, gatewayNode, gatewayHex, gatewaySecret, gatewayDigest, gatewayRandom, gatewayEqual, gatewayError, gatewayCookie, gatewaySessionCookie, gatewayProbe, encodeGatewayCode } from './protocol.mjs';

export class GatewayRegistry {
  constructor(state, env, config) { this.state = state; this.env = env; this.config = gatewayConfig(config); this.now = () => Date.now(); this.probes = new Map(); this.registering = 0; this.probe = node => gatewayProbe(node, this.config.origin); }
  async transaction(action) {
    return this.state.storage.transaction(async storage => {
      const passwordHash = this.env.GATEWAY_PASSWORD_HASH;
      if (!gatewaySecret(passwordHash)) throw gatewayError(503, '网关登录尚未配置');
      const value = await storage.get('gateway') || { version: 1, revision: 1, nodes: [], activeId: null, sessions: [], failures: [], codes: [], pending: null, lastSwitch: null, passwordHash };
      const now = this.now();
      if (value.passwordHash !== passwordHash) { value.passwordHash = passwordHash; value.sessions = []; value.codes = []; }
      value.sessions = value.sessions.filter(session => session.expires > now).slice(-GATEWAY_LIMITS.sessions);
      value.failures = value.failures.filter(failure => failure.until > now).slice(-GATEWAY_LIMITS.failures);
      if (value.pending && now - value.pending.at > GATEWAY_LIMITS.pendingMs) value.pending = null;
      const result = await action(value, now);
      if (new TextEncoder().encode(JSON.stringify(value)).length > GATEWAY_LIMITS.bytes) throw gatewayError(413, '网关状态超过 128 KiB');
      await storage.put('gateway', value); return result;
    });
  }
  session(value, request, write = false) {
    const token = gatewaySessionCookie(request.headers.get('cookie') || '');
    return (async () => {
      const hash = gatewaySecret(token) ? await gatewayDigest(token) : '';
      const session = value.sessions.find(item => gatewayEqual(item.hash, hash));
      if (!session) throw gatewayError(401, '请先登录节点网关');
      if (write && !gatewayEqual(session.csrf, request.headers.get('x-csrf-token'))) throw gatewayError(403, '请求验证失败，请刷新后重试');
      return session;
    })();
  }
  listing(value, session, offset = 0) {
    const nodes = value.nodes.slice().sort((a, b) => a.id.localeCompare(b.id));
    return { version: 1, revision: value.revision, csrf: session.csrf, activeId: value.activeId, activeName: nodes.find(node => node.id === value.activeId)?.name || '', total: nodes.length,
      nodes: nodes.slice(offset, offset + GATEWAY_LIMITS.page).map(({ id, name, mode, ready, checkedAt }) => ({ id, name, mode, ready, checkedAt })),
      next: offset + GATEWAY_LIMITS.page < nodes.length ? offset + GATEWAY_LIMITS.page : null, pending: value.pending && { id: value.pending.id, nodeId: value.pending.nodeId, at: value.pending.at }, lastSwitch: value.lastSwitch };
  }
  registration(value, body) {
    const node = gatewayNode(body.node, this.config);
    if (!gatewaySecret(body.secret)) throw gatewayError(400, '节点接入凭据无效');
    const existing = value.nodes.find(item => item.id === node.id);
    if (existing && (!gatewayEqual(existing.secret, body.secret) || existing.backendOrigin !== node.backendOrigin)) throw gatewayError(409, '节点已有其他接入身份或地址，不能隐式覆盖');
    if (value.nodes.some(item => item.id !== node.id && item.backendOrigin === node.backendOrigin)) throw gatewayError(409, '该后端地址已登记');
    if (!existing && value.nodes.length >= GATEWAY_LIMITS.nodes) throw gatewayError(429, '最多登记 64 个节点，请先移除不用的节点');
    if (value.pending) throw gatewayError(409, '入口正在切换，请稍后登记');
    return { node, existing };
  }
  async register(body) {
    if (this.registering >= 2) throw gatewayError(429, '正在登记其他节点，请稍后重试');
    this.registering++;
    try { return await this.registerNode(body); } finally { this.registering--; }
  }
  async registerNode(body) {
    const codeHash = gatewaySecret(body.authorizationCode) ? await gatewayDigest(body.authorizationCode) : '';
    const candidate = await this.transaction(value => {
      const plan = this.registration(value, body);
      if (!plan.existing && !value.codes.some(code => gatewayEqual(code.hash, codeHash))) throw gatewayError(401, '接入码无效或已撤销');
      return { ...plan.node, secret: body.secret };
    });
    if (!await this.probe(candidate)) throw gatewayError(503, '节点私有入口尚未就绪，或身份与登记内容不匹配');
    return this.transaction((value, now) => {
      const plan = this.registration(value, body);
      if (!plan.existing && !value.codes.some(code => gatewayEqual(code.hash, codeHash))) throw gatewayError(401, '接入码已被撤销');
      const next = { ...candidate, ready: true, checkedAt: now, registeredAt: plan.existing?.registeredAt || now };
      if (plan.existing) value.nodes[value.nodes.indexOf(plan.existing)] = next; else value.nodes.push(next);
      value.revision++;
      return { ok: true, nodeId: next.id, origin: this.config.origin, backendOrigin: next.backendOrigin, registeredAt: next.registeredAt };
    });
  }
  async checkNode(request, id) {
    const node = await this.transaction(async value => { await this.session(value, request, true); const node = value.nodes.find(item => item.id === id); if (!node) throw gatewayError(404, '节点已移除'); return node; });
    if (node.checkedAt && this.now() - node.checkedAt < 5000) return { id, ready: node.ready, checkedAt: node.checkedAt };
    if (this.probes.has(id)) return this.probes.get(id);
    if (this.probes.size >= 4) throw gatewayError(429, '正在检查其他节点，请稍后重试');
    const promise = (async () => {
      const ready = await this.probe(node);
      return this.transaction(async (value, now) => {
        await this.session(value, request, true);
        const current = value.nodes.find(item => item.id === id);
        if (!current || current.secret !== node.secret || current.backendOrigin !== node.backendOrigin) throw gatewayError(409, '节点接入配置已变化');
        current.ready = ready; current.checkedAt = now; return { id, ready, checkedAt: now };
      });
    })().finally(() => this.probes.delete(id));
    this.probes.set(id, promise); return promise;
  }
  async switchNode(request, body) {
    if (!gatewayHex(body.nodeId) || !gatewayHex(body.operation) || !Number.isSafeInteger(body.revision)) throw gatewayError(400, '切换参数无效');
    const planned = await this.transaction(async (value, now) => {
      await this.session(value, request, true);
      if (value.lastSwitch?.id === body.operation) {
        if (value.lastSwitch.nodeId !== body.nodeId) throw gatewayError(409, '操作身份与原目标不一致');
        return { completed: { ok: true, activeId: value.activeId, operation: body.operation, revision: value.revision } };
      }
      if (value.pending) throw gatewayError(409, '已有切换正在核对，请刷新状态；不会排队重发');
      if (body.revision !== value.revision) throw gatewayError(409, '节点列表已更新，请刷新后重新选择');
      const node = value.nodes.find(item => item.id === body.nodeId); if (!node) throw gatewayError(404, '节点已移除');
      value.pending = { id: body.operation, nodeId: node.id, at: now }; return { node };
    });
    if (planned.completed) return planned.completed;
    const ready = await this.probe(planned.node);
    return this.transaction(async (value, now) => {
      if (value.pending?.id !== body.operation) throw gatewayError(409, '这次检查已过期，未切换入口');
      value.pending = null;
      let failure; try { await this.session(value, request, true); } catch (error) { failure = error; }
      const node = value.nodes.find(item => item.id === body.nodeId);
      if (node) { node.ready = ready; node.checkedAt = now; }
      if (failure) return { failure: { status: failure.status, message: failure.message } };
      if (!node || value.revision !== body.revision || node.secret !== planned.node.secret || !ready) return { failure: { status: ready ? 409 : 503, message: ready ? '节点配置已变化，未切换' : '目标节点未就绪，当前入口保持' } };
      value.activeId = node.id; value.revision++; value.lastSwitch = { id: body.operation, nodeId: node.id, at: now };
      return { ok: true, activeId: node.id, operation: body.operation, revision: value.revision };
    });
  }
  async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (path === '/route' && request.method === 'GET') {
        const value = await this.state.storage.get('gateway'), node = value?.nodes.find(item => item.id === value.activeId);
        return Response.json(node ? { id: node.id, name: node.name, mode: node.mode, backendOrigin: node.backendOrigin, secret: node.secret } : null);
      }
      const body = request.method === 'GET' ? {} : await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw gatewayError(400, 'JSON 格式无效');
      if (path === '/api/register' && request.method === 'POST') return Response.json(await this.register(body));
      if (path === '/api/node-status' && request.method === 'POST') {
        if (!gatewayHex(body.nodeId) || !gatewaySecret(body.secret)) throw gatewayError(400, '节点接入凭据无效');
        const value = await this.state.storage.get('gateway'), node = value?.nodes.find(item => item.id === body.nodeId && gatewayEqual(item.secret, body.secret));
        return Response.json({ registered: !!node, active: !!node && value.activeId === node.id });
      }
      if (path === '/api/switch' && request.method === 'POST') {
        const result = await this.switchNode(request, body); if (result.failure) throw gatewayError(result.failure.status, result.failure.message); return Response.json(result);
      }
      if (path === '/api/probe' && request.method === 'POST') {
        if (!gatewayHex(body.nodeId)) throw gatewayError(400, '节点身份无效'); return Response.json(await this.checkNode(request, body.nodeId));
      }
      return await this.transaction(async (value, now) => {
        if (path === '/api/login' && request.method === 'POST') {
          const client = request.headers.get('x-gateway-client') || 'unknown', failure = value.failures.find(item => item.client === client);
          if (failure?.count >= 8) return Response.json({ error: '登录尝试过多，请 15 分钟后再试' }, { status: 429 });
          if (typeof body.password !== 'string' || body.password.length > 128 || !gatewayEqual(await gatewayDigest(body.password), this.env.GATEWAY_PASSWORD_HASH)) {
            if (failure) failure.count++; else value.failures.push({ client, count: 1, until: now + 900000 }); value.failures = value.failures.slice(-GATEWAY_LIMITS.failures);
            return Response.json({ error: '网关密码不正确' }, { status: 401 });
          }
          value.failures = value.failures.filter(item => item.client !== client);
          const token = gatewayRandom(); value.sessions.push({ hash: await gatewayDigest(token), csrf: gatewayRandom(), expires: now + 604800000 }); value.sessions = value.sessions.slice(-GATEWAY_LIMITS.sessions);
          return Response.json({ ok: true }, { headers: { 'set-cookie': gatewayCookie(token, this.config.origin) } });
        }
        const session = await this.session(value, request, request.method !== 'GET');
        if (path === '/api/logout' && request.method === 'POST') { value.sessions = value.sessions.filter(item => item !== session); return Response.json({ ok: true }, { headers: { 'set-cookie': gatewayCookie('', this.config.origin, true) } }); }
        if (path === '/api/nodes' && request.method === 'GET') {
          const offset = Number(url.searchParams.get('offset') || 0); if (!Number.isInteger(offset) || offset < 0 || offset >= GATEWAY_LIMITS.nodes) throw gatewayError(400, '分页参数无效');
          return Response.json(this.listing(value, session, offset));
        }
        if (path === '/api/codes' && request.method === 'GET') return Response.json({ codes: value.codes.map(({ id, name, at }) => ({ id, name, at })) });
        if (path === '/api/codes' && request.method === 'POST') {
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 48 || /[\u0000-\u001f\u007f]/.test(body.name)) throw gatewayError(400, '授权码名称需为 1–48 个字符');
          if (value.codes.length >= GATEWAY_LIMITS.codes) throw gatewayError(429, '最多保存 16 个接入码');
          const key = gatewayRandom(), id = gatewayRandom(16); value.codes.push({ id, hash: await gatewayDigest(key), name: body.name.trim(), at: now });
          return Response.json({ id, code: encodeGatewayCode(this.config.origin, key) });
        }
        const code = path.match(/^\/api\/codes\/([a-f0-9]{32})$/);
        if (code && request.method === 'DELETE') { value.codes = value.codes.filter(item => item.id !== code[1]); return Response.json({ ok: true }); }
        const node = path.match(/^\/api\/nodes\/([a-f0-9]{32})$/);
        if (node && request.method === 'DELETE') {
          if (value.pending || body.revision !== value.revision) throw gatewayError(409, '正在切换或列表已更新，请刷新');
          if (value.activeId === node[1]) throw gatewayError(409, '请先切换到其他节点，再移除当前入口');
          value.nodes = value.nodes.filter(item => item.id !== node[1]); value.revision++; return Response.json({ ok: true, revision: value.revision });
        }
        throw gatewayError(404, '接口不存在');
      });
    } catch (error) { return Response.json({ error: error.status ? error.message : '网关状态暂不可用', outcome: 'rejected' }, { status: error.status || 503 }); }
  }
}
