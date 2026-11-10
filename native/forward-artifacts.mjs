import { constants } from 'node:fs';
import { open, lstat, mkdir, opendir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FORWARD_CLIENTS } from '../panel/public/forward-platform.js';

export const FORWARD_FILES = Object.freeze(Object.fromEntries(Object.entries(FORWARD_CLIENTS).map(([arch, item]) => [arch, item.name])));
export const ARTIFACT_LIMITS = Object.freeze({ file: 32 * 1024 * 1024, manifest: 4096, pointer: 256, generations: 2 });
export const GENERATION = /^[a-f0-9]{32}$/;
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export async function artifactRead(path, maximum) {
  const file = await open(path, FLAGS);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.size > maximum) throw Error('Invalid bounded helper file');
    const bytes = Buffer.alloc(info.size + 1 > maximum ? maximum + 1 : info.size + 1);
    let count = 0;
    while (count < bytes.length) { const result = await file.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
    if (count > maximum || count !== info.size) throw Error('Helper file changed while reading');
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}
export async function artifactDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('Invalid helper directory');
}
export async function currentGeneration(directory) {
  let bytes;
  try { bytes = await artifactRead(join(directory, 'current.json'), ARTIFACT_LIMITS.pointer); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value; try { value = JSON.parse(bytes); } catch { throw Error('Invalid helper publication pointer'); }
  if (value?.version !== 1 || !GENERATION.test(value.generation || '') || Object.keys(value).sort().join(',') !== 'generation,version') throw Error('Invalid helper publication pointer');
  return value.generation;
}
export async function artifactSnapshot(directory, requested) {
  await artifactDirectory(directory);
  if (requested !== undefined && !GENERATION.test(requested)) throw Object.assign(Error('助手版本参数无效'), { status: 400 });
  const generation = requested ?? await currentGeneration(directory);
  let location = directory;
  if (generation) {
    await artifactDirectory(join(directory, 'releases'));
    location = join(directory, 'releases', generation); await artifactDirectory(location);
  }
  let manifest; try { manifest = JSON.parse(await artifactRead(join(location, 'manifest.json'), ARTIFACT_LIMITS.manifest)); } catch { throw Error('Invalid helper manifest'); }
  if (manifest?.version !== (generation ? 2 : 1) || generation && manifest.generation !== generation || !Array.isArray(manifest.files) || manifest.files.length > 4 || new Set(manifest.files.map(item => item?.arch)).size !== manifest.files.length) throw Error('Invalid helper manifest');
  if (manifest.server !== undefined) {
    const target = new URL(manifest.server);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || !/^\/(?:node\/[a-z0-9-]{1,48}\/)?$/.test(target.pathname)) throw Error('Invalid helper server');
  }
  const files = manifest.files.filter(item => item && Object.hasOwn(FORWARD_FILES, item.arch) && item.name === FORWARD_FILES[item.arch] &&
    Number.isInteger(item.size) && item.size > 0 && item.size <= ARTIFACT_LIMITS.file && /^[a-f0-9]{64}$/.test(item.sha256) && typeof item.build === 'string' && /^[a-zA-Z0-9.+-]{1,64}$/.test(item.build));
  if (generation && files.length !== Object.keys(FORWARD_FILES).length) throw Error('Incomplete helper generation');
  return { generation, location, files, server: manifest.server };
}
const releaseFiles = new Set([...Object.values(FORWARD_FILES), 'helper.tmp', 'package.tmp', 'manifest.json', 'manifest.json.portal-lock', 'manifest.json.portal-next-v2']);
export async function removeRelease(directory, generation) {
  if (!GENERATION.test(generation)) throw Error('Invalid helper generation');
  const path = join(directory, 'releases', generation); await artifactDirectory(path);
  const entries = [], reader = await opendir(path, { bufferSize: 16 });
  for await (const entry of reader) {
    if (entries.length >= releaseFiles.size || !releaseFiles.has(entry.name) || !entry.isFile()) throw Error('Unexpected file in helper generation; preserved');
    const info = await lstat(join(path, entry.name));
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1) throw Error('Unsafe helper generation; preserved');
    entries.push(entry.name);
  }
  for (const name of entries) await unlink(join(path, name));
  await rmdir(path);
}
export async function prepareReleaseDirectory(directory) {
  await artifactDirectory(directory, true);
  const current = await currentGeneration(directory);
  const releases = join(directory, 'releases'); await artifactDirectory(releases, true);
  const generations = [], reader = await opendir(releases, { bufferSize: 4 });
  for await (const entry of reader) {
    if (generations.length >= ARTIFACT_LIMITS.generations || !GENERATION.test(entry.name) || !entry.isDirectory()) throw Error('Unexpected helper release directory; preserved');
    generations.push(entry.name);
  }
  if (current && !generations.includes(current)) throw Error('Current helper generation is missing');
  // Previous downloads already opened retain their fd; old links get 410.
  for (const generation of generations) if (generation !== current) await removeRelease(directory, generation);
  return current;
}
