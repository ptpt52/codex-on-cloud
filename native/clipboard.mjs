import { spawn } from 'node:child_process';

export const MAX_CLIPBOARD_BYTES = 32 * 1024;
export class ClipboardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function clipboardSource(source) {
  if (!['clipboard', 'primary'].includes(source)) throw new ClipboardError(400, '读取来源无效');
  return source;
}
export function readClipboard(source, env, { timeout = 2000, spawnProcess = spawn } = {}) {
  source = clipboardSource(source);
  return new Promise((resolve, reject) => {
    const child = spawnProcess('xclip', ['-selection', source, '-out', '-target', 'UTF8_STRING'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, failure;
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new ClipboardError(504, '读取超时，请确认远程应用可用后手动重试')), timeout);
    child.once('error', () => { failure ||= new ClipboardError(503, '远程剪贴板暂不可用'); });
    child.stdout.on('error', () => stop(new ClipboardError(503, '远程剪贴板读取失败')));
    child.stdout.on('data', chunk => {
      if (failure) return;
      size += chunk.length;
      if (size > MAX_CLIPBOARD_BYTES) stop(new ClipboardError(413, '文字超过 32 KiB，请缩小远程选区后重新读取'));
      else chunks.push(chunk);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new ClipboardError(404, '没有可读取的文字，请先在远程桌面复制或选中文字'));
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
        if (text.includes('\0')) throw new Error('not plain text');
        resolve({ source, text, bytes: size });
      } catch { reject(new ClipboardError(422, '该内容不是有效的 UTF-8 文字，请在远程应用中复制纯文本')); }
    });
  });
}
