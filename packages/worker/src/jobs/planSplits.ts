/**
 * A tag plan that splits first (0089 album_splits.tag_plan_id; vault "tagave
 * - Tag Flow"). An album that is one FLAC holding the whole album is split
 * into its tracks before the plan tags: tags.apply runs each split the API
 * set going ('splitting') with the plan's policy, so the new tracks carry the
 * plan's values; tags.revert undoes them (the source back from the trash, the
 * new tracks into it).
 */
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { TagPolicies } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { exists, markLibraryDirty, onDisk, restoreWaiting, trashDay, trashOne } from '../lib/deletions.js';
import { relDirname } from '../lib/helpers.js';
import { runSplit, type SplitDeps, type SplitRow } from './filesSplit.js';

export interface PlanSplitOutcome {
  done: number;
  failed: number;
  /** tracks the done splits wrote */
  tracks: number;
  /** why the last one stopped */
  error: string | null;
}

/** The plan's splits waiting to run ('splitting'), in the order they were asked for. */
async function splittingRows(ctx: WorkerContext, planId: string): Promise<SplitRow[]> {
  return (await ctx.sql`
    select id::text as id, library_id::text as "libraryId", local_album_id::text as "localAlbumId", state, plan,
           created_by::text as "createdBy"
      from album_splits where tag_plan_id = ${planId} and state = 'splitting'
     order by created_at`) as unknown as SplitRow[];
}

/**
 * Runs the plan's splits before its tags are written: each writes its tracks
 * with the plan's values and moves the source into the trash. A split that
 * stops changes nothing (files.split) and is counted as failed.
 */
export async function runPlanSplits(
  ctx: WorkerContext,
  planId: string,
  policy: TagPolicies,
  deps: Omit<SplitDeps, 'policy'>,
): Promise<PlanSplitOutcome> {
  const out: PlanSplitOutcome = { done: 0, failed: 0, tracks: 0, error: null };
  for (const row of await splittingRows(ctx, planId)) {
    const r = await runSplit(ctx, row, { ...deps, policy });
    if (r['state'] === 'done') {
      out.done++;
      out.tracks += Number(r['tracks'] ?? 0);
    } else {
      out.failed++;
      out.error = typeof r['error'] === 'string' ? r['error'] : 'The split stopped';
    }
  }
  if (out.done + out.failed > 0) ctx.logger.info({ planId, ...out }, 'tags.apply: the plan\'s splits ran');
  return out;
}

interface DoneSplit {
  id: string;
  libraryId: string;
  localAlbumId: string | null;
  fileId: string | null;
  outputs: string[] | null;
  createdBy: string | null;
}

/**
 * Undoes the plan's splits: each new track goes into the trash (as Deleting's
 * Trash moves it; Restore and Empty trash see it), then the source comes back
 * from the trash to where it was, and the folder is scanned again. A track
 * already gone is left; a source whose place is taken stays in the trash
 * (Library care › Deleting says why).
 */
export async function undoSplitsOfPlan(ctx: WorkerContext, planId: string, now = new Date()): Promise<{ tried: number; undone: number }> {
  const rows = (await ctx.sql`
    select id::text as id, library_id::text as "libraryId", local_album_id::text as "localAlbumId",
           file_id::text as "fileId", outputs, created_by::text as "createdBy"
      from album_splits where tag_plan_id = ${planId} and state = 'done'
     order by created_at`) as unknown as DoneSplit[];
  let undone = 0;
  for (const r of rows) {
    if (!r.fileId) continue;
    const [src] = (await ctx.sql`
      select fd.scan_root_id::text as "scanRootId", fd.rel_path as "relPath", fd.trash_rel_path as "trashRelPath", sr.path as root
        from file_deletions fd join scan_roots sr on sr.id = fd.scan_root_id
       where fd.file_id = ${r.fileId} and fd.kind = 'trash' and fd.state = 'trashed'`) as unknown as Array<{ scanRootId: string; relPath: string; trashRelPath: string | null; root: string }>;
    if (!src || !src.trashRelPath || !(await onDisk(src.root, src.trashRelPath))) {
      ctx.logger.warn({ splitId: r.id }, 'tags.revert: the split\'s source is no longer in the trash; its tracks stay');
      continue;
    }
    const day = trashDay(now);
    const trashed: Array<{ rel: string; trashRel: string }> = [];
    for (const rel of r.outputs ?? []) {
      const out = await trashOne(src.root, rel, day);
      if (out.outcome !== 'trashed') continue;
      trashed.push({ rel, trashRel: out.trashRelPath! });
      // a track the scan already knows becomes a trash row, so Restore and Empty trash see it
      await ctx.sql`
        insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, trash_rel_path, created_by, trashed_at)
        select f.id, f.library_id, f.scan_root_id, 'trash', 'trashed', f.rel_path, ${out.trashRelPath!}, ${r.createdBy}, now()
          from files f where f.scan_root_id = ${src.scanRootId} and f.rel_path = ${rel}
        on conflict (file_id) do update set kind = 'trash', state = 'trashed', trash_rel_path = excluded.trash_rel_path, trashed_at = now(), error = null`;
    }
    // the source back where it was (restoreWaiting refuses a taken place)
    await ctx.sql`update file_deletions set state = 'restoring', error = null where file_id = ${r.fileId} and state = 'trashed'`;
    await restoreWaiting(ctx, r.libraryId);
    const back = await exists(path.join(src.root, src.relPath));
    if (!back) {
      // the tracks stay where the owner can hear them: put them back
      for (const t of trashed) await untrash(ctx, src.root, src.scanRootId, t.rel, t.trashRel);
      ctx.logger.warn({ splitId: r.id }, 'tags.revert: the source could not come back; the split stays');
      continue;
    }
    await ctx.sql.begin(async (tx) => {
      await tx`update album_splits set state = 'undone', updated_at = now() where id = ${r.id}`;
      await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
               values (${r.libraryId}, ${r.createdBy}, 'album.split.undone', 'local_album', ${r.localAlbumId},
                       ${JSON.stringify({ splitId: r.id, planId, source: src.relPath, trashed: trashed.map((t) => t.trashRel) })}::jsonb)`;
    });
    undone++;
    const dirPath = relDirname(src.relPath);
    await ctx.boss.send('scan.dir', { scanRootId: src.scanRootId, dirPath, reason: 'split-undone' }, { singletonKey: `scan.dir:${src.scanRootId}:${dirPath}` });
    await markLibraryDirty(ctx, r.libraryId);
  }
  return { tried: rows.length, undone };
}

/** A track moved into the trash a moment ago, back where it was (its trash row dropped). */
async function untrash(ctx: WorkerContext, root: string, scanRootId: string, rel: string, trashRel: string): Promise<void> {
  const from = await onDisk(root, trashRel);
  const to = path.join(root, rel);
  if (!from || (await exists(to))) return;
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  await ctx.sql`delete from file_deletions fd using files f
                 where f.id = fd.file_id and f.scan_root_id = ${scanRootId} and f.rel_path = ${rel} and fd.trash_rel_path = ${trashRel}`;
}
