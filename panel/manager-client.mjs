import http from 'node:http';

export function managerRequest(config, path, body, timeout = 6000) {
  if (typeof config.managerSocket !== 'string' || Buffer.byteLength(config.managerSocket) > 100) return Promise.reject(Object.assign(new Error('桌面管理服务尚未配置'), { status: 503 }));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({ socketPath: config.managerSocket, path, method: payload === null ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${config.agentSecret}`, ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
      signal: AbortSignal.timeout(timeout) }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 16 * 1024) response.destroy(new Error('管理响应过大')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode >= 400) { const error = new Error(data.error || '桌面管理操作失败'); error.status = response.statusCode; error.outcome = data.outcome; reject(error); }
          else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    request.once('error', () => reject(Object.assign(new Error('桌面管理服务未就绪，请检查本机管理服务'), { status: 503 })));
    request.end(payload);
  });
}
