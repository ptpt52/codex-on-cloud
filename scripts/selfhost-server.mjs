import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, chown, cp, lstat, mkdir, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve4 } from 'node:dns/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import {
  SELFHOST_VERSIONS, caddyAcmeBootstrap, caddyConfig, caddyUnit, centerEnvironment, centerUnit,
  certbotHook, coturnConfig, coturnUnit, frpsConfig, frpsUnit, serverDomain, serverEmail,
} from '../selfhost/server-config.mjs';
import { resolveAdminCidrs, serverSettings } from '../selfhost/server-settings.mjs';
import { probeLocalHttps, validateServerCertificate } from '../selfhost/certificates.mjs';
import { readHelpPage } from '../selfhost/help-page.mjs';
import { serverUpdate } from '../selfhost/server-update.mjs';
import { acquireFileLock } from '../native/file-lock.mjs';
import { readResponseBytes } from '../native/response-body.mjs';

const exec = promisify(execFile), project = fileURLToPath(new URL('../', import.meta.url));
const ROOT = '/opt/codex-selfhost', ETC = '/etc/codex-selfhost', DATA = '/var/lib/codex-selfhost', SERVICE = 'codex-selfhost';
const SERVICES = ['codex-selfhost-center.service', 'codex-selfhost-frps.service', 'codex-selfhost-coturn.service', 'codex-selfhost-caddy.service'];
const CERT_HOOK = '/etc/letsencrypt/renewal-hooks/deploy/codex-selfhost';
const UPDATE_FILES = [
  ...['server.env', 'server-settings.json', 'Caddyfile', 'frps.toml', 'turnserver.conf', 'help.html'].map(file => join(ETC, file)),
  ...['fullchain.pem', 'privkey.pem', 'turn-fullchain.pem', 'turn-privkey.pem'].map(file => join(ETC, 'tls', file)),
  ...SERVICES.map(file => join('/etc/systemd/system', file)), CERT_HOOK,
];
const updateOptions = () => ({ directory: join(ROOT, 'update-backup'), files: UPDATE_FILES,
  application: { current: join(ROOT, 'app'), previous: join(ROOT, 'app.previous'), failed: join(ROOT, 'app.failed') }, services: SERVICES, run: command });
const ARCHITECTURES = {
  x64: { node: 'x64', nodeSha: '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75', frp: 'amd64', frpArchiveSha: 'daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804', frpsSha: '4ad311e0630cf12945041143b926f515458836e896ff93c253d43c98cf304b89' },
  arm64: { node: 'arm64', nodeSha: 'eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8', frp: 'arm64', frpArchiveSha: '02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf', frpsSha: '07d0a010dc60ba759d857365307a89dce1df215c5cdddee92ce355140461bf18' },
};

async function command(file, args, options = {}) {
  try { const value = await exec(file, args, { timeout: options.timeout || 120000, maxBuffer: options.maxBuffer || 1024 * 1024, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } }); return { ok: true, stdout: value.stdout.trim(), stderr: value.stderr.trim() }; }
  catch (error) { return { ok: false, code: error.code, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || '').trim() }; }
}
async function requiredCommand(file, args, options) { const result = await command(file, args, options); if (!result.ok) throw Error(`${file} ${args[0] || ''} 失败：${result.stderr || result.stdout || result.code}`); return result; }

async function waitCheck(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('等待 ' + label + ' 超时' + (last ? '：' + last.message : ''));
}
async function listenTcp(port) {
  await waitCheck(() => new Promise(resolve => { const socket = net.createConnection(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); }), 'TCP ' + port);
}
async function localHttpsHealth(domain) {
  const certificate = await readFile(join(ETC, 'tls', 'fullchain.pem'));
  validateServerCertificate(certificate, { domain });
  await waitCheck(() => probeLocalHttps(domain, { certificate }), 'HTTPS /healthz');
}

