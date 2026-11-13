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
import { latestMaintenanceTask, oneFileAlbums, restartMaintenanceTask, saveMaintenanceTask, writableRootIds, type OneFileAlbum } from '@tagave/db';
import { lowCuts, type AlbumSplitState, type MaintenanceTaskView, type PlanSplit, type SplitPlan } from '@tagave/shared';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { dispatchMaintenance, liveMaintenanceQueues, maintenanceView } from './maintenance.js';
import { workerServesQueue } from '@tagave/core';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

async function legacyAnalysisActive(sql: Sql, splitId: string): Promise<boolean> {
  const [schema] = await sql<{ exists: boolean }[]>`select to_regclass('pgboss.job') is not null as exists`;
  if (!schema?.exists) return false;
  const [job] = await sql<{ id: string }[]>`
    select id from pgboss.job where name = 'files.split' and data->>'splitId' = ${splitId}
      and data->>'action' = 'analyze' and not (data ? 'maintenance')
      and state in ('created', 'retry', 'active') limit 1`;
  return !!job;
}

export async function analysisStatus(sql: Sql, libraryId: string, row: { id: string; state: AlbumSplitState; plan: SplitPlan | null; error: string | null }): Promise<{ state: AlbumSplitState; error: string | null; task?: MaintenanceTaskView; waitingForWorker?: boolean; retryAnalysis?: boolean }> {
  const current = { state: row.state, error: row.error };
  if (row.plan && (row.state === 'splitting' || row.state === 'failed' || row.state === 'done')) {
    const task = await latestMaintenanceTask(sql, libraryId, 'split', `${row.id}:split`);
    if (task && task.state !== 'done') return { ...current, task: maintenanceView(task, await liveMaintenanceQueues()) };
  }
  if (row.plan || (row.state !== 'analyzing' && row.state !== 'failed')) return current;
  const [task, queues] = await Promise.all([
    latestMaintenanceTask(sql, libraryId, 'split', `${row.id}:analyze`),
    liveMaintenanceQueues(),
  ]);
  if (task) {
    const view = maintenanceView(task, queues);
    const stopped = task.state === 'failed' || task.state === 'interrupted' || task.state === 'review';
    return { ...current, state: (stopped ? 'failed' : 'analyzing') as AlbumSplitState, error: view.error, task: view };
  }
  if (row.state === 'analyzing' && await legacyAnalysisActive(sql, row.id)) {
    return { ...current, waitingForWorker: !workerServesQueue(queues, 'files.split') };
  }
  return { ...current, state: 'failed' as const, error: row.error ?? 'Cut point analysis stopped before it finished.', retryAnalysis: true };
}

/** Serialize standalone and plan requests so both keep the same split and attempt. */
export async function requestSplitAnalysis(sql: postgres.Sql, input: {
  libraryId: string; fit: OneFileAlbum; userId: string; planId?: string;
}, logger: FastifyBaseLogger): Promise<boolean> {
  const { libraryId, fit, userId, planId } = input;
  const result = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`tagave:split:${libraryId}:${fit.albumId}`}, 0))`;
    const [latest] = await tx<{ id: string; state: AlbumSplitState; fileId: string | null; releaseId: string | null; plan: SplitPlan | null }[]>`
      select id, state, file_id as "fileId", release_id as "releaseId", plan from album_splits
      where library_id = ${libraryId} and local_album_id = ${fit.albumId} order by created_at desc limit 1`;
    if (latest?.state === 'splitting') return { linked: false };
    let splitId: string;
    if (latest && latest.fileId === fit.fileId && latest.releaseId === fit.releaseId &&
        (latest.state === 'analyzing' || (latest.state === 'failed' && !latest.plan) || (planId && latest.state === 'ready'))) {
      splitId = latest.id;
      if (planId) await tx`update album_splits set tag_plan_id = ${planId}, updated_at = now() where id = ${splitId}`;
      if (latest.state === 'ready' || await legacyAnalysisActive(tx, splitId)) return { linked: true };
    } else {
      const [row] = await tx<{ id: string }[]>`
        insert into album_splits (library_id, local_album_id, file_id, release_id, state, created_by, tag_plan_id)
        values (${libraryId}, ${fit.albumId}, ${fit.fileId}, ${fit.releaseId}, 'analyzing', ${userId}, ${planId ?? null}) returning id`;
      splitId = row!.id;
    }
    const task = await saveMaintenanceTask(tx, {
      libraryId, kind: 'split', scope: `${splitId}:analyze`, subjectId: fit.albumId,
      queue: 'files.split', input: { splitId, action: 'analyze' }, stage: 'Cut point analysis queued',
    });
    if (!planId && (task.state === 'failed' || task.state === 'interrupted')) {
      await restartMaintenanceTask(tx, libraryId, task.id, task.attempt);
    }
    return { linked: true, taskId: task.id };
  });
  if (result.taskId) await dispatchMaintenance(result.taskId, logger);
  return result.linked;
}

export async function ensurePlanSplits(sql: postgres.Sql, input: { libraryId: string; planId: string; albumIds: readonly string[]; userId: string }, logger: FastifyBaseLogger): Promise<string[]> {
  const fits = await oneFileAlbums(sql, input.libraryId, input.albumIds);
  const linked: string[] = [];
  for (const fit of fits) {
    if (await requestSplitAnalysis(sql, { ...input, fit }, logger)) linked.push(fit.albumId);
  }
  return linked;
}

/** The plan's splits, the latest per album, with the track count the release gives until the cuts are found. */
export async function planSplitsOf(sql: Sql, planId: string): Promise<PlanSplit[]> {
  const rows = await sql<Array<{
    id: string; libraryId: string; albumId: string | null; state: AlbumSplitState; plan: SplitPlan | null; outputs: string[] | null; error: string | null; releaseTracks: number;
  }>>`
    select distinct on (coalesce(s.local_album_id::text, s.id::text))
           s.id::text as id, s.library_id as "libraryId", s.local_album_id::text as "albumId", s.state, s.plan, s.outputs, s.error,
           (select count(*)::int from canonical_tracks c
             where c.release_id = s.release_id and not coalesce(c.is_data_track, false) and not coalesce(c.is_video, false)) as "releaseTracks"
      from album_splits s
     where s.tag_plan_id = ${planId}
     order by coalesce(s.local_album_id::text, s.id::text), s.created_at desc`;
  return Promise.all(rows.map(async (r) => {
    const status = await analysisStatus(sql, r.libraryId, r);
    return {
      ...status,
      splitId: r.id,
      albumId: r.albumId,
      tracks: r.plan?.tracks.length ?? r.releaseTracks,
      low: lowCuts(r.plan),
      medium: r.plan?.tracks.filter((t) => t.confidence === 'medium').length ?? 0,
      plan: r.plan,
      outputs: r.outputs,
    };
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
  const all = await planSplitsOf(sql, planId);
  if (all.some((s) => s.state === 'failed' && !s.plan)) return { ok: false, status: 409, detail: 'Retry the stopped cut point analysis before applying.' };
  const splits = all.filter((s) => s.state === 'analyzing' || s.state === 'ready');
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
    select count(*)::int as n from album_splits where tag_plan_id = ${planId} and (state in ('analyzing', 'ready', 'splitting') or (state = 'failed' and plan is null))`;
  return (r?.n ?? 0) > 0;
}
