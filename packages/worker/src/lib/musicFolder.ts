/**
 * Is this process looking at the real music folder? A worker without the
 * music mount still has a path like /mnt/music, or can make one: mkdir -p
 * succeeds on the container's own disk, and the folder it makes reads empty
 * for ever (the drop pool on the identify worker in 0.26.0). So nothing
 * makes a folder inside a music folder before this says yes.
 *
 * Reachable when the root is a readable folder and
 *   - it holds files the library knows: at least one of a few present
 *     files is there (a stray copy of the path holds none of them), or
 *   - the library knows none of its files yet: the folder is not empty,
 *     or it is a mount point of its own (a fresh, empty music share).
 *
 * Every look at the folder goes through the file gate, so a dead share
 * holds a helper, never this process. A folder that is offline (a gate
 * deadline or an offline error code) is not reachable. "Is a mount point"
 * comes from the mount table (/proc/self/mountinfo) for the real path,
 * never from `stat().dev`.
 */
import path from 'node:path';
import type { WorkerContext } from './context.js';
import { fileGate } from './fileGate.js';
import type { DirPage } from './fileHelper.js';
import { FolderOfflineError } from './folderOffline.js';
import { inMountTable, readMountinfo } from './folderWatch/mountTable.js';
import { musicName, realRootPath } from './folderWatch/paths.js';

/** How many of the root's known files are looked for: one found is enough. */
const SAMPLE = 5;

export type MusicFolderCheck = { reachable: true } | { reachable: false; reason: string };

export const MUSIC_FOLDER_UNREACHABLE = 'music folder unreachable';

/**
 * The folder is a mount point of its own: its real path (through the parent
 * bind when TAGAVE_MUSIC_NAME is set) is in the mount table. No table (not
 * Linux, procfs unreadable): not a mount point.
 */
export async function isMountPoint(
  rootPath: string,
  deps: { readMountinfo?: () => Promise<string>; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const real = realRootPath(rootPath.length > 1 ? rootPath.replace(/\/+$/, '') : rootPath, musicName(deps.env ?? process.env));
  try {
    return inMountTable(await (deps.readMountinfo ?? readMountinfo)(), real);
  } catch {
    return false;
  }
}

export async function checkMusicFolder(ctx: Pick<WorkerContext, 'sql'>, scanRootId: string, rootPath: string): Promise<MusicFolderCheck> {
  const gate = fileGate();
  let empty: boolean;
  try {
    if (!(await gate.run<{ isDirectory: boolean }>(scanRootId, { op: 'stat', path: rootPath })).isDirectory) {
      return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
    }
    empty = (await gate.run<DirPage>(scanRootId, { op: 'readdirPage', path: rootPath, limit: 1 })).entries.length === 0;
  } catch {
    return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
  }
  const known = (await ctx.sql`
    select rel_path as "relPath" from files where scan_root_id = ${scanRootId} and status = 'present' limit ${SAMPLE}`) as unknown as Array<{ relPath: string }>;
  if (known.length > 0) {
    for (const f of known) {
      try {
        await gate.run(scanRootId, { op: 'stat', path: path.join(rootPath, f.relPath) });
        return { reachable: true };
      } catch (err) {
        // offline: no other file will answer either
        if (err instanceof FolderOfflineError) break;
        // gone or unreadable: not this one
      }
    }
    return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
  }
  if (!empty || (await isMountPoint(rootPath))) return { reachable: true };
  return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
}
