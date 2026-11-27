/**
 * The checks a split, an upgrade or a trash action makes before it publishes,
 * moves or deletes a file on a music share: all through the file gate
 * (gatedPaths.ts), so the main process never touches the share. A dead share
 * throws FolderOfflineError for the root; a failed helper or a closed gate
 * throws its own error. Neither reads as a file that is not there.
 */
import { gateDigest, gateInsideRoot, gateLstat, gateMountIdentity, type GateStat } from './gatedPaths.js';

export type { GateStat };

/** lstat of a file under the root; null when it is not there (ENOENT and its kin). */
export function fileStat(rootId: string, file: string): Promise<GateStat | null> {
  return gateLstat(rootId, file);
}

/** The sha256 of a regular file under the root. */
export function fileDigest(rootId: string, file: string): Promise<string> {
  return gateDigest(rootId, file);
}

/** The root's real path, device and inode: a mount that changed reads different. */
export function mountIdentity(rootId: string, root: string): Promise<string> {
  return gateMountIdentity(rootId, root);
}

/** Rejects redirected paths before moving, publishing or deleting a file. Both sides are real paths. */
export function insideRoot(rootId: string, root: string, file: string): Promise<void> {
  return gateInsideRoot(rootId, root, file);
}

/** The same file: device and inode (a hard link of it counts). */
export function sameFile(a: GateStat | null, b: GateStat | null): boolean {
  return !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}
