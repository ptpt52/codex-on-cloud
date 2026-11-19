import { randomBytes } from 'node:crypto';
import { FILE_PAGE_LIMITS, validFilePage } from './public/file-list.js';

export const FILE_CATALOG_LIMITS = Object.freeze({ snapshots: 4, perOwner: 2, bytes: 4 * 1024 * 1024, snapshotBytes: 2 * 1024 * 1024, pending: 2, ageMs: 30000 });
const fault = (status, message) => Object.assign(Error(message), { status, outcome: 'rejected' });

// Ephemeral metadata only. A bounded snapshot keeps pages consistent without
// rescanning the directory per RPC; upload/delete preflights never use it.
export function createFileCatalog(now = Date.now) {
  const snapshots = new Map(), pending = new Set(); let bytes = 0, ended = false;
  function drop(id) { const entry = snapshots.get(id); if (entry) { snapshots.delete(id); bytes -= entry.bytes; } }
  function prune() { for (const [id, entry] of snapshots) if (now() >= entry.expiresAt) drop(id); }
  function response(id, entry, offset) {
    if (offset >= entry.files.length && offset !== 0) throw fault(400, '文件列表分页无效');
    const files = []; let size = 0;
    for (const file of entry.files.slice(offset, offset + entry.pageItems)) {
      const length = Buffer.byteLength(JSON.stringify(file));
      if (size + length > FILE_PAGE_LIMITS.pageBytes - 4096) break;
      files.push(file); size += length + 1;
    }
    if (!files.length && entry.files.length) throw fault(502, '单份文件元数据超过分页限制');
    const end = offset + files.length;
    return { ...entry.metadata, filePageProtocol: 1, snapshot: id, offset, total: entry.files.length, next: end < entry.files.length ? id + '.' + end : null, files };
  }
  return {
    async read(owner, page, load, signal, pageItems = FILE_PAGE_LIMITS.legacyPageItems) {
      if (ended) throw fault(503, '文件列表服务正在关闭');
      if (!validFilePage(page)) throw fault(400, '文件列表分页无效');
      if (![FILE_PAGE_LIMITS.legacyPageItems, FILE_PAGE_LIMITS.pageItems].includes(pageItems)) throw fault(400, '文件列表分页能力无效');
      signal?.throwIfAborted(); prune();
      if (page !== '1') {
        const [id, offset] = page.split('.'), entry = snapshots.get(id);
        if (!entry || entry.owner !== owner) throw fault(410, '文件列表快照已过期，请手动刷新');
        return response(id, entry, Number(offset));
      }
      if (pending.size >= FILE_CATALOG_LIMITS.pending) throw fault(429, '文件列表读取繁忙，请稍后手动刷新');
      const controller = new AbortController(); pending.add(controller);
      try {
        const scope = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const listing = await load(scope); scope.throwIfAborted();
        if (!Array.isArray(listing?.files) || listing.files.length > FILE_PAGE_LIMITS.items) throw fault(502, '文件列表响应无效');
        const serialized = JSON.stringify(listing.files), length = Buffer.byteLength(serialized);
        if (length > FILE_CATALOG_LIMITS.snapshotBytes) throw fault(502, '文件列表元数据超过 2 MiB');
        const metadata = {};
        for (const key of ['uploadProtocol', 'deleteProtocol', 'quotaProtocol', 'fileProgressProtocol', 'truncated']) {
          const value = listing[key];
          if (value !== undefined) {
            if (!(typeof value === 'boolean' || Number.isSafeInteger(value))) throw fault(502, '文件列表协议无效');
            metadata[key] = value;
          }
        }
        const id = randomBytes(16).toString('hex'), entry = { owner, metadata, files: JSON.parse(serialized), bytes: length, pageItems, expiresAt: now() + FILE_CATALOG_LIMITS.ageMs };
        // Validate the first page before evicting any other catalog.
        const first = response(id, entry, 0);
        prune();
        for (const [id, entry] of snapshots) if (entry.owner === owner && [...snapshots.values()].filter(value => value.owner === owner).length >= FILE_CATALOG_LIMITS.perOwner) drop(id);
        while (snapshots.size >= FILE_CATALOG_LIMITS.snapshots || bytes + length > FILE_CATALOG_LIMITS.bytes) drop(snapshots.keys().next().value);
        snapshots.set(id, entry); bytes += length; return first;
      } finally { pending.delete(controller); }
    },
    close() { ended = true; snapshots.clear(); bytes = 0; for (const controller of pending) controller.abort(); },
  };
}
