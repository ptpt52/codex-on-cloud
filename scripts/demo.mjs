import { fixture } from '../test/fixture.mjs';

const app = await fixture({ port: Number(process.env.DEMO_PORT || 36081), password: 'demo_password_for_tests' });
console.log(`测试演示：${app.config.origin}\n用户名：admin\n测试密码：demo_password_for_tests\n这是模拟桌面，不连接 Codex，不执行任务。`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (!stopping) { stopping = true; await app.close(); } });
