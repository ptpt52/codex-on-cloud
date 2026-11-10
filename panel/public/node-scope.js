// Pin this page to its node. An old frame keeps its parent's intended identity.
import { entryPath, entryURL } from './entry-path.js';

const valid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function nodeIdentity() {
  const query = new URLSearchParams(location.search).get('node');
  const value = query ?? document.querySelector('meta[name="node-id"]')?.content;
  return valid(value) ? value : '';
}
export const nodeHeaders = () => nodeIdentity() ? { 'x-codex-node': nodeIdentity() } : {};
export function nodeURL(url) {
  const next = entryURL(url.pathname + url.search + url.hash);
  next.protocol = url.protocol;
  const id = nodeIdentity(); if (id) next.searchParams.set('node', id); return next;
}
export function nodeLink(path) {
  const url = entryURL(path);
  if (url.origin !== location.origin) throw Error('下载目标不属于当前入口');
  return url.pathname + url.search + url.hash;
}
