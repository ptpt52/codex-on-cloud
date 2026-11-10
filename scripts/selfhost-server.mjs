import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, chown, cp, lstat, mkdir, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve4 } from 'node:dns/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import {
  SELFHOST_VERSIONS, caddyAcmeConfig, caddyConfig, caddyUnit, centerEnvironment, centerUnit,
  certbotHook, coturnConfig, coturnUnit, frpsConfig, frpsUnit, serverDomain, serverEmail,
} from '../selfhost/server-config.mjs';

const exec = promisify(execFile), project = fileURLToPath(new URL('../', import.meta.url));
const ROOT = '/opt/codex-selfhost', ETC = '/etc/codex-selfhost', DATA = '/var/lib/codex-selfhost', SERVICE = 'codex-selfhost';

async function command(file, args, options = {}) {
  try { const value = await exec(file, args, { timeout: options.timeout || 120000, maxBuffer: options.maxBuffer || 1024 * 1024, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } }); return { ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() }; }
  catch (error) { return { ok: false, code: error.code, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || '').trim() }; }
}
async function requiredCommand(file, args, options) { const result = await command(file, args, options); if (!result.ok) throw Error(`${file} ${args[0] || ''} 失败：${result.stderr || result.stdout || result.code}`); return result; }

async function safeWrite(path, value, mode, uid = 0, gid = 0) {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw Error('拒绝覆盖非普通配置文件：' + path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path + '.next-' + process.pid; let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(value); await handle.sync(); await handle.close(); handle = undefined;
    await chmod(temporary, mode); await chown(temporary, uid, gid); await rename(temporary, path);
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}

const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
async function download(url, algorithm, expected, maximum = 128 * 1024 * 1024) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error('下载失败（HTTP ' + response.status + '）：' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) throw Error('下载文件超过大小上限：' + url);
  if (sha(algorithm, bytes) !== expected) throw Error('下载校验失败：' + url);
  return bytes;
}

async function installArchive({ bytes, archiveName, members, source, destination, verify, tarFlag = '-xzf' }) {
  const directory = dirname(destination), archive = join(directory, archiveName), unpack = join(directory, archiveName + '.unpack');
  await mkdir(unpack, { recursive: true, mode: 0o700 });
  try {
    await writeFile(archive, bytes, { mode: 0o600, flag: 'w' });
    await requiredCommand('tar', [tarFlag, archive, '-C', unpack, ...members], { timeout: 60000 });
    const target = join(unpack, source);
    const content = await readFile(target); verify(content);
    await chmod(target, 0o755); await rename(target, destination);
  } finally { await unlink(archive).catch(() => {}); await rm(unpack, { recursive: true, force: true }); }
}

async function installBinaries() {
  await mkdir(join(ROOT, 'bin'), { recursive: true, mode: 0o755 });
  const nodeArchive = await download(`https://nodejs.org/dist/v${SELFHOST_VERSIONS.node}/node-v${SELFHOST_VERSIONS.node}-linux-x64.tar.xz`, 'sha256', '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75');
  await installArchive({ bytes: nodeArchive, archiveName: 'node.tar.xz', members: [`node-v${SELFHOST_VERSIONS.node}-linux-x64/bin/node`], source: `node-v${SELFHOST_VERSIONS.node}-linux-x64/bin/node`, destination: join(ROOT, 'bin', 'node'), verify: () => {}, tarFlag: '-xJf' });
  const caddyArchive = await download(`https://github.com/caddyserver/caddy/releases/download/v${SELFHOST_VERSIONS.caddy}/caddy_${SELFHOST_VERSIONS.caddy}_linux_amd64.tar.gz`, 'sha512', '0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75');
  await installArchive({ bytes: caddyArchive, archiveName: 'caddy.tar.gz', members: ['caddy'], source: 'caddy', destination: join(ROOT, 'bin', 'caddy'), verify: () => {} });
  const frpArchive = await download(`https://github.com/fatedier/frp/releases/download/v${SELFHOST_VERSIONS.frp}/frp_${SELFHOST_VERSIONS.frp}_linux_amd64.tar.gz`, 'sha256', 'daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804');
  await installArchive({ bytes: frpArchive, archiveName: 'frp.tar.gz', members: [`frp_${SELFHOST_VERSIONS.frp}_linux_amd64/frps`], source: `frp_${SELFHOST_VERSIONS.frp}_linux_amd64/frps`, destination: join(ROOT, 'bin', 'frps'), verify: bytes => { if (sha('sha256', bytes) !== '4ad311e0630cf12945041143b926f515458836e896ff93c253d43c98cf304b89') throw Error('frps 二进制校验失败'); } });
}

