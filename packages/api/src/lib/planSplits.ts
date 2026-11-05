/**
 * A tag plan that splits first (0089 album_splits.tag_plan_id; vault "tagave
 * - Tag Flow"). When a plan is made for albums, each that is one FLAC holding
 * the whole album (the live rule, @tagave/db › oneFileAlbums: it holds even
 * when Attention's nightly check never ran or the album was identified after
 * the scan) gets its cut points found at once, linked to the plan. Apply
 * splits, then tags the new tracks (tags.apply); Revert undoes both.
 *
 * Owner only, as the album page's Split (system.manage): a split writes the
 * music folder and moves the source into its trash.
 */
import { oneFileAlbums, writableRootIds } from '@tagave/db';
import { lowCuts, type AlbumSplitState, type FilesSplitJobData, type PlanSplit, type SplitPlan } from '@tagave/shared';
import type postgres from 'postgres';
import { getBoss } from '../boss.js';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

async function sendAnalyze(splitId: string): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue('files.split');
  const data: FilesSplitJobData = { splitId, action: 'analyze' };
  await boss.send('files.split', data, { singletonKey: `files.split:${splitId}:analyze` });
}

/**
 * Finds the plan's albums that are one file and links a split to each: one
 * already finding or holding its cut points is taken over, any other gets a
 * new one (its cut points found by the file worker). A split running now is
 * left alone. Returns the albums linked.
 */
export async function ensurePlanSplits(sql: Sql, input: { libraryId: string; planId: string; albumIds: readonly string[]; userId: string }): Promise<string[]> {
  const fits = await oneFileAlbums(sql, input.libraryId, input.albumIds);
  const linked: string[] = [];
  for (const fit of fits) {
    const [latest] = await sql<Array<{ id: string; state: AlbumSplitState; fileId: string | null; tagPlanId: string | null }>>`
      select id::text as id, state, file_id::text as "fileId", tag_plan_id::text as "tagPlanId" from album_splits
       where library_id = ${input.libraryId} and local_album_id = ${fit.albumId}
       order by created_at desc limit 1`;
    if (latest?.state === 'splitting') continue;
    if (latest && (latest.state === 'analyzing' || latest.state === 'ready') && latest.fileId === fit.fileId) {
      await sql`update album_splits set tag_plan_id = ${input.planId}, updated_at = now() where id = ${latest.id}`;
    } else {
      const [row] = await sql<Array<{ id: string }>>`
        insert into album_splits (library_id, local_album_id, file_id, release_id, state, created_by, tag_plan_id)
        values (${input.libraryId}, ${fit.albumId}, ${fit.fileId}, ${fit.releaseId}, 'analyzing', ${input.userId}, ${input.planId})
        returning id::text as id`;
      await sendAnalyze(row!.id);
    }
    linked.push(fit.albumId);
  }
  return linked;
}

/** The plan's splits, the latest per album, with the track count the release gives until the cuts are found. */
export async function planSplitsOf(sql: Sql, planId: string): Promise<PlanSplit[]> {
  const rows = await sql<Array<{
    id: string; albumId: string | null; state: AlbumSplitState; plan: SplitPlan | null; outputs: string[] | null; error: string | null; releaseTracks: number;
  }>>`
    select distinct on (coalesce(s.local_album_id::text, s.id::text))
           s.id::text as id, s.local_album_id::text as "albumId", s.state, s.plan, s.outputs, s.error,
           (select count(*)::int from canonical_tracks c
             where c.release_id = s.release_id and not coalesce(c.is_data_track, false) and not coalesce(c.is_video, false)) as "releaseTracks"
      from album_splits s
     where s.tag_plan_id = ${planId}
     order by coalesce(s.local_album_id::text, s.id::text), s.created_at desc`;
  return rows.map((r) => ({
    splitId: r.id,
    albumId: r.albumId,
    state: r.state,
    tracks: r.plan?.tracks.length ?? r.releaseTracks,
    low: lowCuts(r.plan),
    medium: r.plan ? r.plan.tracks.filter((t) => t.confidence === 'medium').length : 0,
    plan: r.plan,
    outputs: r.outputs,
    error: r.error,
  }));
}

export type SplitGate =
  | { ok: true; splitIds: string[] }
  | { ok: false; status: 409 | 403; detail: string };

/**
 * Whether the plan's splits may run with this Apply: every cut found, the
 * music folder writable, and every Low cut checked by the owner (the ids
 * they confirmed). The splits that will run come back.
 */
export async function splitGate(sql: Sql, libraryId: string, planId: string, confirmed: readonly string[]): Promise<SplitGate> {
  const splits = (await planSplitsOf(sql, planId)).filter((s) => s.state === 'analyzing' || s.state === 'ready');
  if (splits.length === 0) return { ok: true, splitIds: [] };
  if (splits.some((s) => s.state === 'analyzing')) return { ok: false, status: 409, detail: 'Still finding the cut points. Try again in a moment.' };
  const unchecked = splits.filter((s) => s.low > 0 && !confirmed.includes(s.splitId));
  if (unchecked.length > 0) return { ok: false, status: 409, detail: 'Check the Low cuts first.' };
  const albumIds = splits.map((s) => s.albumId).filter((id): id is string => !!id);
  const fits = await oneFileAlbums(sql, libraryId, albumIds);
  const writable = await writableRootIds(sql, libraryId);
  if (fits.some((f) => !writable.has(f.scanRootId))) return { ok: false, status: 403, detail: 'The music folder is read-only' };
  return { ok: true, splitIds: splits.map((s) => s.splitId) };
}

/** Whether any of the plan's splits is still to run (finding cuts, ready, or set going): enqueuing tags.apply would split. */
export async function hasPendingSplits(sql: Sql, planId: string): Promise<boolean> {
  const [r] = await sql<Array<{ n: number }>>`
    select count(*)::int as n from album_splits where tag_plan_id = ${planId} and state in ('analyzing', 'ready', 'splitting')`;
  return (r?.n ?? 0) > 0;
}
