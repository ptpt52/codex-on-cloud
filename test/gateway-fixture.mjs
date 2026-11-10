import { GatewayRegistry } from '../gateway/registry.mjs';
import { createGateway } from '../gateway/worker.mjs';
import { gatewayDigest, decodeGatewayCode } from '../gateway/protocol.mjs';

export async function gatewayFixture({ origin = 'https://desk.example.test', backendZone = 'example.test', request, assets, probe } = {}) {
  const password = 'gateway-test-only-password-' + 'a'.repeat(32), config = { version: 1, origin, backendZone }, env = { GATEWAY_PASSWORD_HASH: await gatewayDigest(password) };
  const storage = { value: undefined, chain: Promise.resolve(), active: 0,
    async get() { await this.chain; return structuredClone(this.value); },
    transaction(fn) {
      if (++this.active > 64) throw Error('fixture transaction limit');
      const action = this.chain.then(async () => { let value = structuredClone(this.value); const result = await fn({ get: async () => structuredClone(value), put: async (_key, next) => { value = structuredClone(next); } }); this.value = value; return result; });
      this.chain = action.catch(() => {}); return action.finally(() => { this.active--; });
    },
  };
  let clock = Date.now(), registry = new GatewayRegistry({ storage }, env, config); registry.now = () => clock; if (probe) registry.probe = probe;
  env.GATEWAY_REGISTRY = { idFromName: name => name, get: () => registry };
  const worker = createGateway({ config, request, assets }); let cookie = '', csrf = '';
  const fetch = (url, options) => worker.fetch(new Request(url, options), env);
  const api = (path, { method = 'GET', body, headers = {} } = {}) => fetch(origin + '/__nodes/api/' + path, { method, headers: { origin, cookie, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { config, origin, password, env, storage, worker, fetch, api, get registry() { return registry; }, advance(ms) { clock += ms; },
    async login() { const response = await api('login', { method: 'POST', body: { password } }); if (response.status !== 200) throw Error('gateway fixture login failed'); cookie = response.headers.get('set-cookie').split(';')[0]; const data = await (await api('nodes')).json(); csrf = data.csrf; return data; },
    async code() { const response = await api('codes', { method: 'POST', body: { name: '测试接入' } }); if (response.status !== 200) throw Error('gateway fixture code failed'); const value = await response.json(); return { ...value, key: decodeGatewayCode(value.code).key }; },
    register(node, secret, code = '') { return api('register', { method: 'POST', body: { node, secret, authorizationCode: code }, headers: { cookie: '', 'x-csrf-token': '' } }); },
    async select(id, operation = crypto.randomUUID().replaceAll('-', '')) { const state = await (await api('nodes')).json(); return api('switch', { method: 'POST', body: { nodeId: id, operation, revision: state.revision } }); },
    restart() { registry = new GatewayRegistry({ storage }, env, config); registry.now = () => clock; if (probe) registry.probe = probe; },
  };
}
