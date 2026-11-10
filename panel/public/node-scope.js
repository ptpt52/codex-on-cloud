// Pin this page to its node. An old frame keeps its parent's intended identity.
const valid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function nodeIdentity() {
  const query = new URLSearchParams(location.search).get('node');
  const value = query ?? document.querySelector('meta[name="node-id"]')?.content;
  return valid(value) ? value : '';
}
export const nodeHeaders = () => nodeIdentity() ? { 'x-codex-node': nodeIdentity() } : {};
export function nodeURL(url) {
  const id = nodeIdentity(); if (id) url.searchParams.set('node', id); return url;
}
export function nodeLink(path) {
  const url = nodeURL(new URL(path, location.origin));
  if (url.origin !== location.origin) throw Error('下载目标不属于当前入口');
  return url.pathname + url.search + url.hash;
}
