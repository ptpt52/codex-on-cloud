// Real isolated kernel NAT + Chrome and Go/Pion. No production services or peers.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const network = process.env.NAT_TEST_ROOT === '1' ? ['sudo', ['-n', 'unshare', '--net', '--']] : ['unshare', ['--user', '--map-root-user', '--net', '--']];
try {
  await exec(network[0], [...network[1], 'sh', '-c', 'ip link add probe type veth peer name other && ip link delete probe && nft list ruleset >/dev/null'], { timeout: 15000, maxBuffer: 16384 });
} catch (error) {
  if (process.env.NAT_TEST_REQUIRED === '1') throw Error('NAT test needs iproute2/nftables and isolated network namespaces', { cause: error });
  console.log('SKIP actual NAT test: iproute2/nftables or isolated network namespaces unavailable');
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'codex-nat-')), binary = join(directory, 'helper.test');
try {
  const browser = process.env.CHROME_PATH || chromium.executablePath();
  await access(browser, constants.X_OK);
  await exec('go', ['test', '-c', '-o', binary, '.'], { cwd: join(root, 'client/forward'), env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 180000, maxBuffer: 32768 });
  assert.ok((await stat(binary)).size <= 64 * 1024 * 1024);
  const parentNetwork = String((await stat('/proc/self/ns/net')).ino);
  // Resolve under the invoking user, then carry the exact path across sudo.
  const { stdout } = await exec(network[0], [...network[1], 'python3', 'test/rtc-nat-network.py', process.execPath, binary, parentNetwork, browser], { cwd: root, timeout: 180000, maxBuffer: 256 * 1024 });
  process.stdout.write(stdout);
} finally { await rm(directory, { recursive: true, force: true }); }
