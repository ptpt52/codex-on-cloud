import { readConfig } from './config.mjs';
import { createPanel } from './server.mjs';

try {
  const config = readConfig();
  const panel = await createPanel(config);
  panel.server.listen(config.port, config.host, () => console.log(`Codex on Cloud 已启动，监听 ${config.host}:${config.port}`));
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await panel.close();
  });
} catch (error) {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
}