async function privateIPv4(configured) {
  if (configured && net.isIP(configured) !== 4) throw Error('私网 IPv4 地址无效');
  let address = configured;
  if (!address) {
    const route = await requiredCommand('ip', ['-4', 'route', 'get', '1.1.1.1']);
    address = route.stdout.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
    if (net.isIP(address) !== 4) throw Error('无法自动识别 TURN 私网 IPv4，请使用 --private-ip');
  }
  const addresses = await requiredCommand('ip', ['-4', '-o', 'addr', 'show']);
  if (!addresses.stdout.split('\n').some(line => line.includes(` inet ${address}/`))) throw Error('TURN 私网 IPv4 未分配在本机：' + address);
  return address;
}

function validCidr(value, version) {
  if (typeof value !== 'string') return false;
  const [address, prefix, extra] = value.split('/');
  return extra === undefined && net.isIP(address) === version && /^\d{1,3}$/.test(prefix || '') && Number(prefix) >= 0 && Number(prefix) <= (version === 4 ? 32 : 128);
}

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
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw Error('HTTP ' + response.status);
      const bytes = await readResponseBytes(response, maximum, '文件超过大小上限');
      if (sha(algorithm, bytes) !== expected) throw Error('校验不一致');
      return bytes;
    } catch (error) { last = error; if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000)); }
  }
  throw Error('下载失败（尝试 3 次）：' + url + '：' + last.message);
}

async function installArchive({ bytes, archiveName, members, source, destination, verify, tarFlag = '-xzf' }) {
  const directory = dirname(destination), archive = join(directory, archiveName), unpack = join(directory, archiveName + '.unpack');
  await mkdir(unpack, { recursive: true, mode: 0o700 });
  try {
    await writeFile(archive, bytes, { mode: 0o600, flag: 'w' });
    await requiredCommand('tar', [tarFlag, archive, '-C', unpack, ...members], { timeout: 60000 });
    const target = join(unpack, source);
    const content = await readFile(target); verify(content);
    await chmod(target, 0o755); await chown(target, 0, 0); await rename(target, destination);
  } finally { await unlink(archive).catch(() => {}); await rm(unpack, { recursive: true, force: true }); }
}

async function installBinaries({ caddyFile, frpsFile } = {}) {
  const arch = ARCHITECTURES[process.arch]; if (!arch) throw Error('中心安装仅支持 x86_64 或 arm64');
  await mkdir(join(ROOT, 'bin'), { recursive: true, mode: 0o755 });
  const matches = async (file, args, expected) => { const result = await command(file, args); if (result.ok && result.stdout.includes(expected)) return true; const exists = await command('test', ['-e', file]); if (exists.ok) throw Error('已有 ' + file + ' 与固定版本 ' + expected + ' 不一致，拒绝覆盖'); return false; };
  const hasNode = await matches(join(ROOT, 'bin', 'node'), ['--version'], 'v' + SELFHOST_VERSIONS.node);
  const hasFrps = await matches(join(ROOT, 'bin', 'frps'), ['--version'], SELFHOST_VERSIONS.frp);
  if (!hasNode) {
  const nodeArchive = await download(`https://nodejs.org/dist/v${SELFHOST_VERSIONS.node}/node-v${SELFHOST_VERSIONS.node}-linux-${arch.node}.tar.xz`, 'sha256', arch.nodeSha);
  await installArchive({ bytes: nodeArchive, archiveName: 'node.tar.xz', members: [`node-v${SELFHOST_VERSIONS.node}-linux-${arch.node}/bin/node`], source: `node-v${SELFHOST_VERSIONS.node}-linux-${arch.node}/bin/node`, destination: join(ROOT, 'bin', 'node'), verify: () => {}, tarFlag: '-xJf' });
  }
  if (!hasFrps) {
    if (frpsFile) {
      const bytes = await readFile(frpsFile); if (sha('sha256', bytes) !== arch.frpsSha) throw Error('导入 frps 二进制与固定版本校验不一致');
      await safeWrite(join(ROOT, 'bin', 'frps'), bytes, 0o755); await chown(join(ROOT, 'bin', 'frps'), 0, 0);
    } else {
      const frpArchive = await download(`https://github.com/fatedier/frp/releases/download/v${SELFHOST_VERSIONS.frp}/frp_${SELFHOST_VERSIONS.frp}_linux_${arch.frp}.tar.gz`, 'sha256', arch.frpArchiveSha);
      await installArchive({ bytes: frpArchive, archiveName: 'frp.tar.gz', members: [`frp_${SELFHOST_VERSIONS.frp}_linux_${arch.frp}/frps`], source: `frp_${SELFHOST_VERSIONS.frp}_linux_${arch.frp}/frps`, destination: join(ROOT, 'bin', 'frps'), verify: bytes => { if (sha('sha256', bytes) !== arch.frpsSha) throw Error('frps 二进制校验失败'); } });
    }
  }
  const sourceCaddy = caddyFile || '/usr/bin/caddy';
  const caddyVersion = await command(sourceCaddy, ['version']);
  if (!caddyVersion.ok || !caddyVersion.stdout.includes(SELFHOST_VERSIONS.caddy)) throw Error('Caddy 版本必须为固定版本 ' + SELFHOST_VERSIONS.caddy);
  const caddyBytes = await readFile(sourceCaddy);
  if (caddyBytes.length > 128 * 1024 * 1024) throw Error('Caddy 二进制超过 128 MiB');
  await safeWrite(join(ROOT, 'bin', 'caddy'), caddyBytes, 0o755);
  for (const name of ['node', 'caddy', 'frps']) { await chown(join(ROOT, 'bin', name), 0, 0); await chmod(join(ROOT, 'bin', name), 0o755); }
}

