import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maintenanceEnvironment, maintenanceSettings } from '../native/config.mjs';

test('maintenance commands use persisted deployment values instead of an older task environment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-maintenance-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.env'), [
    'DEPLOY_MODE=terminal',
    'PANEL_PORT=36082',
    'AGENT_PORT=36902',
    'FILE_AGENT_PORT=36904',
    'MAX_TERMINALS=8',
    'PUBLIC_ORIGIN=https://persisted.example.test',
    'WEBRTC_ENABLED=0',
    '',
  ].join('\n'));
  const inherited = {
    PATH: '/usr/bin:/bin', KEEP_ME: 'yes', DEPLOY_MODE: 'desktop', PANEL_PORT: '1', PORT: '2',
    AGENT_PORT: '3', FILE_AGENT_PORT: '4', MAX_TERMINALS: '1', PUBLIC_ORIGIN: 'https://stale.example.test',
    WEBRTC_ENABLED: '1',
  };
  const env = maintenanceEnvironment(inherited, directory);
  assert.equal(env.DEPLOY_MODE, 'terminal');
  assert.equal(env.PANEL_PORT, '36082');
  assert.equal(env.FILE_AGENT_PORT, '36904');
  assert.equal(env.PUBLIC_ORIGIN, 'https://persisted.example.test');
  assert.equal(env.PORT, undefined);
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(env.KEEP_ME, 'yes');

  const config = maintenanceSettings(inherited, directory);
  assert.equal(config.mode, 'terminal');
  assert.equal(config.panelPort, 36082);
  assert.equal(config.fileAgentPort, 36904);
  assert.equal(config.maxTerminals, 8);
  assert.equal(config.env.WEBRTC_ENABLED, '0');
});

test('environment-only maintenance tests still work when no persisted .env exists', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-maintenance-no-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = maintenanceEnvironment({ DEPLOY_MODE: 'terminal', FILE_AGENT_PORT: '36905' }, directory);
  assert.equal(env.DEPLOY_MODE, 'terminal');
  assert.equal(env.FILE_AGENT_PORT, '36905');
});
