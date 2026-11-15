import { constants } from 'node:fs';
import { open, mkdir, lstat, writeFile, rename, unlink, chmod, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const SHELL_CONFIG_LIMIT = 65536;
const marker = '# >>> codex-on-cloud shared development environment >>>';
export const shellEnvironmentHook = `${marker}
if [ -f "$HOME/.config/shell/dev-env.sh" ] && [ ! -L "$HOME/.config/shell/dev-env.sh" ] && [ -r "$HOME/.config/shell/dev-env.sh" ]; then
    if [ "$(/usr/bin/wc -c < "$HOME/.config/shell/dev-env.sh")" -le 65536 ]; then
        . "$HOME/.config/shell/dev-env.sh"
    else
        printf '%s\\n' 'Shared development environment exceeds 64 KiB; skipped.' >&2
    fi
fi
# <<< codex-on-cloud shared development environment <<<
`;

async function userFile(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw Error('无法安全读取 shell 配置文件'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > SHELL_CONFIG_LIMIT) throw Error('shell 配置必须是当前用户的普通文件，且不超过 64 KiB');
    const buffer = Buffer.alloc(SHELL_CONFIG_LIMIT + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size) throw Error('shell 配置在读取期间变化');
    const text = buffer.subarray(0, count).toString('utf8');
    if (!Buffer.from(text).equals(buffer.subarray(0, count))) throw Error('shell 配置需要使用 UTF-8 编码');
    return { text, mode: stat.mode & 0o777 };
  } finally { await file.close(); }
}
async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('shell 配置目录必须属于当前用户，且不能是符号链接');
}
async function replace(path, text, mode = 0o600) {
  const temporary = path + '.tmp-' + randomBytes(8).toString('hex');
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// Explicit user command only. Deployment/recovery never edits shell settings.
// One shared file plus at most four fixed backups, each limited to 64 KiB.
export async function setupShellEnvironment({ home = homedir() } = {}) {
  if (process.getuid() === 0) throw Error('请用开发用户运行，不能使用 sudo');
  const candidates = ['.bash_profile', '.bash_login', '.profile'];
  const profiles = await Promise.all(candidates.map(name => userFile(join(home, name))));
  const selected = profiles.findIndex(Boolean), loginName = candidates[selected < 0 ? 2 : selected];
  const login = selected < 0 ? null : profiles[selected], bashrc = await userFile(join(home, '.bashrc'));
  const folder = join(home, '.config', 'shell'), sharedPath = join(folder, 'dev-env.sh');
  const shared = await userFile(sharedPath);
  const template = await readFile(new URL('../desktop/dev-env.sh', import.meta.url), 'utf8');
  if (Buffer.byteLength(template) > SHELL_CONFIG_LIMIT) throw Error('共享环境模板超过 64 KiB');
  const loginDefault = '# Login Bash uses the same interactive setup as a system terminal.\nif [ -n "${BASH_VERSION:-}" ] && [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n';
  const edits = [['.bashrc', bashrc, ''], [loginName, login, loginDefault]].flatMap(([name, previous, fallback]) => {
    const text = previous?.text ?? fallback;
    if (text.includes(marker)) {
      if (!text.startsWith(shellEnvironmentHook) || text.indexOf(marker, marker.length) !== -1) throw Error('已有环境加载块位置或内容不同，请先核对用户配置');
      return [];
    }
    const next = shellEnvironmentHook + '\n' + text;
    if (Buffer.byteLength(next) > SHELL_CONFIG_LIMIT) throw Error('加入加载块后 shell 配置超过 64 KiB');
    return [{ name, previous, next }];
  });
  await directory(join(home, '.config')); await directory(folder);
  const backup = join(folder, 'backups'); await directory(backup);
  await chmod(folder, 0o700); await chmod(backup, 0o700);
  // Validate all fixed backup targets before changing any startup file.
  for (const { name } of edits) await userFile(join(backup, name));
  for (const { name, previous } of edits) if (previous) await replace(join(backup, name), previous.text);
  if (!shared) await replace(sharedPath, template);
  for (const { name, previous, next } of edits) await replace(join(home, name), next, previous?.mode ?? 0o600);
  return { created: !shared, hooked: edits.map(({ name }) => name), loginFile: loginName };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw Error('用法：npm run shell:setup（无参数）');
    const result = await setupShellEnvironment();
    console.log(`共享开发环境${result.created ? '已创建' : '已保留'}：~/.config/shell/dev-env.sh；加载入口：~/.bashrc、~/${result.loginFile}。`);
    console.log('原始启动文件备份：~/.config/shell/backups/。请将原有开发环境设置移入共享文件，保留 .bashrc 中的交互工具初始化。已有终端保持原环境，详见 docs/shell-environment.md。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
