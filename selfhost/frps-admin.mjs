const MAX_BODY = 16 * 1024;

export function frpsProxyProbe({ endpoint, username = 'admin', password, request = fetch } = {}) {
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('frps 管理地址必须是回环根地址');
  if (typeof username !== 'string' || !username || typeof password !== 'string' || password.length < 16) throw Error('frps 管理凭据无效');
  const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  return async name => {
    const response = await request(new URL('/api/proxy/http/' + encodeURIComponent(name), base), { headers: { authorization, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (response.status === 404) return false;
    if (!response.ok) throw Error('frps 管理查询失败（HTTP ' + response.status + '）');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY) throw Error('frps 管理响应超过大小上限');
    let value; try { value = JSON.parse(text); } catch { throw Error('frps 管理响应格式无效'); }
    if (!value || typeof value.status !== 'string') throw Error('frps 管理响应缺少代理状态');
    return value.status === 'online';
  };
}
