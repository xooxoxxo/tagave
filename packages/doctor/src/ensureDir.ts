/**
 * `mkdir -p` that always settles. Node's `fs.mkdir(dir, { recursive: true })`
 * never settles (and spins a CPU) when the parent exists but the kernel
 * answers ENOENT for the child, as /proc does on Linux, so a BACKUP_DIR or
 * CACHE_DIR such as /proc/backups would hang the doctor and the health
 * endpoint that runs it. Creating one segment at a time with a plain mkdir
 * turns every such case into an ordinary error.
 */
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  const target = path.resolve(dir);
  const { root } = path.parse(target);
  let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await mkdir(current);
    } catch (err) {
      // An existing file here surfaces as ENOTDIR on the next segment or on
      // the caller's first write into it, as with recursive mkdir.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // Some mounts (read-only, NFS with root squash) answer EROFS or EACCES
      // for a folder that already exists; that folder is fine to walk through.
      const existing = await stat(current).catch(() => null);
      if (!existing?.isDirectory()) throw err;
    }
  }
}
