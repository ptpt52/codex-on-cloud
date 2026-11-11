import net from 'node:net';
import { WebSocketServer } from 'ws';
import { createForwardAgentState, AGENT_LIMITS } from './forward-agent-state.mjs';
import { forwardHeartbeat } from './forward-heartbeat.mjs';
import { serialConfig } from './serial-config.mjs';

const ID = /^[a-f0-9]{32}$/;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, maximum) => typeof value === 'string' && Buffer.byteLength(value) <= maximum && !/[\p{Cc}\p{Cf}]/u.test(value);

export function agentInventory(value) {
  if (!fields(value, ['type', 'serialPorts', 'interfaces', 'truncated', 'error']) || value.type !== 'inventory' || !Array.isArray(value.serialPorts) || value.serialPorts.length > 128 || !Array.isArray(value.interfaces) || value.interfaces.length > 128 || typeof value.truncated !== 'boolean' || !['', 'inventory_failed', 'serial_list_failed'].includes(value.error)) throw Error('助手设备信息无效');
  const ports = value.serialPorts.map(path => { serialConfig({ path, baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, dtr: false, rts: false }); return path; });
  if (new Set(ports).size !== ports.length) throw Error('助手串口列表重复');
  let addresses = 0;
  const interfaces = value.interfaces.map(item => {
    if (!fields(item, ['name', 'index', 'up', 'addresses', 'error']) || !text(item.name, 128) || !item.name || !Number.isSafeInteger(item.index) || item.index < 1 || typeof item.up !== 'boolean' || typeof item.error !== 'boolean' || !Array.isArray(item.addresses) || item.addresses.length > 32) throw Error('助手网卡信息无效');
    const values = item.addresses.map(address => {
      if (!fields(address, ['address', 'prefix']) || net.isIP(address.address) !== 4 || !Number.isInteger(address.prefix) || address.prefix < 0 || address.prefix > 32 || ++addresses > 1024) throw Error('助手 IPv4 信息无效');
      return { address: address.address, prefix: address.prefix };
    });
    return { name: item.name, index: item.index, up: item.up, error: item.error, addresses: values };
  });
  if (new Set(interfaces.map(i => i.index)).size !== interfaces.length) throw Error('助手网卡标识重复');
  return { serialPorts: ports, interfaces, truncated: value.truncated, error: value.error };
}