async function copyApplication() {
  await mkdir(join(ROOT, 'app'), { recursive: true, mode: 0o755 });
  await cp(join(project, 'selfhost'), join(ROOT, 'app', 'selfhost'), { recursive: true, force: true, dereference: false });
  await mkdir(join(ROOT, 'app', 'panel'), { recursive: true, mode: 0o755 });
  await cp(join(project, 'panel', 'auth.mjs'), join(ROOT, 'app', 'panel', 'auth.mjs'), { force: true });
  await mkdir(join(ROOT, 'app', 'scripts'), { recursive: true, mode: 0o755 });
  await cp(join(project, 'scripts', 'state-files.mjs'), join(ROOT, 'app', 'scripts', 'state-files.mjs'), { force: true });
  await mkdir(join(ROOT, 'app', 'native'), { recursive: true, mode: 0o755 });
  await cp(join(project, 'native', 'file-lock.mjs'), join(ROOT, 'app', 'native', 'file-lock.mjs'), { force: true });
  await cp(join(project, 'package.json'), join(ROOT, 'app', 'package.json'), { force: true });
}

async function ensureUser() {
  const found = await command('id', ['-u', SERVICE]);
  if (!found.ok) await requiredCommand('useradd', ['--system', '--user-group', '--home-dir', DATA, '--shell', '/usr/sbin/nologin', SERVICE]);
  const uid = Number((await requiredCommand('id', ['-u', SERVICE])).stdout), gid = Number((await requiredCommand('id', ['-g', SERVICE])).stdout);
  return { uid, gid };
}

async function ensureDirectory(path, mode, uid, gid) {
  await mkdir(path, { recursive: true, mode });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('部署目录类型无效：' + path);
  await chmod(path, mode); await chown(path, uid, gid);
}

