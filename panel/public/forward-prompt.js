export const FORWARD_PROMPT_LIMIT = 8192;
const address = (host, port) => `${host.includes(':') ? '[' + host + ']' : host}:${port}`;
const states = { active: '映射已生效', pending: '等待规则通道', connecting: '正在建立映射', recovering: '规则通道恢复中', disabled: '规则已停用', failed: '映射未生效', offline: '等待助手上线', starting: '正在下发' };

// Only selected rule data enters the prompt. Never serialize the agent, grant,
// inventory or mapping object: those can contain authorization material.
export function reverseForwardPrompt(rule, agent, { statusKnown = true, nodeURL = '', nodeId = '' } = {}) {
  const c = rule.config;
  if (c.direction !== 'reverse') return '';
  const helper = JSON.stringify(agent.name), local = '127.0.0.1:' + c.localPort;
  const lines = ['请根据以下端口映射拓扑协助我操作目标。先确认你的命令运行在哪台机器，具体任务不明确时先询问我。',
    '', '机器身份与方向：', '节点主机：运行本工作台、网页终端 / AI 的服务器。',
    '助手电脑：' + helper + '，运行端口映射助手；目标地址由这台电脑访问，不要默认它与节点主机是同一台机器。',
    '浏览器所在电脑不一定是节点主机，也不一定是助手电脑。'];
  try { const url = new URL(nodeURL); if (['https:', 'http:'].includes(url.protocol)) lines.push('工作台入口：' + url.origin + url.pathname); } catch {}
  if (/^[a-f0-9]{32}$/.test(nodeId)) lines.push('节点标识：' + nodeId);
  lines.push('规则名称（仅作标识）：' + JSON.stringify(rule.name),
    '', '访问方向：节点主机访问助手侧。方向表示从哪端发起连接，建立后是双向 TCP 字节流。',
    '节点主机的监听地址：' + local + '（仅绑定节点主机的回环接口）。');
  if (c.serial) {
    const s = c.serial, parity = { none: '无', odd: '奇', even: '偶' }[s.parity] || s.parity;
    lines.push('目标：助手电脑 ' + helper + ' 的串口 ' + JSON.stringify(s.path) + '。',
      `拓扑：AI / 客户端（节点主机） → TCP ${local} → 端口映射链路 → 助手电脑 ${helper} → 串口 ${JSON.stringify(s.path)}`,
      `串口参数：波特率 ${s.baud}，数据位 ${s.dataBits}，校验 ${parity}，停止位 ${s.stopBits}，DTR ${s.dtr ? '高' : '低'}，RTS ${s.rts ? '高' : '低'}；无硬件流控。`,
      '串口由助手在客户端接入后打开，只允许一个客户端；这是原始串口字节流，不是 SSH / Telnet，也不是节点主机上的设备文件。',
      '连接示例（在节点主机执行，先确认要使用的串口业务协议）：nc 127.0.0.1 ' + c.localPort);
  } else {
    const target = address(c.targetHost, c.targetPort);
    lines.push('目标：从助手电脑访问 ' + target + '。',
      `拓扑：AI / 客户端（节点主机） → TCP ${local} → 端口映射链路 → 助手电脑 ${helper} → 目标 ${target}`,
      '目标 IP 属于助手侧网络；目标为 127.0.0.1 或 ::1 时，指助手电脑自身，不是节点主机。');
    if (c.protocol === 'ssh') lines.push('目标协议：SSH。请先确认 SSH 用户名，并校验目标设备的主机指纹；不要关闭主机指纹检查。',
      '连接示例（在节点主机执行，先将 USER 替换为目标设备用户名）：ssh -o HostKeyAlias=codex-cloud-' + rule.id + ' -p ' + c.localPort + ' USER@127.0.0.1');
    else if (c.protocol === 'telnet') lines.push('目标协议：Telnet。连接示例（在节点主机执行）：telnet 127.0.0.1 ' + c.localPort);
    else if (c.targetPort === 443) lines.push('常见用途为 HTTPS，请先确认目标服务的实际协议和证书域名。映射仅透传 TCP，不终止 TLS。',
      '若为 HTTPS，将 SERVICE_HOST 替换为证书域名，保留 SNI、Host 和证书校验；在节点主机执行：',
      `curl --connect-to 'SERVICE_HOST:443:127.0.0.1:${c.localPort}' 'https://SERVICE_HOST/'`);
    else if (c.targetPort === 80) lines.push('常见用途为 Web / HTTP，请先确认目标服务的实际协议。若为 HTTP，在节点主机执行：curl http://' + local + '/');
    else lines.push('目标为 TCP 服务；请先确认应用协议，再选择对应客户端，连接节点主机的 ' + local + '。');
  }
  lines.push('', '使用要点：',
    '如果 AI 不在节点主机上运行，先确认如何进入该节点；不要在其他机器上把自己的 127.0.0.1 当成上述入口。',
    '从节点主机连接映射的监听端口，不要把助手侧目标 IP 当成节点主机可直接访问的地址，也不要反向连接助手上的监听端口。',
    '链路可以直连或中转，均不改变上述端点与访问方向。',
    '复制时状态快照：规则' + (rule.enabled ? '已启用' : '已停用') + '；助手' + (!statusKnown ? '状态未确认' : agent.online ? '在线' : '离线') + '；' + (!rule.enabled ? '规则已停用' : !statusKnown ? '映射状态未确认' : !agent.online ? '等待助手上线' : rule.error || rule.mapping?.error ? '映射需要检查' : states[rule.state] || '映射状态未确认') + '。',
    '操作前确认规则启用、助手在线且映射已生效；监听就绪不代表目标服务已经连接验证。',
    '助手授权 key 和工作台登录密码不是目标服务的账号密码；需要目标凭据时另行询问。此文本不包含 key 或密码。');
  return lines.join('\n').slice(0, FORWARD_PROMPT_LIMIT);
}
