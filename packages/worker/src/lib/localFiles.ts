/**
 * The worker's own files, never on a music share: its cache folder (the
 * cover originals art.fetch keeps) and the container marker /.dockerenv.
 * Kept apart from the job files, which reach a music folder only through
 * the file gate (fileAccess.test.ts).
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Writes `bytes` to `file` in the cache folder, its folder made first. */
export async function writeCacheFile(file: string, bytes: Uint8Array): Promise<void> {
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
