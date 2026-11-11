import { constants, openSync, closeSync, readSync, fstatSync, fsyncSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { equal } from './auth.mjs';
import { forwardDeviceName } from './forward-validation.mjs';

export const AGENT_LIMITS = Object.freeze({ agents: 8, rules: 16, file: 128 * 1024, inventory: 128, inventoryBytes: 32 * 1024, message: 48 * 1024, buffer: 128 * 1024 });
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(Error(message), { status, outcome: 'rejected' });
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

// Eight fixed slots in one bounded, owner-only file and one atomic temporary.
// Secrets are retained so a fully authorized administrator can copy a key later.
export function createForwardAgentState(directory, validateRule, identity) {
  const file = join(directory, 'forward-agents.json'), temporary = file + '.tmp';
  let agents = [];
  const parent = () => { const s = lstatSync(directory); if (!s.isDirectory() || s.uid !== process.getuid()) throw Error('助手配置目录无效'); };
  parent();
  function checkRule(value) {
    if (!fields(value, ['id', 'name', 'revision', 'enabled', 'config']) || !id(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.enabled !== 'boolean') throw Error('助手映射规则无效');
    return { id: value.id, name: forwardDeviceName(value.name), revision: value.revision, enabled: value.enabled, config: validateRule(value.config, { policy: false }) };
  }
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > AGENT_LIMITS.file) throw Error('助手配置文件权限或大小无效');
    const bytes = Buffer.alloc(AGENT_LIMITS.file + 1), size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > AGENT_LIMITS.file) throw Error('助手配置文件过大');
    const saved = JSON.parse(bytes.subarray(0, size));
    if (!fields(saved, ['version', 'agents']) || saved.version !== 2 || !Array.isArray(saved.agents) || saved.agents.length !== AGENT_LIMITS.agents) throw Error('助手配置格式无效');
    agents = saved.agents.map((value, index) => {
      if (!fields(value, ['id', 'slot', 'secret', 'keyRevision', 'createdAt', 'rules', 'temporaryKeyVisible', 'visibilityRevision']) || !id(value.id) || value.slot !== index + 1 || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) || !Number.isSafeInteger(value.keyRevision) || value.keyRevision < 1 || !Number.isSafeInteger(value.createdAt) || !Array.isArray(value.rules) || value.rules.length > AGENT_LIMITS.rules || value.temporaryKeyVisible !== undefined && typeof value.temporaryKeyVisible !== 'boolean' || value.visibilityRevision !== undefined && (!Number.isSafeInteger(value.visibilityRevision) || value.visibilityRevision < 1)) throw Error('助手槽位配置无效');
      const rules = value.rules.map(checkRule);
      if (new Set(rules.map(r => r.id)).size !== rules.length) throw Error('助手规则标识重复');
      return decorate({ temporaryKeyVisible: false, visibilityRevision: 1, ...value, rules });
    });
    if (new Set(agents.flatMap(a => a.rules.map(r => r.id))).size !== agents.reduce((n, a) => n + a.rules.length, 0)) throw Error('助手规则标识重复');
    if (new Set(agents.map(a => a.id)).size !== agents.length) throw Error('助手标识重复');
  } catch (error) { if (error.code !== 'ENOENT') throw Error('助手配置无法读取：本版仅支持全新配置，请检查 data/panel/forward-agents.json', { cause: error }); }
  finally { if (fd !== undefined) closeSync(fd); }
  function persist(next) {
    const bytes = Buffer.from(JSON.stringify({ version: 2, agents: next.map(({ id, slot, secret, keyRevision, createdAt, rules, temporaryKeyVisible, visibilityRevision }) => ({ id, slot, secret, keyRevision, createdAt, rules, temporaryKeyVisible, visibilityRevision })) }) + '\n');
    if (bytes.length > AGENT_LIMITS.file) throw fail(409, '助手配置已达到 128 KiB 上限');
    parent();
    try { const s = lstatSync(temporary); if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1) throw Error('助手配置临时文件无效'); unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let created = false;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); created = true;
      const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file); agents = next;
      const parentFD = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parentFD); } finally { closeSync(parentFD); }
    } finally { if (created) { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
  }
  function decorate(value) { return { ...value, name: '助手' + value.slot, keyHash: hash(value.id + '.' + value.secret) }; }
  if (!agents.length) persist(Array.from({ length: AGENT_LIMITS.agents }, (_, i) => decorate({ id: randomBytes(16).toString('hex'), slot: i + 1, secret: randomBytes(32).toString('base64url'), keyRevision: 1, temporaryKeyVisible: false, visibilityRevision: 1, createdAt: Date.now(), rules: [] })));
  const find = value => agents.find(a => a.id === value);
  function requireAgent(value) { if (!id(value)) throw fail(400, '助手标识无效'); const agent = find(value); if (!agent) throw fail(404, '助手槽位不存在'); return agent; }
  function keyFor(agent) { return 'COCA2.' + Buffer.from(JSON.stringify({ version: 2, server: identity.entry, node: identity.id, agent: agent.id, secret: agent.secret })).toString('base64url'); }
  function change(agent) { persist(agents.map(a => a.id === agent.id ? agent : a)); }
  return {
    all: () => agents,
    find,
    authenticate(token) {
      const match = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
      const agent = match && find(match[1]); return agent && equal(agent.keyHash, hash(token)) ? agent : null;
    },
    key(body) {
      if (!fields(body, ['id']) || Object.keys(body).length !== 1) throw fail(400, '助手标识无效');
      const agent = requireAgent(body.id); return { id: agent.id, key: keyFor(agent), revision: agent.keyRevision };
    },
    visibility(body) {
      if (!fields(body, ['id', 'revision', 'visible']) || Object.keys(body).length !== 3 || typeof body.visible !== 'boolean') throw fail(400, '助手 key 可见设置无效');
      const old = requireAgent(body.id);
      if (body.revision !== old.visibilityRevision) throw fail(409, '可见设置已更新，请刷新后重试');
      if (body.visible === old.temporaryKeyVisible) return { visible: old.temporaryKeyVisible, revision: old.visibilityRevision };
      if (!Number.isSafeInteger(old.visibilityRevision + 1)) throw fail(409, '可见设置版本已达到上限');
      const agent = { ...old, temporaryKeyVisible: body.visible, visibilityRevision: old.visibilityRevision + 1 }; change(agent);
      return { visible: agent.temporaryKeyVisible, revision: agent.visibilityRevision };
    },
    rekey(body) {
      if (!fields(body, ['id', 'revision']) || Object.keys(body).length !== 2) throw fail(400, '助手标识或 key 版本无效');
      const old = requireAgent(body.id);
      if (body.revision !== old.keyRevision) throw fail(409, 'key 已重新生成，请重新查看后操作');
      if (!Number.isSafeInteger(old.keyRevision + 1)) throw fail(409, 'key 版本已达到上限');
      const agent = decorate({ ...old, secret: randomBytes(32).toString('base64url'), keyRevision: old.keyRevision + 1 }); change(agent);
      return { id: agent.id, key: keyFor(agent), revision: agent.keyRevision };
    },
    saveRule(body) {
      if (!fields(body, ['agentId', 'id', 'revision', 'name', 'enabled', 'config'])) throw fail(400, '助手规则格式无效');
      const agent = requireAgent(body.agentId), old = agent.rules.find(r => r.id === body.id);
      if (body.id !== undefined && (!id(body.id) || !old)) throw fail(404, '映射规则已移除，请刷新');
      if (!old && body.revision !== undefined) throw fail(400, '新规则不能携带旧版本号');
      if (old && old.revision !== body.revision) throw fail(409, '映射规则已更新，请刷新后重新编辑');
      if (!old && agent.rules.length >= AGENT_LIMITS.rules) throw fail(409, '每个助手最多保存 16 条规则');
      if (typeof body.enabled !== 'boolean') throw fail(400, '映射启用状态无效');
      const rule = { id: old?.id || randomBytes(16).toString('hex'), revision: (old?.revision || 0) + 1, name: forwardDeviceName(body.name), enabled: body.enabled, config: validateRule(body.config, { policy: body.enabled }) };
      if (!Number.isSafeInteger(rule.revision)) throw fail(409, '映射版本已达到上限，请重新创建');
      for (const other of agents) for (const r of other.rules) {
        if (!r.enabled || !rule.enabled || other.id === agent.id && r.id === rule.id) continue;
        const reverse = rule.config.direction === 'reverse';
        if ((r.config.direction === 'reverse') === reverse && r.config.localPort === rule.config.localPort && (reverse || other.id === agent.id)) throw fail(409, '该助手或服务器监听端口已有启用的规则');
        if (other.id === agent.id && rule.config.serial && r.config.serial?.path === rule.config.serial.path) throw fail(409, '同一个串口不能同时用于两条启用的规则');
      }
      change({ ...agent, rules: old ? agent.rules.map(r => r.id === rule.id ? rule : r) : [...agent.rules, rule] }); return rule;
    },
    removeRule(body) {
      if (!fields(body, ['agentId', 'id', 'revision']) || !id(body.id)) throw fail(400, '映射规则标识无效');
      const agent = requireAgent(body.agentId), rule = agent.rules.find(r => r.id === body.id);
      if (!rule || rule.revision !== body.revision) throw fail(409, '映射规则已变化，请刷新');
      change({ ...agent, rules: agent.rules.filter(r => r.id !== body.id) }); return { ok: true };
    },
  };
}
