import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export async function fileStat(file: string) {
  try {
    return await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function fileDigest(file: string): Promise<string> {
  if (!(await fileStat(file))?.isFile()) throw new Error(`Expected a regular file at ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function mountIdentity(root: string): Promise<string> {
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error('The music folder is unavailable');
  return JSON.stringify([await realpath(root), info.dev, info.ino]);
}

/** Reject redirected paths before moving, publishing or deleting a file. */
export async function insideRoot(root: string, file: string): Promise<void> {
  const isOutside = (base: string, target: string) => {
    const rel = path.relative(base, target);
    return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  };
  if (isOutside(root, file)) throw new Error('The file path leaves its music folder');
  const base = await realpath(root);
  let parent = path.dirname(file);
  while (!(await fileStat(parent))) parent = path.dirname(parent);
  if (isOutside(base, await realpath(parent))) throw new Error('The file path leaves its music folder');
}
