import { X509Certificate, createPrivateKey } from 'node:crypto';
import https from 'node:https';

// Trust is explicit for imported private certificates as well as public CAs.
// Validate the entire supplied chain before replacing any installed files.
export function validateServerCertificate(certificate, { domain, privateKey, now = Date.now() } = {}) {
  const text = Buffer.isBuffer(certificate) ? certificate.toString('utf8') : certificate;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw Error('证书文件大小无效');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw Error('证书必须是 PEM 格式');
  const chain = blocks.map(block => new X509Certificate(block)), leaf = chain[0];
  if (!leaf.checkHost(domain)) throw Error('导入证书不匹配中心域名 ' + domain);
  for (const certificate of chain) {
    const from = Date.parse(certificate.validFrom), until = Date.parse(certificate.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from > now) throw Error('证书尚未生效或有效期无效');
    if (until <= now) throw Error('证书已过期，请先续期后再安装');
  }
  if (privateKey !== undefined) {
    if (Buffer.byteLength(privateKey) > 256 * 1024 || !leaf.checkPrivateKey(createPrivateKey(privateKey))) throw Error('导入证书与私钥不匹配');
  }
  return leaf;
}

export function probeLocalHttps(domain, { certificate, port = 443, timeout = 3000 } = {}) {
  const expected = validateServerCertificate(certificate, { domain });
  return new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port, servername: domain, path: '/healthz', method: 'GET', headers: { host: domain },
      ca: certificate, allowPartialTrustChain: true, rejectUnauthorized: true, agent: false, timeout, signal: AbortSignal.timeout(timeout) }, response => {
      response.on('error', reject);
      // Also require the newly installed leaf, rather than an older valid
      // certificate under the same CA served by a service that failed to restart.
      if (!response.socket.getPeerCertificate().raw?.equals(expected.raw)) { response.destroy(Error('HTTPS 服务未使用已安装的证书')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 16384) response.destroy(Error('HTTPS 健康响应超过 16 KiB')); else chunks.push(chunk); });
      response.on('end', () => { try { resolve(response.statusCode === 200 && JSON.parse(Buffer.concat(chunks)).ok === true); } catch { resolve(false); } });
    });
    request.on('timeout', () => request.destroy(Error('HTTPS 健康检查超时'))); request.on('error', reject); request.end();
  });
}
