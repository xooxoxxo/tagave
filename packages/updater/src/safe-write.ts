/**
 * Every file the updater writes in the install folder goes through here.
 *
 * The updater runs as root inside its container, so a plain write leaves a
 * root-owned file behind and the install's owner can no longer edit .env or
 * the compose files. These helpers give each file the owner, group and mode
 * of the file it replaces; a file that did not exist yet gets the owner and
 * group of its folder and the fallback mode. The write itself is atomic: a
 * temp file in the same folder, fsynced, chowned and chmodded, then renamed
 * over the original, and the folder fsynced so the rename survives a crash.
 * A symlink (an .env linked from elsewhere) stays a symlink: the file it
 * points to is the one replaced.
 */
import * as nodeFs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** The parts of node:fs/promises used here, injectable for the tests. */
export interface SafeWriteFs {
  stat: (path: string) => Promise<{ uid: number; gid: number; mode: number }>;
  open: typeof nodeFs.open;
  chown: (path: string, uid: number, gid: number) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  mkdir: (path: string, opts: { mode: number }) => Promise<unknown>;
  realpath: (path: string) => Promise<string>;
}

const realFs: SafeWriteFs = nodeFs;

export interface Ownership {
  uid: number;
  gid: number;
  mode: number;
}

export interface SafeWriteOptions {
  /** Mode for a file that does not exist yet (default 0644). */
  fallbackMode?: number;
  /** Take owner and mode from this file instead of the one being replaced (a .bak copies its original). */
  ownerFrom?: string;
  fs?: SafeWriteFs;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The owner and mode `path` should end up with. */
export async function ownershipFor(path: string, fallbackMode = 0o644, fs: SafeWriteFs = realFs, ownerFrom?: string): Promise<Ownership> {
  try {
    const s = await fs.stat(ownerFrom ?? path);
    return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  const dir = await fs.stat(dirname(path));
  return { uid: dir.uid, gid: dir.gid, mode: fallbackMode };
}

/**
 * chown as root always works; as anyone else it only works towards a group
 * the process is in. Not root and refused: the file stays ours, which is what
 * a plain write would have done, so that is not an error.
 */
async function applyOwner(fs: SafeWriteFs, path: string, o: Ownership): Promise<void> {
  try {
    await fs.chown(path, o.uid, o.gid);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    if (root || (code !== 'EPERM' && code !== 'EINVAL')) throw err;
  }
  await fs.chmod(path, o.mode);
}

/** The file a write to `path` replaces: symlinks followed; the path itself when nothing is there yet. */
async function resolveTarget(fs: SafeWriteFs, path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (err) {
    if (isMissing(err)) return path;
    throw err;
  }
}

/** fsyncs a folder, so a rename in it is on disk. Some platforms refuse to fsync a folder; that is not an error. */
async function syncDir(fs: SafeWriteFs, dir: string): Promise<void> {
  let fh: nodeFs.FileHandle | undefined;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM') throw err;
  } finally {
    await fh?.close();
  }
}

/** Writes `content` to `path` atomically, keeping the owner and mode of what was there. */
export async function writeFileKeepingOwner(path: string, content: string | Uint8Array, opts: SafeWriteOptions = {}): Promise<void> {
  const fs = opts.fs ?? realFs;
  const target = await resolveTarget(fs, path);
  const owner = await ownershipFor(target, opts.fallbackMode, fs, opts.ownerFrom);
  const tmp = join(dirname(target), `.${basename(target)}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`);
  // 0600 until the chown: a private temp file never shows .env to anyone else.
  const fh = await fs.open(tmp, 'wx', 0o600);
  try {
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await applyOwner(fs, tmp, owner);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  await syncDir(fs, dirname(target));
}

/** mkdir -p for one level, the new folder owned like its parent; an existing folder is left as it is. */
export async function mkdirKeepingOwner(path: string, mode: number, opts: { fs?: SafeWriteFs } = {}): Promise<void> {
  const fs = opts.fs ?? realFs;
  try {
    await fs.stat(path);
    return;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  const parent = await fs.stat(dirname(path));
  try {
    await fs.mkdir(path, { mode });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw err;
  }
  await applyOwner(fs, path, { uid: parent.uid, gid: parent.gid, mode });
}
