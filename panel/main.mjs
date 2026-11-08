import { readConfig } from './config.mjs';
import { createPanel } from './server.mjs';
import { join } from 'node:path';
import { serveUIReload } from '../native/ui-reload.mjs';

try {
  const config = readConfig();
  const panel = await createPanel(config);
  let stopReload;
  try {
    stopReload = await serveUIReload(join(config.dataDir, 'ui-reload.sock'), panel.reloadUI);
    await new Promise((resolve, reject) => { panel.server.once('error', reject); panel.server.listen(config.port, config.host, resolve); });
    await panel.startTunnel(config.tunnelSocket);
  } catch (error) { await stopReload?.(); await panel.close(); throw error; }
  console.log(`Codex on Cloud 已启动，监听 ${config.host}:${config.port}`);
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await stopReload();
    await panel.close();
  });
} catch (error) {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
}