// The durable desired configuration is separate from the bounded runtime. The
// agent control link never carries TCP/serial bytes or desktop input.
export function createForwardAgents(config, forwarding) {
  const identity = { get entry() { return config.origin + (config.entryBasePath && config.entryBasePath !== '/' ? config.entryBasePath : ''); }, id: config.nodeId || '' };
  const state = createForwardAgentState(config.dataDir, forwarding.validate, identity);
  const sessions = new Map(), runtime = new Map(), inventories = new Map(), updates = new Map();
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: AGENT_LIMITS.message });
  let closed = false;
  function send(session, message) {
    const bytes = JSON.stringify(message);
    if (session.ws.readyState !== 1) return false;
    if (Buffer.byteLength(bytes) > AGENT_LIMITS.message || session.ws.bufferedAmount + Buffer.byteLength(bytes) > AGENT_LIMITS.buffer) { session.ws.terminate(); return false; }
    session.ws.send(bytes, error => { if (error) session.ws.terminate(); }); return true;
  }
  function stopRuntime(entry) { if (entry.mapping) forwarding.stop({ id: entry.mapping }); runtime.delete(entry.ruleId); }
  function stopAgent(id) { for (const entry of runtime.values()) if (entry.agentId === id) stopRuntime(entry); }
  function disconnect(id) { clearTimeout(updates.get(id)); updates.delete(id); const session = sessions.get(id); if (session) { sessions.delete(id); session.ws?.terminate(); } inventories.delete(id); stopAgent(id); }
  // At most one pending policy notification per connected helper (eight total).
  function scheduleUpdate(id) { if (closed || updates.has(id)) return; updates.set(id, setTimeout(() => { updates.delete(id); reconcile(id, true); }, 20).unref()); }
  function reconcile(agentId, force = false) {
    if (closed) return;
    const agent = state.find(agentId), session = sessions.get(agentId);
    if (!agent || !session || session.ws?.readyState !== 1) return;
    const mappings = new Map(forwarding.list(item => item.authorization?.helperId === agentId).mappings.map(m => [m.id, m]));
    let changed = force;
    for (const entry of runtime.values()) {
      if (entry.agentId !== agentId) continue;
      const rule = agent.rules.find(r => r.id === entry.ruleId);
      if (!rule?.enabled || rule.revision !== entry.revision) { stopRuntime(entry); changed = true; }
    }
    for (const rule of agent.rules.filter(r => r.enabled)) {
      let entry = runtime.get(rule.id);
      if (entry?.mapping && !mappings.has(entry.mapping)) { entry.mapping = ''; entry.code = ''; entry.retryAt = Date.now() + 15000; changed = true; }
      if (entry?.mapping || entry && entry.retryAt > Date.now()) continue;
      entry ||= { agentId, instance: session.instance, ruleId: rule.id, revision: rule.revision, mapping: '', code: '', error: '', retryAt: 0 };
      runtime.set(rule.id, entry);
      try {
        const grantedHash = agent.keyHash;
        const result = forwarding.create(rule.config, 'agent:' + agent.id + ':' + rule.id, () => closed ? 'server_stopping' : state.find(agent.id)?.keyHash === grantedHash ? '' : 'authorization_revoked', { role: 'admin', helperId: agent.id, ruleId: rule.id });
        entry.mapping = result.id; entry.code = result.code; entry.error = ''; entry.retryAt = 0;
      } catch (error) { entry.error = String(error.message).slice(0, 256); entry.retryAt = Date.now() + 15000; }
      changed = true;
    }
    if (changed) {
      send(session, { type: 'rules', version: 1, rules: agent.rules.filter(r => r.enabled).flatMap(rule => {
        const entry = runtime.get(rule.id);
        return entry?.mapping ? [{ id: rule.id, revision: rule.revision, name: rule.name, mappingId: entry.mapping, code: entry.code, config: rule.config }] : [];
      }) });
    }
  }
  const timer = setInterval(() => { for (const id of sessions.keys()) reconcile(id); }, 5000).unref();
  function list() {
    const mappings = new Map(forwarding.list(item => !!item.authorization?.helperId).mappings.map(m => [m.id, m]));
    return { protocol: 1, limits: { agents: AGENT_LIMITS.agents, rules: AGENT_LIMITS.rules, active: 32 }, node: identity,
      agents: state.all().map(agent => {
        const session = sessions.get(agent.id);
        return { id: agent.id, name: agent.name, createdAt: agent.createdAt, online: session?.ws?.readyState === 1, connectedAt: session?.connectedAt || null,
          inventory: session?.inventory || inventories.get(agent.id) || null,
          rules: agent.rules.map(rule => {
            const entry = runtime.get(rule.id), mapping = entry?.mapping && mappings.get(entry.mapping);
            return { ...rule, state: !rule.enabled ? 'disabled' : mapping?.state || (entry?.error ? 'failed' : session ? 'starting' : 'offline'), error: entry?.error || '', mapping: mapping || null };
          }) };
      }) };
  }
  function action(path, body) {
    let result;
    if (path === 'create') result = state.create(body);
    else if (path === 'rekey') { const previous = state.find(body?.id)?.keyHash; try { result = state.rekey(body); } finally { if (state.find(body?.id)?.keyHash !== previous) disconnect(body.id); } }
    else if (path === 'remove') { try { result = state.remove(body); } finally { if (body?.id && !state.find(body.id)) disconnect(body.id); } }
    else if (path === 'rule') { try { result = state.saveRule(body); } finally { reconcile(body?.agentId, true); } }
    else if (path === 'rule/remove') { try { result = state.removeRule(body); } finally { reconcile(body?.agentId, true); } }
    else if (path === 'inventory') {
      if (!fields(body, ['id']) || !ID.test(body.id || '')) throw Object.assign(Error('助手标识无效'), { status: 400 });
      const session = sessions.get(body.id);
      if (!session) throw Object.assign(Error('助手未连接，请稍后刷新'), { status: 409 });
      if (Date.now() - session.inventoryRequestedAt < 2000) throw Object.assign(Error('设备信息刷新过于频繁'), { status: 429 });
      session.inventoryRequestedAt = Date.now(); send(session, { type: 'inventory-request' }); result = { ok: true };
    } else throw Object.assign(Error('助手操作不存在'), { status: 404 });
    return result;
  }
  function upgrade(req, socket, head) {
    const deny = (status, error = '') => socket.end(`HTTP/1.1 ${status} Rejected\r\n${identity.id ? 'X-Codex-Node-Id: ' + identity.id + '\r\n' : ''}Connection: close\r\n${error ? 'X-Codex-Forward-Error: ' + error + '\r\n' : ''}Content-Length: 0\r\n\r\n`);
    if (closed) return deny(503);
    const match = /^Bearer ([a-f0-9]{32}\.[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    const agent = match && state.authenticate(match[1]);
    if (!agent || req.headers['sec-websocket-protocol'] !== 'codex-agent-v1') return deny(401, 'agent_key_invalid');
    if (identity.id && req.headers['x-codex-forward-node'] !== identity.id) return deny(409, 'node_changed');
    const instance = req.headers['x-codex-agent-instance'];
    if (typeof instance !== 'string' || !ID.test(instance)) return deny(400, 'protocol_error');
    if (sessions.has(agent.id)) return deny(409, 'agent_already_connected');
    const session = { ws: null, instance, connectedAt: Date.now(), inventory: null, inventoryRequestedAt: 0, messages: 0, messageAt: Date.now() };
    sessions.set(agent.id, session); // Reserve before the asynchronous upgrade.
    // A new process has no old mapping contexts, even when the desired rules match.
    if ([...runtime.values()].some(entry => entry.agentId === agent.id && entry.instance !== instance)) stopAgent(agent.id);
    const abandoned = () => { if (!session.ws && sessions.get(agent.id) === session) sessions.delete(agent.id); };
    socket.once('close', abandoned);
    try {
      server.handleUpgrade(req, socket, head, ws => {
        socket.removeListener('close', abandoned); session.ws = ws;
        ws.on('error', () => ws.terminate());
        forwardHeartbeat(ws, () => ws.terminate());
        ws.once('close', (code, reason) => {
          if (sessions.get(agent.id) !== session) return;
          sessions.delete(agent.id);
          // Individual mapping sockets retain their existing bounded recovery.
          if (code === 1000 && reason.toString() === 'client_stopping') stopAgent(agent.id);
        });
        ws.on('message', (bytes, binary) => {
          if (sessions.get(agent.id) !== session || state.find(agent.id)?.keyHash !== agent.keyHash) return ws.terminate();
          if (Date.now() - session.messageAt >= 60000) { session.messageAt = Date.now(); session.messages = 0; }
          if (++session.messages > 120) return ws.terminate();
          try {
            if (binary) throw Error();
            const value = JSON.parse(bytes.toString());
            if (value?.type === 'inventory') { if (bytes.length > AGENT_LIMITS.inventoryBytes) throw Error(); session.inventory = { ...agentInventory(value), updatedAt: Date.now() }; inventories.set(agent.id, session.inventory); }
            else if (value?.type === 'rule-result' && fields(value, ['type', 'id', 'mappingId', 'revision', 'error']) && ID.test(value.id) && ID.test(value.mappingId) && text(value.error, 256)) {
              const entry = runtime.get(value.id);
              if (entry?.agentId === agent.id && entry.mapping === value.mappingId && entry.revision === value.revision) {
                entry.error = value.error;
                if (value.error) { forwarding.stop({ id: entry.mapping }); entry.mapping = ''; entry.code = ''; entry.retryAt = Date.now() + 15000; scheduleUpdate(agent.id); }
              }
            } else throw Error();
          } catch { ws.close(1008, 'protocol_error'); ws.terminate(); }
        });
        send(session, { type: 'agent-ready', version: 1, id: agent.id, name: agent.name, node: identity, ruleLimit: AGENT_LIMITS.rules, inventoryIntervalMs: 30000 });
        reconcile(agent.id, true); send(session, { type: 'inventory-request' });
      });
    } catch { sessions.delete(agent.id); socket.destroy(); }
  }
  function close() { closed = true; clearInterval(timer); for (const timeout of updates.values()) clearTimeout(timeout); updates.clear(); for (const id of sessions.keys()) disconnect(id); server.close(); }
  return { list, action, upgrade, close };
}
