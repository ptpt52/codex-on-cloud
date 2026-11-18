// Control requests have a separate budget from five-minute file streams and
// password verification. There is no waiting queue; each server owns its slots.
export const JSON_BODY_LIMITS = Object.freeze({ pending: 16, timeoutMs: 10000 });

const failure = (status, message) => Object.assign(Error(message), { status, outcome: 'rejected' });

// Flush a structured rejection before closing its unread body. Draining it
// would let a client retain a socket without any further application quota.
export function closeUnreadBody(req, res) {
  if (!req.readableEnded && !res.headersSent && !res.destroyed) {
    res.setHeader('connection', 'close'); res.shouldKeepAlive = false;
    res.once('finish', () => req.destroy());
  }
}

export function createJSONBodies({ pending = JSON_BODY_LIMITS.pending, timeoutMs = JSON_BODY_LIMITS.timeoutMs } = {}) {
  const active = new Set();
  let closed = false;
  function read(req, limit = 128 * 1024) {
    if (closed) return Promise.reject(failure(503, '服务正在关闭，请稍后重试'));
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return Promise.reject(failure(415, '请使用 JSON 请求'));
    if (Number(req.headers['content-length']) > limit) return Promise.reject(failure(413, '请求内容过大'));
    if (active.size >= pending) return Promise.reject(failure(429, '请求内容读取繁忙，请稍后重试'));
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0, done = false;
      function finish(error, body) {
        if (done) return;
        done = true; clearTimeout(timer); active.delete(cancel);
        req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted); req.off('close', aborted);
        if (error) { req.pause(); reject(error); } else resolve(body);
      }
      function data(chunk) {
        size += chunk.length;
        if (size > limit) return finish(failure(413, '请求内容过大'));
        chunks.push(chunk);
      }
      function end() {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
        } catch { return finish(failure(400, 'JSON 格式无效')); }
        finish(null, body);
      }
      function aborted() { finish(failure(400, '请求内容读取已中断')); }
      function cancel() { finish(failure(503, '服务正在关闭，请稍后重试')); }
      // An absolute deadline: trickling bytes cannot renew the reservation.
      const timer = setTimeout(() => finish(failure(408, '请求内容读取超时，请重试')), timeoutMs).unref();
      active.add(cancel);
      req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted); req.once('close', aborted);
      if (req.destroyed || req.readableEnded) aborted();
    });
  }
  return { read, close() { closed = true; for (const cancel of active) cancel(); } };
}
