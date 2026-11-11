// Bound retained bytes while reading, including decoded/chunked responses whose
// actual size differs from Content-Length. Oversize bodies are cancelled early.
export async function readResponseBytes(response, maximum, message = '响应超过大小上限') {
  const reader = response.body?.getReader();
  if (!reader) throw Error('响应缺少数据流');
  const chunks = []; let size = 0, block, used = 0;
  try {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) throw Error(message);
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (size + value.byteLength > maximum) throw Error(message);
      // Coalesce tiny network chunks so array entries are bounded as well.
      for (let offset = 0; offset < value.byteLength;) {
        block ||= Buffer.allocUnsafe(Math.min(65536, maximum - size));
        const count = Math.min(block.length - used, value.byteLength - offset);
        block.set(value.subarray(offset, offset + count), used);
        offset += count; used += count; size += count;
        if (used === block.length) { chunks.push(block); block = undefined; used = 0; }
      }
    }
    if (used) chunks.push(block.subarray(0, used));
    return Buffer.concat(chunks, size);
  } finally {
    // Cancellation of a faulty producer must not delay rejection indefinitely.
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
