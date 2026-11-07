import { parseNodeDirectory, encodePortalCode } from '../panel/public/node-directory.js';
export const PORTAL_LIMITS = Object.freeze({ sessions: 8, sessionMs: 604800000, failures: 64, failureMs: 900000, attempts: 8, stateBytes: 65536, codes: 16 });
export const portalCookieName = 'coc_portal_session';
export const portalDigest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const portalRandom = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const portalEqual = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return false; let diff = 0; for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; };
const portalError = (status, message) => Object.assign(Error(message), { status });
export function portalCookie(token, secure, expired = false) { return `${portalCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : 604800}${secure ? '; Secure' : ''}`; }
export function portalToken(header = '') { return header.split(';').map(value => value.trim()).find(value => value.startsWith(portalCookieName + '='))?.slice(portalCookieName.length + 1) || ''; }
export class PortalRegistry {
  constructor(state, env, initial) { this.state = state; this.env = env; this.initial = parseNodeDirectory(initial); this.now = () => Date.now(); }
  async fetch(request) {
    let body;
    try { body = request.method === 'GET' ? {} : await request.json(); }
    catch { return Response.json({ error: 'JSON 格式无效' }, { status: 400 }); }
    try {
      return await this.state.storage.transaction(async storage => {
        const passwordHash = this.env.PORTAL_PASSWORD_HASH;
        if (!/^[a-f0-9]{64}$/.test(passwordHash || '')) throw portalError(503, '门户登录尚未配置');
        const now = this.now(), path = new URL(request.url).pathname;
        const value = await storage.get('portal') || { directory: this.initial, revision: 1, sessions: [], failures: [], codes: [], directoryTokens: [], passwordHash };
        if (value.passwordHash !== passwordHash) { value.passwordHash = passwordHash; value.sessions = []; }
        value.sessions = value.sessions.filter(session => session.expires > now).slice(-PORTAL_LIMITS.sessions);
        value.failures = value.failures.filter(failure => failure.until > now).slice(-PORTAL_LIMITS.failures);
        const persist = async () => { if (new TextEncoder().encode(JSON.stringify(value)).length > PORTAL_LIMITS.stateBytes) throw portalError(413, '门户状态超过 64 KiB'); await storage.put('portal', value); };
        const listing = session => ({ ...value.directory, revision: value.revision, csrf: session.csrf, registeredIds: value.directoryTokens.filter(item => value.directory.nodes.some(node => node.id === item.nodeId && node.origin === item.origin)).map(item => item.nodeId) });
        if (path === '/api/login' && request.method === 'POST') {
          const client = request.headers.get('x-portal-client') || 'unknown', failure = value.failures.find(item => item.client === client);
          if (failure?.count >= PORTAL_LIMITS.attempts) throw portalError(429, '登录尝试过多，请 15 分钟后再试');
          if (typeof body?.password !== 'string' || body.password.length > 128 || !portalEqual(await portalDigest(body.password), passwordHash)) {
            if (failure) failure.count++;
            else { value.failures.push({ client, count: 1, until: now + PORTAL_LIMITS.failureMs }); value.failures = value.failures.slice(-PORTAL_LIMITS.failures); }
            await persist(); return Response.json({ error: '门户密码不正确' }, { status: 401 });
          }
          value.failures = value.failures.filter(item => item.client !== client);
          const token = portalRandom(); value.sessions.push({ hash: await portalDigest(token), csrf: portalRandom(), expires: now + PORTAL_LIMITS.sessionMs }); value.sessions = value.sessions.slice(-PORTAL_LIMITS.sessions);
          await persist(); return Response.json({ ok: true }, { headers: { 'set-cookie': portalCookie(token, new URL(this.initial.portalOrigin).protocol === 'https:') } });
        }
        if (path === '/api/register' && request.method === 'POST') {
          if (typeof body?.nodeSecret !== 'string' || !/^[a-f0-9]{64}$/.test(body.nodeSecret)) throw portalError(400, '节点身份无效');
          let node;
          try { node = parseNodeDirectory({ version: 1, portalOrigin: this.initial.portalOrigin, nodes: [body.node] }).nodes[0]; } catch (error) { throw portalError(400, error.message); }
          const existing = value.directory.nodes.find(item => item.id === node.id) || value.directory.nodes.find(item => item.origin === node.origin);
          const proof = await portalDigest(body.nodeSecret), credential = existing && value.directoryTokens.find(item => item.nodeId === existing.id);
          const owns = credential && portalEqual(credential.proof, proof);
          if (credential && !owns) throw portalError(409, '该服务器已有接入身份，请在门户移除旧节点后重新注册');
          if (existing && existing.origin !== node.origin && !owns) throw portalError(409, '节点 ID 与已有服务器冲突');
          const codeHash = typeof body.authorizationCode === 'string' && /^[a-f0-9]{64}$/.test(body.authorizationCode) ? await portalDigest(body.authorizationCode) : '';
          const code = value.codes.find(item => portalEqual(item.hash, codeHash));
          if (!owns && !code) throw portalError(401, '授权码无效或已被门户删除');
          node = { ...node, id: existing?.id || node.id, description: existing?.description ?? node.description, enabled: credential ? existing.enabled : true };
          const nodes = existing ? value.directory.nodes.map(item => item.id === existing.id ? node : item) : [...value.directory.nodes, node];
          let directory;
          try { directory = parseNodeDirectory({ ...value.directory, nodes }); } catch (error) { throw portalError(400, error.message); }
          const changed = JSON.stringify(directory) !== JSON.stringify(value.directory) || !owns;
          if (changed && value.revision >= Number.MAX_SAFE_INTEGER) throw portalError(503, '服务器目录版本达到上限');
          value.directory = directory;
          const directoryToken = await portalDigest('directory-v1\0' + body.nodeSecret + '\0' + this.initial.portalOrigin);
          value.directoryTokens = value.directoryTokens.filter(item => item.nodeId !== node.id);
          value.directoryTokens.push({ nodeId: node.id, origin: node.origin, hash: await portalDigest(directoryToken), proof, registeredAt: credential?.registeredAt || now });
          if (changed) value.revision++;
          await persist(); return Response.json({ ok: true, nodeId: node.id, origin: node.origin, enabled: node.enabled });
        }
        if (path === '/api/directory' && request.method === 'GET') {
          const authorization = request.headers.get('authorization') || '';
          const hash = /^Bearer [a-f0-9]{64}$/.test(authorization) ? await portalDigest(authorization.slice(7)) : '';
          const credential = value.directoryTokens.find(item => portalEqual(hash, item.hash));
          if (!credential || !value.directory.nodes.some(node => node.id === credential.nodeId && node.origin === credential.origin)) throw portalError(401, '节点目录访问授权无效');
          return Response.json(value.directory);
        }
        const token = portalToken(request.headers.get('cookie') || '');
        const hash = /^[a-f0-9]{64}$/.test(token) ? await portalDigest(token) : '';
        const session = value.sessions.find(item => item.hash === hash);
        if (!session) throw portalError(401, '请先登录统一门户');
        if (request.method !== 'GET' && !portalEqual(request.headers.get('x-csrf-token'), session.csrf)) throw portalError(403, '请求验证失败，请刷新列表后重试');
        if (path === '/api/logout' && request.method === 'POST') {
          value.sessions = value.sessions.filter(item => item !== session); await persist();
          return Response.json({ ok: true }, { headers: { 'set-cookie': portalCookie('', new URL(this.initial.portalOrigin).protocol === 'https:', true) } });
        }
        if (path === '/api/nodes' && request.method === 'GET') return Response.json(listing(session));
        if (path === '/api/authorization-codes' && request.method === 'GET') return Response.json({ codes: value.codes.map(({ id, name, createdAt }) => ({ id, name, createdAt })) });
        if (path === '/api/authorization-codes' && request.method === 'POST') {
          if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 48 || /[\u0000-\u001f\u007f]/.test(body.name)) throw portalError(400, '授权码名称需为 1–48 个字符');
          if (value.codes.length >= PORTAL_LIMITS.codes) throw portalError(429, '授权码已达 16 个，请先删除不用的授权码');
          const code = portalRandom(), id = portalRandom().slice(0, 32), createdAt = now;
          value.codes.push({ id, name: body.name.trim(), hash: await portalDigest(code), createdAt }); await persist();
          return Response.json({ id, code: encodePortalCode(this.initial.portalOrigin, code), name: body.name.trim(), createdAt });
        }
        const codeMatch = path.match(/^\/api\/authorization-codes\/([a-f0-9]{32})$/);
        if (codeMatch && request.method === 'DELETE') {
          const original = value.codes.length; value.codes = value.codes.filter(item => item.id !== codeMatch[1]);
          if (original === value.codes.length) throw portalError(404, '授权码已删除');
          await persist(); return Response.json({ ok: true });
        }
        const match = path.match(/^\/api\/nodes\/([a-z][a-z0-9-]{0,31})$/);
        if ((path === '/api/nodes' && request.method === 'POST') || (match && ['PUT', 'DELETE'].includes(request.method))) {
          if (!Number.isSafeInteger(body?.revision) || body.revision !== value.revision) throw portalError(409, '服务器列表已更新，请重新读取后再操作');
          if (value.revision >= Number.MAX_SAFE_INTEGER) throw portalError(503, '服务器目录版本已达到上限');
          const nodes = [...value.directory.nodes], id = match?.[1], index = nodes.findIndex(node => node.id === id);
          if (match && index < 0) throw portalError(404, '服务器已移除，请刷新列表');
          if (request.method === 'DELETE') nodes.splice(index, 1);
          else if (match) { if (body.node?.id !== id) throw portalError(400, '编辑时不能修改节点 ID'); nodes[index] = body.node; }
          else nodes.push(body.node);
          let directory;
          try { directory = parseNodeDirectory({ ...value.directory, nodes }); } catch (error) { throw portalError(400, error.message); }
          value.directory = directory;
          value.directoryTokens = value.directoryTokens.filter(item => nodes.some(node => node.id === item.nodeId && node.origin === item.origin));
          value.revision++; await persist(); return Response.json(listing(session));
        }
        throw portalError(404, '接口不存在');
      });
    } catch (error) { return Response.json({ error: error.status ? error.message : '门户状态暂不可用，请重试' }, { status: error.status || 503 }); }
  }
}