async function configure({ domain, email, publicIp }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('中心安装必须以 root 运行');
  domain = serverDomain(domain); email = serverEmail(email);
  const addresses = await resolve4(domain, { ttl: true }).catch(() => []);
  if (!addresses.some(item => item.address === publicIp)) throw Error(`DNS 尚未将 ${domain} 指向 ${publicIp}；未更改服务器`);
  await requiredCommand('apt-get', ['update'], { timeout: 300000 });
  await requiredCommand('apt-get', ['install', '-y', '--no-install-recommends', 'ca-certificates', 'curl', 'tar', 'xz-utils', `certbot=${SELFHOST_VERSIONS.certbot}`, `coturn=${SELFHOST_VERSIONS.coturn}`], { timeout: 300000 });
  const { uid, gid } = await ensureUser();
  for (const [path, mode] of [[ROOT, 0o755], [join(ROOT, 'bin'), 0o755], [ETC, 0o750], [DATA, 0o750], [join(DATA, 'acme'), 0o755], [join(DATA, 'center'), 0o700], [join(ETC, 'tls'), 0o750]]) await ensureDirectory(path, mode, path === DATA || path === join(DATA, 'center') ? uid : 0, path === DATA || path === join(DATA, 'center') ? gid : 0);
  await installBinaries(); await copyApplication(); await requiredCommand('chown', ['-R', 'root:root', join(ROOT, 'app')]);
  for (const [file, bytes] of [['admin_password', randomBytes(32).toString('hex') + '\n'], ['frp_token', randomBytes(32).toString('hex') + '\n'], ['frps_admin_password', randomBytes(24).toString('hex') + '\n'], ['turn_secret', randomBytes(32).toString('hex') + '\n']]) {
    try { await lstat(join(ETC, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; await safeWrite(join(ETC, file), bytes, 0o640, 0, gid); }
  }
  const frpToken = (await readFile(join(ETC, 'frp_token'), 'utf8')).trim(), frpsPassword = (await readFile(join(ETC, 'frps_admin_password'), 'utf8')).trim(), turnSecret = (await readFile(join(ETC, 'turn_secret'), 'utf8')).trim();
  await safeWrite(join(ETC, 'server.env'), centerEnvironment({ domain, dataDirectory: DATA, configDirectory: ETC }), 0o640, 0, gid);
  await safeWrite(join(ETC, 'frps.toml'), frpsConfig({ token: frpToken, adminPassword: frpsPassword }), 0o640, 0, gid);
  await safeWrite(join(ETC, 'turnserver.conf'), coturnConfig({ domain, publicIp, secret: turnSecret }), 0o640, 0, (await requiredCommand('id', ['-g', 'turnserver'])).stdout ? Number((await requiredCommand('id', ['-g', 'turnserver'])).stdout) : gid);
  await safeWrite('/etc/systemd/system/codex-selfhost-center.service', centerUnit({ root: ROOT, configDirectory: ETC, dataDirectory: DATA }), 0o644);
  await safeWrite('/etc/systemd/system/codex-selfhost-frps.service', frpsUnit({ root: ROOT, configDirectory: ETC }), 0o644);
  await safeWrite('/etc/systemd/system/codex-selfhost-caddy.service', caddyUnit({ root: ROOT, configDirectory: ETC, dataDirectory: DATA }), 0o644);
  await safeWrite('/etc/systemd/system/codex-selfhost-coturn.service', coturnUnit({ configDirectory: ETC }), 0o644);
  const hook = '/etc/letsencrypt/renewal-hooks/deploy/codex-selfhost'; await mkdir(dirname(hook), { recursive: true, mode: 0o755 }); await safeWrite(hook, certbotHook(domain, { configDirectory: ETC }), 0o755);
  await safeWrite(join(ETC, 'Caddyfile'), caddyAcmeConfig(domain, join(DATA, 'acme')), 0o644);
  await requiredCommand(join(ROOT, 'bin', 'caddy'), ['validate', '--config', join(ETC, 'Caddyfile'), '--adapter', 'caddyfile']);
  await requiredCommand('systemctl', ['daemon-reload']);
  for (const unit of ['codex-selfhost-center.service', 'codex-selfhost-caddy.service']) await requiredCommand('systemctl', ['enable', '--now', unit]);
  const certificate = join('/etc/letsencrypt/live', domain, 'fullchain.pem');
  if (!(await command('test', ['-f', certificate])).ok) {
    await requiredCommand('systemctl', ['start', 'codex-selfhost-caddy.service']);
    await requiredCommand('certbot', ['certonly', '--webroot', '--webroot-path', join(DATA, 'acme'), '--domain', domain, '--non-interactive', '--agree-tos', '--email', email, '--deploy-hook', hook], { timeout: 300000 });
  }
  await requiredCommand(hook, [], { timeout: 60000 });
  await safeWrite(join(ETC, 'Caddyfile'), caddyConfig(domain, { centerPort: 36180, frpHttpPort: 18080 }), 0o644);
  await requiredCommand(join(ROOT, 'bin', 'caddy'), ['validate', '--config', join(ETC, 'Caddyfile'), '--adapter', 'caddyfile']);
  for (const unit of ['codex-selfhost-center.service', 'codex-selfhost-frps.service', 'codex-selfhost-coturn.service', 'codex-selfhost-caddy.service']) await requiredCommand('systemctl', ['enable', '--now', unit]);
  await requiredCommand('systemctl', ['restart', 'codex-selfhost-caddy.service']);
  return { domain, root: ROOT, config: ETC, data: DATA, versions: SELFHOST_VERSIONS };
}

async function status() {
  const units = {};
  for (const name of ['codex-selfhost-center.service', 'codex-selfhost-frps.service', 'codex-selfhost-coturn.service', 'codex-selfhost-caddy.service']) units[name] = (await command('systemctl', ['is-active', name])).stdout || 'inactive';
  const domain = (await readFile(join(ETC, 'server.env'), 'utf8').catch(() => '')).match(/^SELFHOST_PUBLIC_HOST=(.+)$/m)?.[1] || '';
  const cert = domain ? await command('openssl', ['x509', '-enddate', '-noout', '-in', join(ETC, 'tls', 'fullchain.pem')]) : { stdout: '' };
  return { units, domain, certificate: cert.stdout.replace('notAfter=', '') || null };
}

try {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const commandName = process.argv[2] || 'status', { values } = parseArgs({ args: process.argv.slice(3), options: {
      domain: { type: 'string' }, email: { type: 'string' }, 'public-ip': { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) console.log('用法：sudo npm run selfhost:server -- install --domain 节点中心域名 --email 证书通知邮箱 --public-ip 服务器公网IPv4\n或 npm run selfhost:server -- status\n安装固定版本 Node/Caddy/frps/Certbot，配置中心管理页、/node/<slug>/ 和 systemd；默认不修改防火墙。');
    else if (commandName === 'install') console.log(JSON.stringify(await configure({ domain: values.domain, email: values.email, publicIp: values['public-ip'] }), null, 2));
    else if (commandName === 'status') console.log(JSON.stringify(await status(), null, 2));
    else throw Error('未知命令：' + commandName);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