export async function copyApplicationFiles(next) {
  await cp(join(project, 'selfhost'), join(next, 'selfhost'), { recursive: true, force: true, dereference: false });
  await mkdir(join(next, 'panel', 'public'), { recursive: true, mode: 0o755 });
  for (const file of ['auth.mjs', 'login-identity.mjs', 'rtc-network.mjs']) await cp(join(project, 'panel', file), join(next, 'panel', file), { force: true });
  await cp(join(project, 'panel', 'public', 'rtc-address.js'), join(next, 'panel', 'public', 'rtc-address.js'), { force: true });
  await mkdir(join(next, 'scripts'), { recursive: true, mode: 0o755 });
  await cp(join(project, 'scripts', 'state-files.mjs'), join(next, 'scripts', 'state-files.mjs'), { force: true });
  await mkdir(join(next, 'native'), { recursive: true, mode: 0o755 });
  await cp(join(project, 'native', 'file-lock.mjs'), join(next, 'native', 'file-lock.mjs'), { force: true });
  await cp(join(project, 'native', 'response-body.mjs'), join(next, 'native', 'response-body.mjs'), { force: true });
  await cp(join(project, 'native', 'file_lock.py'), join(next, 'native', 'file_lock.py'), { force: true });
  await cp(join(project, 'package.json'), join(next, 'package.json'), { force: true });
}

async function copyApplication(beforeActivate = async () => {}) {
  const app = join(ROOT, 'app'), previous = join(ROOT, 'app.previous'), next = join(ROOT, 'app.next-' + process.pid);
  await rm(next, { recursive: true, force: true }); await mkdir(next, { recursive: true, mode: 0o755 });
  await copyApplicationFiles(next);
  await requiredCommand('chmod', ['-R', 'u=rwX,go=rX', next]); await requiredCommand('chown', ['-R', 'root:root', next]);
  let moved = false;
  try {
    await beforeActivate();
    if ((await command('test', ['-d', app])).ok) { await rm(previous, { recursive: true, force: true }); await rename(app, previous); moved = true; }
    await rename(next, app);
  } catch (error) { if (moved && !(await command('test', ['-e', app])).ok) await rename(previous, app); throw error; }
  finally { await rm(next, { recursive: true, force: true }); }
}

