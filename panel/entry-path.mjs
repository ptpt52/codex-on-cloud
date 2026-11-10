const ENTRY_PATH = /^\/node\/[a-z0-9-]{1,48}\/$/;

export function normalizeEntryBasePath(value) {
  if (value === undefined || value === null || value === '') return '/';
  if (value === '/') return '/';
  if (typeof value !== 'string' || value.length > 64 || !ENTRY_PATH.test(value)) {
    throw Error('ENTRY_BASE_PATH 必须为空或规范的 /node/<slug>/ 路径');
  }
  return value;
}

export function stripEntryPath(pathname, basePath = '/') {
  if (basePath === '/') return pathname;
  if (!pathname.startsWith(basePath)) return null;
  return '/' + pathname.slice(basePath.length);
}
