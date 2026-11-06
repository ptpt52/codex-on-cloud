import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSETS } from '../../panel/ui-assets.mjs';
export async function uiSnapshot() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-ui-'));
  const root = pathToFileURL(join(directory, 'panel', 'public') + '/');
  for (const [, [name]] of ASSETS) {
    const to = new URL(name, root); await mkdir(dirname(to.pathname), { recursive: true });
    await copyFile(new URL(name, new URL('../../panel/public/', import.meta.url)), to);
  }
  return { directory, root };
}
