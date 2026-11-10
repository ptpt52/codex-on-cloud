const configuredBase = document.querySelector('meta[name="entry-base-path"]')?.content;
export const entryBasePath = configuredBase === undefined || configuredBase === '' ? '/' : configuredBase;

export function entryPath(path, origin = location.origin) {
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/')) throw Error('入口路径无效');
  const pathname = entryBasePath === '/' || url.pathname === entryBasePath.slice(0, -1) || url.pathname.startsWith(entryBasePath)
    ? url.pathname
    : url.pathname === '/' ? entryBasePath : entryBasePath.slice(0, -1) + url.pathname;
  return pathname + url.search + url.hash;
}

export function entryURL(path) {
  return new URL(entryPath(path), location.origin);
}
