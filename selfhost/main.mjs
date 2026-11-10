import { join } from 'node:path';
import { readStateFile } from '../scripts/state-files.mjs';
import { createSelfhostCenter } from './center.mjs';

function required(name) {
  const value = process.env[name];
  if (!value) throw Error('缺少中心环境变量 ' + name);
  return value;
}

try {
  const stateDirectory = required('SELFHOST_STATE_DIR'), origin = required('SELFHOST_ORIGIN');
  const secretDirectory = process.env.SELFHOST_SECRET_DIR || '/etc/codex-selfhost';
  const password = (await readStateFile(join(secretDirectory, 'admin_password'), 512, true)).trim();
  const frpToken = (await readStateFile(join(secretDirectory, 'frp_token'), 512, true)).trim();
  const frpsAdminPassword = (await readStateFile(join(secretDirectory, 'frps_admin_password'), 512, true)).trim();
  const turnSecret = (await readStateFile(process.env.SELFHOST_TURN_SECRET_FILE || join(secretDirectory, 'turn_secret'), 512, true)).trim();
  const center = await createSelfhostCenter({
    origin,
    host: '127.0.0.1',
    port: Number(required('SELFHOST_CENTER_PORT')),
    dataDir: join(stateDirectory, 'center'),
    stateFile: join(stateDirectory, 'state.json'),
    password,
    publicHost: required('SELFHOST_PUBLIC_HOST'),
    frpServerPort: Number(required('SELFHOST_FRP_SERVER_PORT')),
    frpTlsServerName: required('SELFHOST_FRP_TLS_NAME'),
    frpToken,
    turnSecret,
    turnRelay: { addresses: [required('SELFHOST_TURN_RELAY_IPV4')], minPort: 49160, maxPort: 49223 },
    turnRealm: process.env.SELFHOST_TURN_REALM || required('SELFHOST_PUBLIC_HOST'),
    frpsAdmin: { endpoint: process.env.SELFHOST_FRPS_ADMIN_URL || 'http://127.0.0.1:17500', username: 'admin', password: frpsAdminPassword },
  });
  await new Promise((resolve, reject) => { center.server.once('error', reject); center.server.listen(Number(required('SELFHOST_CENTER_PORT')), '127.0.0.1', resolve); });
  console.log(`Codex self-host center listening on 127.0.0.1:${process.env.SELFHOST_CENTER_PORT}`);
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await center.close();
  });
} catch (error) {
  console.error('中心启动失败：' + error.message);
  if (process.env.SELFHOST_DEBUG === '1' && error.stack) console.error(error.stack);
  process.exitCode = 1;
}
