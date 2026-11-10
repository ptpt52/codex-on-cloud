import net from 'node:net';

const CIDR = value => {
  if (typeof value !== 'string') return false;
  const [address, prefix, extra] = value.split('/');
  const version = net.isIP(address);
  return extra === undefined && (version === 4 || version === 6) && /^\d{1,3}$/.test(prefix || '') && Number(prefix) >= 0 && Number(prefix) <= (version === 4 ? 32 : 128);
};

export function normalizeAdminCidrs(value) {
  if (value === undefined) return undefined;
  if (value === 'none') return [];
  const values = Array.isArray(value) ? value : String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (values.length > 16 || values.some(item => !CIDR(item))) throw Error('管理页访问 CIDR 无效');
  return [...new Set(values)];
}

export function caddyAdminCidrs(text) {
  if (typeof text !== 'string') return [];
  const match = text.match(/@outsideAdmin\s*\{[\s\S]*?\bnot\s+remote_ip\s+([^\r\n}]+)/);
  return match ? normalizeAdminCidrs(match[1].trim().split(/\s+/)).filter(value => !['127.0.0.1/32', '::1/128'].includes(value)) : [];
}

export function resolveAdminCidrs({ provided, settingsText, caddyText } = {}) {
  const explicit = normalizeAdminCidrs(provided);
  if (explicit !== undefined) return explicit;
  if (settingsText !== null && settingsText !== undefined) {
    let value; try { value = JSON.parse(settingsText); } catch { throw Error('中心安全设置格式无效'); }
    if (!value || value.version !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.adminCidrs)) throw Error('中心安全设置内容无效');
    return normalizeAdminCidrs(value.adminCidrs);
  }
  return caddyAdminCidrs(caddyText);
}

export const serverSettings = adminCidrs => JSON.stringify({ version: 1, adminCidrs }, null, 2) + '\n';
