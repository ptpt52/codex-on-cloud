import { readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
async function walk(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['node_modules', '.git', 'secrets', 'data', 'workspaces', 'test-results', 'playwright-report', '__pycache__'].includes(entry.name)) continue;
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...await walk(file)); else output.push(file);
  }
  return output;
}
let failed = false, count = 0;
for (const file of await walk(root)) {
  let command;
  if (/\.(mjs|js)$/.test(file)) command = [process.execPath, ['--check', file]];
  else if (/\.(sh|bashrc)$/.test(file) || /codex-(workbench|session)$/.test(file) || file.endsWith('/open-codex-terminal')) command = ['bash', ['-n', file]];
  else if (file.endsWith('.py')) command = ['python3', ['-m', 'py_compile', file]];
  if (!command) continue;
  count++;
  const result = spawnSync(...command, { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; console.error(relative(root, file), result.stderr || result.error); }
}
console.log(`${count} 个脚本语法检查${failed ? '失败' : '通过'}`);
process.exitCode = failed ? 1 : 0;
