const NODE_PATH = /^\/node\/([a-z0-9-]{1,48})\/$/;
const NODE_ID = /^[a-f0-9]{32}$/;
const SCOPE = /^(?:center|node-[a-z0-9-]{1,48}|nodeid-[a-f0-9]{32})$/;
const escapeHTML = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function nodeLoginScope({ entryBasePath = '/', nodeId = '', sharedEntry = false } = {}) {
  if (entryBasePath !== '/') {
    const match = NODE_PATH.exec(entryBasePath);
    if (!match) throw Error('登录入口路径无效');
    return 'node-' + match[1];
  }
  if (!sharedEntry) return '';
  if (!NODE_ID.test(nodeId)) throw Error('共享入口登录需要固定节点身份');
  return 'nodeid-' + nodeId;
}

export function createLoginIdentity(username = 'admin', scope = '') {
  if (typeof username !== 'string' || !username || username.length > 100 || /[\x00-\x1f\x7f]/.test(username)) throw Error('管理员用户名需为 1–100 个可打印字符');
  if (typeof scope !== 'string' || scope && !SCOPE.test(scope)) throw Error('登录入口标识无效');
  return Object.freeze({ username, scope, value: username + (scope ? '@' + scope : '') });
}

// Decode only this entry's exact suffix. Never strip another node's suffix or
// change a configured username that already happens to contain an @ character.
export function canonicalLoginUsername(value, identity) {
  if (typeof value !== 'string' || value.length > 160) return null;
  if (value === identity.username) return value;
  const suffix = identity.scope ? '@' + identity.scope : '';
  const username = suffix && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
  return username.length <= 100 ? username : null;
}

export function renderLoginForm(html, identity, action) {
  const section = identity.scope ? 'section-coc-' + identity.scope + ' ' : '';
  const attributes = (tag, values) => {
    for (const [name, value] of Object.entries(values)) {
      tag = tag.replace(new RegExp('\\s' + name + '=(?:"[^"]*"|\'[^\']*\')', 'i'), '');
      tag = tag.replace(/\/?>(?=$)/, ending => ' ' + name + '="' + escapeHTML(value) + '"' + ending);
    }
    return tag;
  };
  // Keep working legacy defaults in source HTML for an old panel process
  // reloading a new UI before the backend itself has been restarted.
  return html.replace(/<form\b(?=[^>]*\bid=["']login-form["'])[^>]*>[\s\S]*?<\/form>/i, form => {
    form = form.replace(/^<form[^>]*>/i, tag => attributes(tag, { name: 'login-' + (identity.scope || 'default'), method: 'post', action }));
    form = form.replace(/<input\b(?=[^>]*\bid=["']username["'])[^>]*>/i, tag => attributes(tag, {
      value: identity.value, autocomplete: section + 'username', ...(identity.scope ? { 'aria-describedby': 'login-identity-note' } : {}),
    }));
    form = form.replace(/<input\b(?=[^>]*\bid=["']password["'])[^>]*>/i, tag => attributes(tag, { autocomplete: section + 'current-password' }));
    return form.replace('<!--LOGIN_IDENTITY_HINT-->', identity.scope ? '<p id="login-identity-note" class="muted"><small>保存密码时请保留预填登录名，密码不变。原用户名也可登录。</small></p>' : '');
  });
}
