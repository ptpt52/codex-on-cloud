import { fileURLToPath } from 'node:url';
import { requestUIReload } from '../native/ui-reload.mjs';
if (process.argv.length > 2) { console.error('用法：npm run reload-ui；由部署用户在项目目录执行'); process.exitCode = 1; }
else {
  try {
    const result = await requestUIReload(fileURLToPath(new URL('../data/panel/ui-reload.sock', import.meta.url)));
    console.log(result.changed ? `界面已更新至 ${result.revision}，现有桌面和映射保持连接；浏览器保存草稿后手动刷新。` : `界面资源没有变化（${result.revision}）。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