async function rollbackApplication() {
  const app = join(ROOT, 'app'), previous = join(ROOT, 'app.previous'), failed = join(ROOT, 'app.failed');
  if (!(await command('test', ['-d', previous])).ok) throw Error('没有可回滚的上一版中心应用');
  await rm(failed, { recursive: true, force: true }); await rename(app, failed); await rename(previous, app);
  const envText = await readFile(join(ETC, 'server.env'), 'utf8'), domain = envText.match(/^SELFHOST_PUBLIC_HOST=(.+)$/m)?.[1];
  if (!domain) throw Error('中心域名配置丢失，未重启回滚应用');
  for (const unit of ['codex-selfhost-center.service', 'codex-selfhost-frps.service']) await requiredCommand('systemctl', ['restart', unit]);
  await localHttpsHealth(domain);
  return { rolledBack: true, domain };
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

async function readImportedCertificate({ domain, certFile, keyFile }) {
  if (!certFile || !keyFile) throw Error('导入证书时必须同时提供 --cert-file 和 --key-file');
  const certificate = await readFile(certFile), key = await readFile(keyFile);
  if (certificate.length < 100 || certificate.length > 1024 * 1024 || key.length < 100 || key.length > 256 * 1024) throw Error('导入证书或私钥大小无效');
  const certText = certificate.toString(), keyText = key.toString();
  if (!certText.includes('-----BEGIN CERTIFICATE-----') || !/(?:-----BEGIN (?:RSA |EC |)PRIVATE KEY-----)/.test(keyText)) throw Error('导入文件不是 PEM 证书或私钥');
  validateServerCertificate(certText, { domain, privateKey: keyText });
  return { certText, keyText };
}

async function installImportedCertificate({ domain, certText, keyText }) {
  validateServerCertificate(certText, { domain, privateKey: keyText });
  const serviceGid = Number((await requiredCommand('id', ['-g', SERVICE])).stdout), turnGid = Number((await requiredCommand('id', ['-g', 'turnserver'])).stdout);
  await safeWrite(join(ETC, 'tls', 'fullchain.pem'), certText, 0o640, 0, serviceGid);
  await safeWrite(join(ETC, 'tls', 'privkey.pem'), keyText, 0o640, 0, serviceGid);
  await safeWrite(join(ETC, 'tls', 'turn-fullchain.pem'), certText, 0o640, 0, turnGid);
  await safeWrite(join(ETC, 'tls', 'turn-privkey.pem'), keyText, 0o640, 0, turnGid);
}

async function configure({ domain, email, publicIp, privateIp, certFile, keyFile, caddyFile, frpsFile, helpFile, configureUfw = false, sshCidr, adminCidr }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('中心安装必须以 root 运行');
  if (configureUfw && !sshCidr) throw Error('配置 UFW 时必须用 --ssh-cidr 指定允许 SSH 的运维网段');
  const helpPage = helpFile ? await readHelpPage(resolve(helpFile)) : null;
  domain = serverDomain(domain);
  const settingsPath = join(ETC, 'server-settings.json');
  const settingsText = await readFile(settingsPath, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const existingCaddy = await readFile(join(ETC, 'Caddyfile'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const adminCidrs = resolveAdminCidrs({ provided: adminCidr, settingsText, caddyText: existingCaddy });
  if (sshCidr && !validCidr(sshCidr, 4) && !validCidr(sshCidr, 6)) throw Error('SSH CIDR 无效');
  if (net.isIP(publicIp) !== 4) throw Error('公网 IP 必须是 IPv4 地址');
  const localIpv4 = await privateIPv4(privateIp);
  if (!!certFile !== !!keyFile) throw Error('导入证书时必须同时提供 --cert-file 和 --key-file');
  const importedCertificate = certFile ? await readImportedCertificate({ domain, certFile, keyFile }) : null;
  if (!certFile) email = serverEmail(email);
  const addresses = await resolve4(domain, { ttl: true }).catch(() => []);
  if (!addresses.some(item => item.address === publicIp)) throw Error(`DNS 尚未将 ${domain} 指向 ${publicIp}；未更改服务器`);
  await ensureDirectory(ROOT, 0o755, 0, 0);
  const lease = await acquireFileLock(join(ROOT, 'update.lock'));
  let update;
  try {
    update = await serverUpdate(updateOptions());
    await requiredCommand('apt-get', ['update'], { timeout: 300000 });
    await requiredCommand('apt-get', ['install', '-y', '--no-install-recommends', 'ca-certificates', 'curl', 'tar', 'xz-utils', `caddy=${SELFHOST_VERSIONS.caddyPackage}`, `certbot=${SELFHOST_VERSIONS.certbot}`, `coturn=${SELFHOST_VERSIONS.coturn}`], { timeout: 300000 });
    await command('systemctl', ['disable', '--now', 'coturn']);
    await command('systemctl', ['disable', '--now', 'caddy']);
    const { uid, gid } = await ensureUser();
    for (const [path, mode, owner, group] of [[ROOT, 0o755, 0, 0], [join(ROOT, 'bin'), 0o755, 0, 0], [ETC, 0o750, 0, gid], [DATA, 0o750, uid, gid], [join(DATA, 'acme'), 0o755, 0, 0], [join(DATA, 'center'), 0o700, uid, gid], [join(ETC, 'tls'), 0o750, 0, gid]]) await ensureDirectory(path, mode, owner, group);
    await installBinaries({ caddyFile, frpsFile }); await copyApplication(() => update.applicationChanging());
    if (helpPage) await safeWrite(join(ETC, 'help.html'), helpPage, 0o640, 0, gid);
    for (const [file, bytes] of [['admin_password', randomBytes(32).toString('hex') + '\n'], ['frp_token', randomBytes(32).toString('hex') + '\n'], ['frps_admin_password', randomBytes(24).toString('hex') + '\n'], ['turn_secret', randomBytes(32).toString('hex') + '\n']]) {
      try { await lstat(join(ETC, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; await safeWrite(join(ETC, file), bytes, 0o600, uid, gid); }
    }
    for (const file of ['admin_password', 'frp_token', 'turn_secret']) { await chmod(join(ETC, file), 0o600); await chown(join(ETC, file), uid, gid); }
    await chmod(join(ETC, 'frps_admin_password'), 0o600); await chown(join(ETC, 'frps_admin_password'), uid, gid);
    const frpToken = (await readFile(join(ETC, 'frp_token'), 'utf8')).trim(), frpsPassword = (await readFile(join(ETC, 'frps_admin_password'), 'utf8')).trim(), turnSecret = (await readFile(join(ETC, 'turn_secret'), 'utf8')).trim();
    await safeWrite(join(ETC, 'server.env'), centerEnvironment({ domain, publicIp, dataDirectory: DATA, configDirectory: ETC }), 0o640, 0, gid);
    await safeWrite(settingsPath, serverSettings(adminCidrs), 0o600, 0, 0);
    await safeWrite(join(ETC, 'frps.toml'), frpsConfig({ token: frpToken, adminPassword: frpsPassword }), 0o640, 0, gid);
    await safeWrite(join(ETC, 'turnserver.conf'), coturnConfig({ domain, publicIp, privateIp: localIpv4, secret: turnSecret }), 0o640, 0, (await requiredCommand('id', ['-g', 'turnserver'])).stdout ? Number((await requiredCommand('id', ['-g', 'turnserver'])).stdout) : gid);
    await safeWrite('/etc/systemd/system/codex-selfhost-center.service', centerUnit({ root: ROOT, configDirectory: ETC, dataDirectory: DATA }), 0o644);
    await safeWrite('/etc/systemd/system/codex-selfhost-frps.service', frpsUnit({ root: ROOT, configDirectory: ETC }), 0o644);
    await safeWrite('/etc/systemd/system/codex-selfhost-caddy.service', caddyUnit({ root: ROOT, configDirectory: ETC, dataDirectory: DATA }), 0o644);
    await safeWrite('/etc/systemd/system/codex-selfhost-coturn.service', coturnUnit({ configDirectory: ETC }), 0o644);
    await requiredCommand('systemctl', ['daemon-reload']);
    const hook = CERT_HOOK;
    if (certFile) {
      await installImportedCertificate({ domain, ...importedCertificate });
      const existingHook = await readFile(hook, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existingHook?.includes('# Managed by codex-selfhost.') || existingHook?.includes('systemctl restart codex-selfhost-frps.service')) await unlink(hook);
    } else {
      await mkdir(dirname(hook), { recursive: true, mode: 0o755 }); await safeWrite(hook, certbotHook(domain, { configDirectory: ETC, restart: false }), 0o755);
      await safeWrite(join(ETC, 'Caddyfile'), caddyAcmeBootstrap(domain, join(DATA, 'acme'), existingCaddy), 0o644);
      await requiredCommand(join(ROOT, 'bin', 'caddy'), ['validate', '--config', join(ETC, 'Caddyfile'), '--adapter', 'caddyfile']);
      for (const unit of ['codex-selfhost-center.service', 'codex-selfhost-caddy.service']) { await command('systemctl', ['reset-failed', unit]); await requiredCommand('systemctl', ['enable', '--now', unit]); }
      await requiredCommand('systemctl', ['restart', 'codex-selfhost-caddy.service']);
      const certificate = join('/etc/letsencrypt/live', domain, 'fullchain.pem');
      if (!(await command('test', ['-f', certificate])).ok) await requiredCommand('certbot', ['certonly', '--webroot', '--webroot-path', join(DATA, 'acme'), '--domain', domain, '--non-interactive', '--agree-tos', '--email', email], { timeout: 300000 });
      // Bootstrap only copies the certificate. Activate services after writing the final config.
      await requiredCommand(hook, [], { timeout: 60000 });
      await safeWrite(hook, certbotHook(domain, { configDirectory: ETC }), 0o755);
    }
    await safeWrite(join(ETC, 'Caddyfile'), caddyConfig(domain, { centerPort: 36180, frpHttpPort: 18080, redirectHttp: !certFile, adminCidrs }), 0o644);
    await requiredCommand(join(ROOT, 'bin', 'caddy'), ['validate', '--config', join(ETC, 'Caddyfile'), '--adapter', 'caddyfile']);
    for (const unit of ['codex-selfhost-center.service', 'codex-selfhost-caddy.service']) { await command('systemctl', ['reset-failed', unit]); await requiredCommand('systemctl', ['enable', '--now', unit]); }
    for (const unit of ['codex-selfhost-center.service', 'codex-selfhost-frps.service', 'codex-selfhost-coturn.service', 'codex-selfhost-caddy.service']) { await command('systemctl', ['reset-failed', unit]); await requiredCommand('systemctl', ['enable', '--now', unit]); }
    for (const unit of ['codex-selfhost-center.service', 'codex-selfhost-frps.service', 'codex-selfhost-coturn.service', 'codex-selfhost-caddy.service']) await requiredCommand('systemctl', ['restart', unit]);
    await localHttpsHealth(domain);
    for (const port of [7000, 3478, 5349]) await listenTcp(port);
    if (configureUfw) {
      await requiredCommand('apt-get', ['install', '-y', '--no-install-recommends', 'ufw'], { timeout: 120000 });
      for (const rule of [['allow', 'from', sshCidr, 'to', 'any', 'port', '22', 'proto', 'tcp'], ['allow', '80/tcp'], ['allow', '443/tcp'], ['allow', '7000/tcp'], ['allow', '3478/tcp'], ['allow', '3478/udp'], ['allow', '5349/tcp'], ['allow', '49160:49223/udp']]) await requiredCommand('ufw', rule);
      await requiredCommand('ufw', ['--force', 'enable']);
    }
    await update.commit();
    return { domain, root: ROOT, config: ETC, data: DATA, versions: SELFHOST_VERSIONS };
  } catch (error) {
    if (update) {
      if (update.committed) throw Error('更新已生效，但备份清理未完成：' + error.message + '。请运行 sudo ./scripts/selfhost-server.sh recover');
      try { await update.rollback(); }
      catch (failure) { throw Error(error.message + '；恢复未完成：' + failure.message + '。请运行 sudo ./scripts/selfhost-server.sh recover'); }
      throw Error(error.message + '；原配置、应用与服务状态已恢复');
    }
    throw error;
  } finally { await lease.release(); }
}

async function status() {
  const units = {};
  for (const name of ['codex-selfhost-center.service', 'codex-selfhost-frps.service', 'codex-selfhost-coturn.service', 'codex-selfhost-caddy.service']) units[name] = (await command('systemctl', ['is-active', name])).stdout || 'inactive';
  const domain = (await readFile(join(ETC, 'server.env'), 'utf8').catch(() => '')).match(/^SELFHOST_PUBLIC_HOST=(.+)$/m)?.[1] || '';
  const cert = domain ? await command('openssl', ['x509', '-enddate', '-noout', '-in', join(ETC, 'tls', 'fullchain.pem')]) : { stdout: '' };
  const settingsText = await readFile(join(ETC, 'server-settings.json'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const caddyText = await readFile(join(ETC, 'Caddyfile'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  return { units, domain, certificate: cert.stdout.replace('notAfter=', '') || null, adminCidrs: resolveAdminCidrs({ settingsText, caddyText }) };
}

try {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const commandName = process.argv[2] || 'status', { values } = parseArgs({ args: process.argv.slice(3), options: {
      domain: { type: 'string' }, email: { type: 'string' }, 'public-ip': { type: 'string' }, 'private-ip': { type: 'string' }, 'cert-file': { type: 'string' }, 'key-file': { type: 'string' }, 'caddy-file': { type: 'string' }, 'frps-file': { type: 'string' }, 'help-file': { type: 'string' }, 'configure-ufw': { type: 'boolean' }, 'ssh-cidr': { type: 'string' }, 'admin-cidr': { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) console.log('用法：\nsudo ./scripts/selfhost-server.sh install --domain 节点中心域名 --public-ip 服务器公网IPv4 --email 证书通知邮箱\nsudo ./scripts/selfhost-server.sh install --domain 节点中心域名 --public-ip 服务器公网IPv4 --cert-file fullchain.pem --key-file privkey.pem\n可选：--private-ip TURN私网IPv4；不填时按默认路由自动识别\n可选帮助页：--help-file /path/help.html（复制到配置目录，省略时保留已有页面）\n可选本地固定版本二进制：--frps-file /path/frps --caddy-file /path/caddy\n可选：--admin-cidr 管理网段1,管理网段2（或 none 清除） --configure-ufw --ssh-cidr 运维网段\n未传 --admin-cidr 时沿用已保存或旧 Caddyfile 中的管理网段。\n或 sudo ./scripts/selfhost-server.sh status\n更新失败恢复：sudo ./scripts/selfhost-server.sh recover\nTURN 首版固定使用 IPv4；IPv6 直连仍由浏览器与节点 ICE 独立协商。默认不修改防火墙。');
    else if (commandName === 'install') console.log(JSON.stringify(await configure({ domain: values.domain, email: values.email, publicIp: values['public-ip'], privateIp: values['private-ip'], certFile: values['cert-file'], keyFile: values['key-file'], caddyFile: values['caddy-file'], frpsFile: values['frps-file'], helpFile: values['help-file'], configureUfw: values['configure-ufw'], sshCidr: values['ssh-cidr'], adminCidr: values['admin-cidr'] }), null, 2));
    else if (commandName === 'rollback') {
      if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('中心回滚必须以 root 运行');
      const lease = await acquireFileLock(join(ROOT, 'update.lock'));
      try {
        if ((await command('test', ['-d', join(ROOT, 'update-backup')])).ok) throw Error('存在未完成的服务器更新，请先运行 selfhost-server.sh recover');
        console.log(JSON.stringify(await rollbackApplication(), null, 2));
      } finally { await lease.release(); }
    }
    else if (commandName === 'recover') {
      if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('中心恢复必须以 root 运行');
      const lease = await acquireFileLock(join(ROOT, 'update.lock'));
      try { const result = await (await serverUpdate({ ...updateOptions(), recover: true })).rollback(); console.log(result?.committed ? '更新已生效，备份清理完成' : '服务器更新前的配置、应用与服务状态已恢复'); }
      finally { await lease.release(); }
    }
    else if (commandName === 'status') console.log(JSON.stringify(await status(), null, 2));
    else throw Error('未知命令：' + commandName);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
