export const FORWARD_TYPES = Object.freeze({
  ssh: { name: 'SSH', port: 22 }, telnet: { name: 'Telnet', port: 23 },
  http: { name: 'Web', port: 80 }, https: { name: 'HTTPS', port: 443 },
  tcp: { name: 'TCP', port: null }, serial: { name: '串口', port: null },
});

export function forwardRuleType(config = {}) {
  if (Object.hasOwn(FORWARD_TYPES, config.protocol)) return config.protocol;
  return ({ 22: 'ssh', 23: 'telnet', 80: 'http', 443: 'https' })[config.targetPort] || 'tcp';
}

// Node listeners share one namespace. Helper listeners share only that helper's
// namespace. Reserve disabled/offline saved rules too, so re-enabling is safe.
export function forwardRuleDefaults(agents, agentId, direction, protocol, policy = {}) {
  const reverse = direction === 'reverse', used = new Set(reverse ? policy.reservedPorts || [] : []);
  for (const other of agents) for (const rule of other.rules) {
    if ((rule.config.direction === 'reverse') === reverse && (reverse || other.id === agentId)) used.add(rule.config.localPort);
  }
  for (const mapping of policy.mappings || []) {
    if ((mapping.direction === 'reverse') === reverse && (reverse || mapping.authorization?.helperId === agentId)) used.add(mapping.localPort);
  }
  const start = reverse ? 22001 : 2222, range = 65535 - 1024 + 1;
  let localPort = null;
  for (let offset = 0; offset < range; offset++) {
    const port = 1024 + (start - 1024 + offset) % range;
    if (!used.has(port)) { localPort = port; break; }
  }
  return { localPort, name: forwardRuleName(agents, agentId, protocol, localPort) };
}

export function forwardRuleName(agents, agentId, protocol, localPort) {
  const agent = agents.find(item => item.id === agentId);
  const title = `${agent?.name || '助手'} ${FORWARD_TYPES[protocol]?.name || 'TCP'} ${localPort ?? ''}`.trim();
  const names = new Set((agent?.rules || []).map(rule => rule.name));
  let name = '';
  for (let number = 1; number <= names.size + 1; number++) {
    const suffix = number === 1 ? '' : ` (${number})`;
    name = title.slice(0, 48 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
    if (!names.has(name)) break;
  }
  return name;
}
