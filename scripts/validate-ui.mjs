// Launched with --experimental-vm-modules. Parse/link only: never evaluate
// browser code, globals, handlers, imports or user workspace files.
import { SourceTextModule, SyntheticModule } from 'node:vm';
let size = 0; const chunks = [];
for await (const chunk of process.stdin) { size += chunk.length; if (size > 24 * 1024 * 1024) throw Error('资源校验输入过大'); chunks.push(chunk); }
const sources = JSON.parse(Buffer.concat(chunks)), modules = new Map();
for (const [path, source] of Object.entries(sources)) modules.set(path, new SourceTextModule(source, { identifier: path }));
const novnc = new SyntheticModule(['default'], () => {});
const events = new SyntheticModule(['setCapture', 'releaseCapture', 'stopEvent'], () => {});
const linker = (name, importer) => {
  const url = new URL(name, 'http://ui.local' + importer.identifier);
  if (url.origin !== 'http://ui.local' || url.search || url.hash) throw Error('不支持的模块地址');
  if (url.pathname === '/desktop/novnc/core/util/events.js') return events;
  if (url.pathname === '/desktop/novnc/core/rfb.js') return novnc; // Installed dependency is pinned, never reloaded.
  const module = modules.get(url.pathname); if (!module) throw Error('模块不属于固定资源集');
  return module;
};
for (const module of modules.values()) if (module.status === 'unlinked') await module.link(linker);
