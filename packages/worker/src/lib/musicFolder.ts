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
 */
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerContext } from './context.js';

/** How many of the root's known files are looked for: one found is enough. */
const SAMPLE = 5;

export type MusicFolderCheck = { reachable: true } | { reachable: false; reason: string };

export const MUSIC_FOLDER_UNREACHABLE = 'music folder unreachable';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The folder is a mount point: on another device than its parent. */
async function isMountPoint(dir: string): Promise<boolean> {
  try {
    const [self, parent] = await Promise.all([stat(dir), stat(path.dirname(dir))]);
    return self.dev !== parent.dev;
  } catch {
    return false;
  }
}

export async function checkMusicFolder(ctx: Pick<WorkerContext, 'sql'>, scanRootId: string, rootPath: string): Promise<MusicFolderCheck> {
  let empty: boolean;
  try {
    if (!(await stat(rootPath)).isDirectory()) return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
    const d = await opendir(rootPath);
    try {
      empty = (await d.read()) === null;
    } finally {
      await d.close().catch(() => undefined);
    }
  } catch {
    return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
  }
  const known = (await ctx.sql`
    select rel_path as "relPath" from files where scan_root_id = ${scanRootId} and status = 'present' limit ${SAMPLE}`) as unknown as Array<{ relPath: string }>;
  if (known.length > 0) {
    for (const f of known) if (await exists(path.join(rootPath, f.relPath))) return { reachable: true };
    return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
  }
  if (!empty || (await isMountPoint(rootPath))) return { reachable: true };
  return { reachable: false, reason: MUSIC_FOLDER_UNREACHABLE };
}
