/**
 * The worker's own files, never on a music share: its cache folder (the
 * cover originals art.fetch keeps) and the container marker /.dockerenv.
 * Kept apart from the job files, which reach a music folder only through
 * the file gate (fileAccess.test.ts).
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultCacheDir } from '@tagave/core';

/** This worker's cache folder, read on every call (as art.fetch and art.thumb resolve it). */
export function workerCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env['CACHE_DIR'] || defaultCacheDir(env['HOME'] || '/tmp'));
}

/**
 * Writes `bytes` to `file` in the cache folder, its folder made first. A
 * path outside the cache folder throws: this is never a way onto a music share.
 */
export async function writeCacheFile(file: string, bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rel = path.relative(workerCacheRoot(env), path.resolve(file));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Not in the worker cache folder');
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

let containerCache: boolean | null = null;

/** This process runs in a container: Docker's /.dockerenv marker on the root filesystem. Asked once. */
export async function inContainer(): Promise<boolean> {
  if (containerCache === null) {
    containerCache = await access('/.dockerenv').then(() => true, () => false);
  }
  return containerCache;
}
