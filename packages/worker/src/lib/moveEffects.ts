/**
 * What a merge drags along (move-safe scanning §1): sidecar covers (this
 * task), the player's song map (Task 14).
 */
import type { WorkerContext } from './context.js';
import { escapeLike, normKey } from './helpers.js';
import { sqlDirname, type MoveRecord } from './reconcile.js';

interface SidecarRow { id: string; rel_path: string }

const childPrefix = (dir: string) => (dir === '' ? '' : dir + '/');

/** Sidecars directly in one folder (not in its subfolders); `withImages` keeps only those an image points at. */
async function sidecarsIn(ctx: Pick<WorkerContext, 'sql'>, rootId: string, dir: string, withImages: boolean): Promise<SidecarRow[]> {
  const prefix = childPrefix(dir);
  return (await ctx.sql`
    select s.id, s.rel_path from sidecar_files s
     where s.scan_root_id = ${rootId}
       and (${prefix} = '' or s.rel_path like ${escapeLike(prefix) + '%'})
       and ${ctx.sql.unsafe(sqlDirname('s'))} = ${dir}
       and (${!withImages} or exists (select 1 from images i where i.sidecar_file_id = s.id))`) as unknown as SidecarRow[];
}

/** Groups sidecars by normKey-folded file name (the archive mixes NFC/NFD and case). */
function byName(rows: SidecarRow[], dir: string): Map<string, SidecarRow[]> {
  const cut = childPrefix(dir).length;
  const out = new Map<string, SidecarRow[]>();
  for (const r of rows) {
    const k = normKey(r.rel_path.slice(cut));
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

/**
 * Images of sidecars directly in each old folder move to the same-named
 * sidecar in the new folder (spec §1, R5/R6), so the stale old sidecar can
 * later be dropped without its cover (the 0052 cascade). Names compare by
 * normKey; when the fold is ambiguous on either side (two candidates), that
 * name is left alone: the image stays on the old sidecar, which Ruling 9 keeps
 * while its folder still has missing rows. Runs inside runMerges, so Tier 1
 * (finishWalk) and Tier 2 (hold release) both re-point before any drop.
 * Returns the number of images re-pointed.
 */
export async function repointSidecarImages(ctx: Pick<WorkerContext, 'sql'>, moves: MoveRecord[]): Promise<number> {
  let moved = 0;
  for (const m of moves) {
    if (m.fromRootId === m.toRootId && m.fromDir === m.toDir) continue; // same folder: same sidecar rows
    const olds = await sidecarsIn(ctx, m.fromRootId, m.fromDir, true);
    if (olds.length === 0) continue;
    const news = byName(await sidecarsIn(ctx, m.toRootId, m.toDir, false), m.toDir);
    for (const [name, group] of byName(olds, m.fromDir)) {
      const target = news.get(name);
      if (group.length !== 1 || !target || target.length !== 1) continue;
      const r = await ctx.sql`
        update images set sidecar_file_id = ${target[0]!.id}
         where sidecar_file_id = ${group[0]!.id}
        returning id`;
      moved += r.length;
    }
  }
  return moved;
}
