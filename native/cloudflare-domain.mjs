// Only the deployment recorded in this project may be renamed, in the same zone.
export function cloudflareDomainPlan(state, { domain, accountId, zoneId, rename = false }) {
  if (!state) return null;
  if (state.accountId !== accountId || state.zoneId !== zoneId) throw Error('已有另一账户或区域的部署状态，不会覆盖');
  if (state.hostname === domain) return { ...state };
  if (!rename) throw Error('已有另一域名的部署状态；修改本项目域名需显式指定 --rename');
  if (state.previousHostname) throw Error('上次域名修改尚未完成，请先用原目标域名继续执行');
  return { ...state, hostname: domain, previousHostname: state.hostname, previousDnsRecordId: state.dnsRecordId || null };
}
export function assertManagedIngress(state, configuration) {
  const allowed = new Set([state.hostname, state.previousHostname].filter(Boolean));
  if (configuration?.config?.ingress?.some(rule => rule.hostname && !allowed.has(rule.hostname))) throw Error('此 Tunnel 已有其他域名路由，不会覆盖');
}
export function renamedDNSRecord(state, records) {
  return records.find(record => record.id === state.previousDnsRecordId && record.name === state.previousHostname && record.type === 'CNAME' && record.content === `${state.tunnelId}.cfargotunnel.com`) || null;
}
