const NODE_PATH = /^\/node\/([a-z0-9-]{1,48})\/$/;
const NODE_ID = /^[a-f0-9]{32}$/;
const SCOPE = /^(?:center|node-[a-z0-9-]{1,48}|nodeid-[a-f0-9]{32})$/;
const NODE_LABEL = /^[\p{L}\p{N}_-]{1,48}-[a-f0-9]{8}$/u;
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

export function createLoginIdentity(username = 'admin', scope = '', { nodeName = '' } = {}) {
  if (typeof username !== 'string' || !username || username.length > 100 || /[\x00-\x1f\x7f]/.test(username)) throw Error('管理员用户名需为 1–100 个可打印字符');
  if (typeof scope !== 'string' || scope && !SCOPE.test(scope)) throw Error('登录入口标识无效');
  if (typeof nodeName !== 'string' || nodeName.length > 48) throw Error('节点名称需为不超过 48 个字符的文字');
  let label = scope;
  if (scope.startsWith('nodeid-')) {
    // Keep the full node ID in the form/autofill scope. Only the readable
    // username suffix uses a formatted node name and the first eight digits.
    const name = nodeName.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 48).replace(/[\uD800-\uDBFF]$/, '').replace(/^-+|-+$/g, '') || 'node';
    label = name + '-' + scope.slice(7, 15);
  }
  return Object.freeze({ username, scope, label, value: username + (label ? '@' + label : '') });
}

// Keep the legacy full scope valid. A former readable name remains valid after
// a rename only with this node's short suffix; it never changes the full node
// identity used by the request, session or autofill section.
export function canonicalLoginUsername(value, identity) {
  if (typeof value !== 'string' || value.length > 160) return null;
  if (value === identity.username) return value;
  if (identity.scope.startsWith('nodeid-')) {
    const separator = value.lastIndexOf('@'), label = value.slice(separator + 1);
    if (separator >= 0 && label.length <= 57 && NODE_LABEL.test(label) && label.endsWith('-' + identity.scope.slice(7, 15))) {
      const username = value.slice(0, separator);
      return username.length <= 100 ? username : null;
    }
  }
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
    return form.replace('<!--LOGIN_IDENTITY_HINT-->', identity.scope ? '<p id="login-identity-note" class="muted"><small>保存密码时请保留预填登录名，密码不变。原用户名和旧登录名也可登录。</small></p>' : '');
  });
}
