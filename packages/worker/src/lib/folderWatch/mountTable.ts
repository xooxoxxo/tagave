/**
 * The mount table of this process: /proc/self/mountinfo, which the kernel
 * answers from memory (procfs), never a music path, so a dead share cannot
 * block the read. The one file read of the folder watch (watch.ts) and of
 * `checkMusicFolder` (musicFolder.ts); every other look at the share goes
 * through the file gate. Not Linux, or procfs not readable: no table.
 */
import { readFile } from 'node:fs/promises';
import { mountPoints } from '@tagave/shared/mounts';

export const MOUNTINFO = '/proc/self/mountinfo';

/** The table's text; throws where it cannot be read (macOS, tests). */
export function readMountinfo(): Promise<string> {
  return readFile(MOUNTINFO, 'utf8');
}

/** The path without trailing slashes, as mountinfo lists it. */
export function bareDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

/** Whether `dir` (a real path: seen through the parent bind where there is one) is a mount point in the table. */
export function inMountTable(mountinfo: string, dir: string): boolean {
  return mountPoints(mountinfo).has(bareDir(dir));
}
