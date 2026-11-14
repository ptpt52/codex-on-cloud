import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { copyApplicationFiles } from '../scripts/selfhost-server.mjs';

test('installed center boots with its packaged dependencies outside the repository', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-selfhost-application-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyApplicationFiles(directory);
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    import { createSelfhostCenter } from './selfhost/center.mjs';
    const center = await createSelfhostCenter({
      origin: 'https://desk.example.test', dataDir: './state',
      password: 'packaged_center_test_password', frpToken: 'packaged_frp_test_token_long',
      turnSecret: 'packaged_turn_test_secret_'.repeat(3),
    });
    try {
      center.server.listen(0, '127.0.0.1');
      await new Promise(resolve => center.server.once('listening', resolve));
      const ready = await new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: center.server.address().port,
          path: '/healthz', headers: { host: 'desk.example.test' } }, response => {
          let body = '';
          response.on('data', chunk => { body += chunk; });
          response.once('error', reject);
          response.once('end', () => resolve(response.statusCode === 200 && JSON.parse(body).ok));
        });
        request.once('error', reject);
      });
      if (!ready) throw Error('Packaged center is not ready');
      console.log('packaged center ready');
    } finally { await center.close(); }
  `], { cwd: directory, timeout: 15000, maxBuffer: 8192 });
  assert.match(stdout, /packaged center ready/);
});
