/**
 * Whole album in one file (0078 album_splits): the album page's and Library
 * care › Attention's Split. Owner only (system.manage): a split writes the
 * music folder and moves the source into its trash. The API never touches a
 * music file; the file worker (files.split) finds the cut points and splits.
 *
 *   GET  /libraries/:libraryId/albums/:albumId/split              AlbumSplitView
 *   POST /libraries/:libraryId/albums/:albumId/split              find the cut points (a new plan)
 *   POST /libraries/:libraryId/albums/:albumId/split/:splitId/run split as planned (the folder must be writable: 409)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { oneFileAlbums, saveMaintenanceTask, writableRootIds } from '@tagave/db';
import { splitCutsSchema, withSplitCuts, type AlbumSplitState, type AlbumSplitView, type SplitPlan } from '@tagave/shared';
import { z } from 'zod';
import { getSql } from '../db.js';
import { analysisStatus, requestSplitAnalysis } from '../lib/planSplits.js';
import { dispatchMaintenance } from '../lib/maintenance.js';
import { ApiError } from '../middleware/errorHandler.js';

const OWNER = { config: { permission: 'system.manage' as const } };

interface Row {
  id: string; state: AlbumSplitState;
  plan: SplitPlan | null; outputs: string[] | null; error: string | null; createdAt: Date | string; finishedAt: Date | string | null;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

async function latest(libraryId: string, albumId: string): Promise<Row | null> {
  const [r] = await getSql()<Row[]>`
    select id::text as id, state, plan, outputs, error, created_at as "createdAt", finished_at as "finishedAt"
      from album_splits where library_id = ${libraryId} and local_album_id = ${albumId}
     order by created_at desc limit 1`;
  return r ?? null;
}

export async function splitView(libraryId: string, albumId: string): Promise<AlbumSplitView> {
  const sql = getSql();
  const [fit] = await oneFileAlbums(sql, libraryId, albumId);
  const row = await latest(libraryId, albumId);
  const status = row ? await analysisStatus(sql, libraryId, row) : null;
  return {
    split: row ? {
      ...status!, id: row.id, plan: row.plan, outputs: row.outputs,
      createdAt: iso(row.createdAt), finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    } : null,
    eligible: !!fit,
    writable: fit ? (await writableRootIds(sql, libraryId)).has(fit.scanRootId) : false,
    localTrackId: fit?.localTrackId ?? null,
    tracks: fit?.tracks ?? null,
  };
}

const paramsOf = (request: FastifyRequest) => request.params as { libraryId: string; albumId: string; splitId?: string };

export async function createAlbumSplitRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/albums/:albumId/split', OWNER, async (request) => {
    const { libraryId, albumId } = paramsOf(request);
    return splitView(libraryId, albumId);
  });

  /** A new plan: the worker finds the cut points. One being found already is kept. */
  fastify.post('/libraries/:libraryId/albums/:albumId/split', OWNER, async (request, reply) => {
    const { libraryId, albumId } = paramsOf(request);
    const sql = getSql();
    const [fit] = await oneFileAlbums(sql, libraryId, albumId);
    if (!fit) throw new ApiError(409, 'Conflict', 'This album is not one file that fits its release');
    await requestSplitAnalysis(sql, { libraryId, fit, userId: request.user!.id }, request.log);
    reply.status(202);
    return splitView(libraryId, albumId);
  });

  /** Split as planned: the plan must be ready and the music folder writable. */
  fastify.post('/libraries/:libraryId/albums/:albumId/split/:splitId/run', OWNER, async (request, reply) => {
    const { libraryId, albumId, splitId } = paramsOf(request);
    const sql = getSql();
    const [fit] = await oneFileAlbums(sql, libraryId, albumId);
    if (!fit) throw new ApiError(409, 'Conflict', 'This album is not one file that fits its release');
    if (!(await writableRootIds(sql, libraryId)).has(fit.scanRootId)) throw new ApiError(409, 'Conflict', 'The music folder is read-only');
    const body = z.object({ cuts: splitCutsSchema.optional() }).safeParse(request.body ?? {});
    if (!body.success) throw new ApiError(400, 'Bad Request', 'Invalid cut positions');
    const task = await sql.begin(async (tx) => {
      const [row] = await tx<{ plan: SplitPlan | null }[]>`
        select plan from album_splits
         where id = ${splitId!} and library_id = ${libraryId} and local_album_id = ${albumId}
           and file_id = ${fit.fileId} and release_id = ${fit.releaseId} and state = 'ready'
           and id = (select id from album_splits where library_id = ${libraryId} and local_album_id = ${albumId}
                      order by created_at desc limit 1)
         for update`;
      if (!row?.plan) throw new ApiError(409, 'Conflict', 'This plan cannot be split now');
      const plan = withSplitCuts(row.plan, body.data.cuts ?? []);
      if (!plan) throw new ApiError(400, 'Bad Request', 'Cuts must stay between the preceding and following track starts');
      await tx`update album_splits set state = 'splitting', plan = ${JSON.stringify(plan)}::text::jsonb,
                 created_by = ${request.user!.id}, updated_at = now() where id = ${splitId!}`;
      return saveMaintenanceTask(tx, {
        libraryId, kind: 'split', scope: `${splitId}:split`, subjectId: albumId,
        queue: 'files.split', input: { splitId: splitId!, action: 'split' }, stage: 'Split queued',
      });
    });
    await dispatchMaintenance(task.id, request.log);
    reply.status(202);
    return splitView(libraryId, albumId);
  });
}
