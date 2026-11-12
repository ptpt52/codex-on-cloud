import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseForwardPrompt, FORWARD_PROMPT_LIMIT } from '../panel/public/forward-prompt.js';

const agent = { name: '助手3', online: true, secret: 'synthetic-helper-secret', key: 'synthetic-key-must-not-copy', inventory: { interfaces: ['not part of the prompt'] } };
const rule = (config = {}, other = {}) => ({ id: 'a'.repeat(32), name: '办公室设备', enabled: true, state: 'active', config: {
  direction: 'reverse', protocol: 'tcp', localPort: 22001, targetHost: '127.0.0.1', targetPort: 8080, ...config,
}, mapping: { code: 'synthetic-mapping-code', resumeToken: 'synthetic-resume-token' }, ...other });

test('AI prompts identify node-to-helper topology, loopback ownership and scoped node without copying authorization', () => {
  const text = reverseForwardPrompt(rule({ protocol: 'ssh', targetPort: 22 }), agent, {
    nodeURL: 'https://synthetic-user:synthetic-password@example.test/node/office/?token=synthetic-token#synthetic-hash', nodeId: 'b'.repeat(32),
  });
  assert.match(text, /节点主机访问助手侧/); assert.match(text, /助手3/);
  assert.match(text, /TCP 127\.0\.0\.1:22001 → 端口映射链路 → 助手电脑.*目标 127\.0\.0\.1:22/);
  assert.match(text, /指助手电脑自身，不是节点主机/); assert.match(text, /工作台入口：https:\/\/example.test\/node\/office\//);
  assert.ok(text.includes('节点标识：' + 'b'.repeat(32))); assert.ok(text.includes('HostKeyAlias=codex-cloud-' + 'a'.repeat(32)));
  assert.match(text, /-p 22001 USER@127\.0\.0\.1/); assert.match(text, /不要关闭主机指纹检查/);
  for (const secret of ['synthetic-user', 'synthetic-password', 'synthetic-token', 'synthetic-hash', agent.secret, agent.key, 'not part of the prompt', 'synthetic-mapping-code', 'synthetic-resume-token']) assert.ok(!text.includes(secret), secret);
  assert.equal(reverseForwardPrompt(rule({ direction: 'forward' }), agent), '');
});

test('HTTPS examples preserve service identity while reaching the mapped local port; IPv6 targets stay on the helper side', () => {
  const text = reverseForwardPrompt(rule({ targetHost: '2001:db8::8', targetPort: 443 }), agent);
  assert.match(text, /目标 \[2001:db8::8\]:443/);
  assert.ok(text.includes("curl --connect-to 'SERVICE_HOST:443:127.0.0.1:22001' 'https://SERVICE_HOST/'"));
  assert.match(text, /保留 SNI、Host 和证书校验/); assert.match(text, /不终止 TLS/);
  assert.ok(!text.includes('curl https://127.0.0.1')); assert.ok(!text.includes(' -k'));
  assert.match(reverseForwardPrompt(rule({ targetPort: 80 }), agent), /curl http:\/\/127\.0\.0\.1:22001\//);
  assert.match(reverseForwardPrompt(rule({ protocol: 'telnet', targetPort: 23 }), agent), /telnet 127\.0\.0\.1 22001/);
});

test('serial prompts describe raw bytes, parameters and physical device on the helper instead of a node file or SSH server', () => {
  const text = reverseForwardPrompt(rule({ protocol: 'serial', targetHost: undefined, targetPort: undefined,
    serial: { path: '/dev/cu.usbserial-01', baud: 9600, dataBits: 7, parity: 'even', stopBits: 2, dtr: true, rts: false },
  }), agent);
  assert.match(text, /助手电脑.*串口 "\/dev\/cu.usbserial-01"/);
  assert.match(text, /波特率 9600，数据位 7，校验 偶，停止位 2，DTR 高，RTS 低/);
  assert.match(text, /不是 SSH \/ Telnet，也不是节点主机上的设备文件/);
  assert.match(text, /nc 127\.0\.0\.1 22001/); assert.ok(!text.includes('undefined'));
});

test('offline, stale, disabled and error snapshots never claim an active mapping and generated text has a fixed bound', () => {
  assert.match(reverseForwardPrompt(rule(), { ...agent, online: false }), /助手离线；等待助手上线/);
  assert.match(reverseForwardPrompt(rule(), agent, { statusKnown: false }), /助手状态未确认；映射状态未确认/);
  assert.match(reverseForwardPrompt(rule({}, { enabled: false }), agent), /规则已停用/);
  assert.match(reverseForwardPrompt(rule({}, { error: 'do not copy this diagnostic' }), agent), /映射需要检查/);
  const text = reverseForwardPrompt(rule({}, { name: 'x'.repeat(FORWARD_PROMPT_LIMIT * 2) }), agent);
  assert.ok(text.length <= FORWARD_PROMPT_LIMIT);
});
