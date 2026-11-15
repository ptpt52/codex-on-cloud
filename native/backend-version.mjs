import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BACKEND_VERSION_LIMITS = Object.freeze({ files: 256, file: 1024 * 1024, total: 8 * 1024 * 1024 });
// Parse imports without evaluating any source. The experimental VM flag is
// confined to this bounded parser child, never added to application processes.
const PARSER = `import {SourceTextModule} from 'node:vm';import {posix} from 'node:path';
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>32*1024*1024)throw Error('input');}
const {sources,entries}=JSON.parse(input), result={};
function visit(path){if(Object.hasOwn(result,path))return;const source=sources[path];if(typeof source!=='string')throw Error('dependency');
result[path]=[...new SourceTextModule(source).dependencySpecifiers,...[...source.matchAll(/\\bimport\\s*\\(\\s*['"](\\.[^'"]+)['"]/g)].map(value=>value[1])];
for(const specifier of result[path])if(specifier.startsWith('.'))visit(posix.normalize(posix.join(posix.dirname(path),specifier)));}
for(const path of entries)visit(path);
process.stdout.write(JSON.stringify(result));`;
function imports(sources, entries) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', PARSER], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 128 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.stdin.on('error', () => {}); child.once('error', () => { clearTimeout(timer); reject(Error('后台版本依赖分析不可用')); });
    child.once('close', code => {
      clearTimeout(timer);
      try { if (code !== 0 || size > 128 * 1024) throw Error(); resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(Error('后台版本依赖分析失败或超过限制')); }
    });
    child.stdin.end(JSON.stringify({ sources: Object.fromEntries([...sources].map(([path, data]) => [path, data.toString('utf8')])), entries }));
  });
}
async function bytes(root, path) {
  const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > BACKEND_VERSION_LIMITS.file) throw Error('后台源码文件无效或超过大小限制');
    const buffer = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < buffer.length) { const part = await file.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size !== stat.size) throw Error('后台源码在读取期间变化');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}
const ENTRIES = Object.freeze({ panel: 'panel/main.mjs', manager: 'native/manager.mjs', actions: 'native/desktop-worker.mjs', center: 'selfhost/main.mjs' });
export async function readBackendRevisions(root = ROOT, components = [...Object.keys(ENTRIES), 'files']) {
  if (!Array.isArray(components) || !components.length || components.length > 5 || components.some(name => name !== 'files' && !Object.hasOwn(ENTRIES, name))) throw Error('后台组件无效');
  const paths = ['package.json', 'package-lock.json'];
  for (const directory of ['panel', 'native', 'selfhost', 'gateway', 'panel/public', 'scripts']) {
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (entries.length > BACKEND_VERSION_LIMITS.files) throw Error('后台源码目录超过核算范围');
    for (const entry of entries) if (/\.(mjs|js)$/.test(entry.name)) paths.push(directory + '/' + entry.name);
  }
  paths.sort(); if (paths.length > BACKEND_VERSION_LIMITS.files) throw Error('后台源码数量超过限制');
  const sources = new Map(); let total = 0;
  for (const path of paths) {
    const content = await bytes(root, path); total += content.length;
    if (total > BACKEND_VERSION_LIMITS.total) throw Error('后台源码总量超过限制');
    sources.set(path, content);
  }
  const graph = await imports(sources, components.filter(name => name !== 'files').map(name => ENTRIES[name])), revisions = {};
  for (const component of components.filter(name => name !== 'files')) {
    const entry = ENTRIES[component];
    const selected = new Set(['package.json', 'package-lock.json']);
    function visit(path) {
      if (selected.has(path)) return;
      if (!Object.hasOwn(graph, path)) throw Error('后台依赖不在版本核算范围');
      selected.add(path);
      for (const specifier of graph[path]) if (specifier.startsWith('.')) visit(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
    visit(entry);
    const hash = createHash('sha256').update('codex-backend-v1:' + component + '\0');
    for (const path of [...selected].sort()) { const content = sources.get(path); hash.update(path + '\0' + content.length + '\0').update(content); }
    revisions[component] = hash.digest('hex');
  }
  for (const [path, content] of sources) if (!(await bytes(root, path)).equals(content)) throw Error('后台源码正在更新，请完成更新后重启服务');
  if (components.includes('files')) revisions.files = createHash('sha256').update(await bytes(root, 'desktop/agent.py')).digest('hex');
  return revisions;
}

// Captured when this module is first loaded, never recomputed by a request or
// UI reload. Native processes remain independent and each reports its own copy.
const startedAt = Date.now(), startup = new Map();
export async function loadedBackendVersion(component) {
  if (!['panel', 'manager', 'actions', 'center'].includes(component)) throw Error('后台组件无效');
  if (!startup.has(component)) startup.set(component, readBackendRevisions(ROOT, [component]));
  return Object.freeze({ protocol: 1, component, revision: (await startup.get(component))[component], startedAt, pid: process.pid });
}
