/**
 * cluster.backfillLoose: re-clusters the folders whose files sit in no album.
 * Before files without album tags formed a folder album (QA 2026-10-26 Q-05)
 * cluster.dir left them as loose track rows, and nothing re-clusters a folder
 * until a scan sees it change. Enqueued once at boot; idempotent: a folder it
 * sends gets its album, so the next run no longer finds it.
 *
 * Bounded and paced: at most `limit` folders per run, sent through
 * enqueueReclusters (the parser's singleton key per folder) with startAfter
 * staggered by `perSlot` folders every `slotSeconds`, so a library full of
 * loose files does not land on cluster.dir at once. What is left over is found
 * again by the next boot's run.
 *
 * Files the clusterer leaves loose on purpose are not counted, or every boot
 * would send their folders again: rows not parsed yet (no tags_raw), files
 * without a duration (cluster.dir keeps them loose), files of a handler music
 * does not group, and files with a cluster override (the owner placed them).
 *
 * Plan on 240k files (EXPLAIN ANALYZE): hash anti joins against local_tracks
 * and cluster_overrides over one scan of files, about 0.1 s.
 */
import type { WorkerContext } from '../lib/context.js';
import { MUSIC_HANDLERS } from '../lib/musicFiles.js';
import { enqueueReclusters } from './scanRoot.js';

export interface ClusterBackfillLooseJobData {
  /** folders to send per run (default 2000) */
  limit?: number;
  /** folders per startAfter slot (default 50) */
  perSlot?: number;
  /** seconds between slots (default 10) */
  slotSeconds?: number;
}

export interface ClusterBackfillLooseResult { folders: number; more: boolean }

export async function clusterBackfillLooseJob(
  ctx: WorkerContext, data: ClusterBackfillLooseJobData = {},
): Promise<ClusterBackfillLooseResult> {
  const limit = Math.max(1, data.limit ?? 2000);
  const perSlot = Math.max(1, data.perSlot ?? 50);
  const slotSeconds = Math.max(1, data.slotSeconds ?? 10);
  const rows = (await ctx.sql`
    select distinct af.library_id::text as "libraryId", af.scan_root_id::text as "scanRootId",
           case when strpos(af.rel_path, '/') = 0 then '' else regexp_replace(af.rel_path, '/[^/]*$', '') end as dir
      from files af
     where af.status = 'present'
       and af.tags_raw is not null
       and af.handler = any(${[...MUSIC_HANDLERS]}::text[])
       -- clusterDir keeps a file without a duration loose ((durationMs ?? 0) > 0):
       -- the same rule here, or every boot would send its folder again
       and coalesce(af.duration_ms, 0) > 0
       and not exists (select 1 from local_tracks lt where lt.audio_file_id = af.id and lt.local_album_id is not null)
       and not exists (select 1 from cluster_overrides co where co.audio_file_id = af.id)
     order by 2, 3
     limit ${limit + 1}`) as unknown as Array<{ libraryId: string; scanRootId: string; dir: string }>;
  const more = rows.length > limit;
  const picked = rows.slice(0, limit);
  for (let i = 0; i < picked.length; i += perSlot) {
    const slot = picked.slice(i, i + perSlot);
    const startAfter = 30 + (i / perSlot) * slotSeconds;
    // enqueueReclusters takes one root's folders at a time
    const byRoot = new Map<string, { root: { id: string; libraryId: string }; dirs: string[] }>();
    for (const r of slot) {
      const e = byRoot.get(r.scanRootId) ?? { root: { id: r.scanRootId, libraryId: r.libraryId }, dirs: [] };
      e.dirs.push(r.dir);
      byRoot.set(r.scanRootId, e);
    }
    for (const { root, dirs } of byRoot.values()) await enqueueReclusters(ctx, root, dirs, { startAfter });
  }
  ctx.logger.info({ folders: picked.length, more }, 'cluster.backfillLoose');
  return { folders: picked.length, more };
}
