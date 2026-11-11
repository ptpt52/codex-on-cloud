import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const HELP_PAGE_LIMIT = 512 * 1024;
export const HELP_PAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// One administrator-provided document, read once at startup; no directory serving.
export async function readHelpPage(file, { optional = false } = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > HELP_PAGE_LIMIT || info.mode & 0o022) throw Error('帮助页必须是非空普通文件、不可由组或其他用户写入，且不超过 512 KiB');
    const buffer = Buffer.alloc(HELP_PAGE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== info.size || size > HELP_PAGE_LIMIT) throw Error('帮助页正在修改或超过 512 KiB');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
