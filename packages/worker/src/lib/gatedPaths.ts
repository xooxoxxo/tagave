/**
 * Path checks on a music share, through the file gate (fileGate.ts): the
 * gated forms of deletions.ts `exists`/`onDisk` and fileRecovery.ts
 * `fileStat`/`mountIdentity`/`insideRoot`. A dead share throws
 * FolderOfflineError for the root, and a failed helper or a closed gate
 * throws its own error: neither ever reads as "not there".
 */
import path from 'node:path';
import { fileGate } from './fileGate.js';
import type { DirPage } from './fileHelper.js';
import { isAbsent, isGateFailure, isOfflineError } from './folderOffline.js';

/** What the helper answers for a stat or lstat. */
export interface GateStat {
  size: number | bigint;
  mtimeMs: number | bigint;
  ino: number | bigint;
  dev: number | bigint;
  mode: number | bigint;
  isFile: boolean;
  isDirectory: boolean;
}

/** lstat through the gate; null when the path is not there (ENOENT and its kin). */
export async function gateLstat(rootId: string, abs: string): Promise<GateStat | null> {
  try {
    return await fileGate().run<GateStat>(rootId, { op: 'lstat', path: abs });
  } catch (err) {
    if (isAbsent(err)) return null;
    throw err;
  }
}

/** stat (links followed) through the gate; null when the path is not there. */
export async function gateStat(rootId: string, abs: string): Promise<GateStat | null> {
  try {
    return await fileGate().run<GateStat>(rootId, { op: 'stat', path: abs });
  } catch (err) {
    if (isAbsent(err)) return null;
    throw err;
  }
}

/** True when something is at the path. Any answer but offline or a gate failure that is not a stat reads as no (as `exists`). */
export async function gateExists(rootId: string, abs: string): Promise<boolean> {
  try {
    await fileGate().run(rootId, { op: 'lstat', path: abs });
    return true;
  } catch (err) {
    if (isOfflineError(err) || isGateFailure(err)) throw err;
    return false;
  }
}

/** The path on disk of a relative path, trying the NFC and NFD spellings (as deletions.ts `onDisk`). */
export async function gateOnDisk(rootId: string, root: string, relPath: string): Promise<string | null> {
  for (const cand of new Set([relPath, relPath.normalize('NFD'), relPath.normalize('NFC')])) {
    const p = path.join(root, cand);
    if (await gateExists(rootId, p)) return p;
  }
  return null;
}

/** Every entry of a folder, page by page. A folder that is not there throws its absent code (ENOENT). */
export async function gateReaddir(rootId: string, abs: string): Promise<DirPage['entries']> {
  const out: DirPage['entries'] = [];
  let cursor: string | null = null;
  do {
    const page: DirPage = await fileGate().run<DirPage>(rootId, { op: 'readdirPage', path: abs, cursor });
    out.push(...page.entries);
    cursor = page.cursor;
  } while (cursor !== null);
  return out;
}

/** True when the folder holds nothing (one page of at most one entry). */
export async function gateDirEmpty(rootId: string, abs: string): Promise<boolean> {
  const page = await fileGate().run<DirPage>(rootId, { op: 'readdirPage', path: abs, limit: 1 });
  return page.entries.length === 0;
}

/** The sha256 of a regular file, read in a helper. */
export async function gateDigest(rootId: string, abs: string): Promise<string> {
  return fileGate().run<string>(rootId, { op: 'digest', path: abs });
}

/** The root's identity (as fileRecovery.ts `mountIdentity`): its real path, device and inode. */
export async function gateMountIdentity(rootId: string, root: string): Promise<string> {
  const info = await fileGate().run<GateStat>(rootId, { op: 'stat', path: root });
  if (!info.isDirectory) throw new Error('The music folder is unavailable');
  const real = await fileGate().run<string>(rootId, { op: 'realpath', path: root });
  return JSON.stringify([real, Number(info.dev), Number(info.ino)]);
}

const isOutside = (base: string, target: string): boolean => {
  const rel = path.relative(base, target);
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
};

/**
 * Rejects redirected paths before moving, publishing or deleting a file (as
 * fileRecovery.ts `insideRoot`). Both sides are real paths (the gate's
 * realpath): the root's, and the nearest folder of the file that is there,
 * with the rest of the file's path after it. A root that is a symlink stays
 * inside itself, and a link inside the root that leads out is refused.
 */
export async function gateInsideRoot(rootId: string, root: string, file: string): Promise<void> {
  // `..` would fold away before the links on the way resolve (root/Away/../x with Away leading out): never taken
  if (file.split(/[\\/]+/).includes('..')) throw new Error('The file path leaves its music folder');
  const target = path.resolve(file);
  const top = path.resolve(root);
  const base = await fileGate().run<string>(rootId, { op: 'realpath', path: top });
  if (target === top) return;
  let parent = path.dirname(target);
  // never above the root: the root itself resolves to `base`
  while (parent !== top && !(await gateLstat(rootId, parent))) {
    const up = path.dirname(parent);
    if (up === parent) break;
    parent = up;
  }
  const real = await fileGate().run<string>(rootId, { op: 'realpath', path: parent });
  if (isOutside(base, path.join(real, path.relative(parent, target)))) {
    throw new Error('The file path leaves its music folder');
  }
}
