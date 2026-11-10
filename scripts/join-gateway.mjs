import { parseArgs } from 'node:util';
import { root, maintenanceSettings } from '../native/config.mjs';
import { createGatewayJoin } from './gateway-node.mjs';

try {
  const { values } = parseArgs({ options: { gateway: { type: 'string' }, backend: { type: 'string' }, name: { type: 'string' }, 'code-file': { type: 'string' }, 'prepare-only': { type: 'boolean' }, abort: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log('用法：npm run gateway:join -- --gateway https://desk.example.com --backend https://node-a.example.com --name 名称\n接入码默认从私有 secrets/gateway_code 读取，可用 --code-file 覆盖。\n--prepare-only 只准备本机配置；随后重跑相同命令完成。\n--abort 条件恢复待接入前的本机配置；已登记节点需先在网页移除。\n会按需要重启面板，不重启桌面、任务管理器或 Tunnel；不使用 CF 管理 API Token。');
  else {
    if (values.abort && values['prepare-only']) throw Error('不能同时准备和撤销');
    if (process.platform !== 'linux' || process.getuid() === 0) throw Error('请由 Linux 部署用户运行');
    const native = maintenanceSettings();
    const joiner = createGatewayJoin({ root, socketPath: native.tunnelSocket, reload: async lease => {
      const result = await lease.runTerminal('systemctl', ['--user', 'restart', 'codex-cloud-panel.service'], { cwd: root, timeout: 60000 });
      if (result.status !== 0) throw Error('面板加载失败，未登记节点；原任务保留');
    } });
    const result = await joiner.join({ ...values, codeFile: values['code-file'], prepareOnly: values['prepare-only'] }); console.log(JSON.stringify(result));
    console.log(result.aborted ? '本机准备已条件恢复，原任务保留；未修改网关路由或 DNS。' : result.prepared ? '本机配置已准备。完成 Tunnel 后端域名配置后，重跑此命令登记。' : '节点已登记；从固定域名的 /__nodes/ 页面选择节点。没有修改 DNS 或切换默认入口。');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
