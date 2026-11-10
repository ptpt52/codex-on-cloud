import http from 'node:http';
import https from 'node:https';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

export const CA_LIMIT = 256 * 1024;
export function readCenterCA(file, { privateFile = false } = {}) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > CA_LIMIT || stat.mode & (privateFile ? 0o077 : 0o022)) throw Error('CA 文件权限或大小无效');
    const bytes = Buffer.alloc(CA_LIMIT + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size || count > CA_LIMIT) throw Error('CA 文件超过限制或正在修改');
    const text = bytes.subarray(0, count).toString('utf8');
    const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length) throw Error('CA 文件必须是 PEM 证书');
    for (const certificate of certificates) new X509Certificate(certificate);
    return text;
  } finally { closeSync(fd); }
}

// A per-center request, with normal chain, expiry and URL hostname verification.
// Never installs a global agent or trusts redirects with node credentials.
export function centerRequest(target, { ca, timeout = 10000, ...options } = {}) {
  const url = new URL(target);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('中心地址必须使用 HTTPS');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, { agent: false, ...options, ca, rejectUnauthorized: true, timeout, signal: options.signal }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 16384) response.destroy(Error('中心响应超过 16 KiB')); else chunks.push(chunk); });
      response.on('end', () => {
        try { resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(Error('中心请求超时')));
    request.on('error', reject); request.end(options.body);
  });
}

export function centerClient(center, ca, request = centerRequest) {
  const expected = new URL(center).origin;
  return (target, options = {}) => {
    if (new URL(target).origin !== expected) throw Error('CA 信任与中心地址不匹配');
    return request(target, { ...options, ca });
  };
}
