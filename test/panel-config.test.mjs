import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../panel/config.mjs';
import { settings } from '../native/config.mjs';

test('real panel configuration exposes each private runtime endpoint without requiring deployment credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coc-panel-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['desktop', 'terminal']) {
    const config = readConfig({ DEPLOY_MODE: mode, RUNTIME_DIR: root, PUBLIC_ORIGIN: 'https://desk.example.test', WEBRTC_ENABLED: '0', WEBRTC_IPV6: '0' },
      { readSecret: () => 'isolated_config_test_secret', nativeSettings: env => ({ ...settings(env), root }) });
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.managerSocket, root + '/manager.sock');
    assert.equal(config.desktopActionsSocket, root + '/actions.sock');
    assert.equal(config.vncSocket, root + '/vnc.sock');
    assert.equal(config.tunnelSocket, root + '/tunnel.sock');
  }
});
