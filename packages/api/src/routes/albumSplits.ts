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
import { oneFileAlbums, writableRootIds } from '@tagave/db';
import type { AlbumSplitState, AlbumSplitView, FilesSplitJobData, SplitPlan } from '@tagave/shared';
import { getSql } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';

const OWNER = { config: { permission: 'system.manage' as const } };

interface Row {
  id: string; state: AlbumSplitState;
  plan: SplitPlan | null; outputs: string[] | null; error: string | null; createdAt: Date | string; finishedAt: Date | string | null;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

async function sendSplitJob(data: FilesSplitJobData): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue('files.split');
  await boss.send('files.split', data, { singletonKey: `files.split:${data.splitId}:${data.action}` });
}

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
  return {
    split: row ? {
      id: row.id, state: row.state, plan: row.plan, outputs: row.outputs, error: row.error,
      createdAt: iso(row.createdAt), finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    } : null,
    eligible: !!fit,
    writable: fit ? (await writableRootIds(sql, libraryId)).has(fit.scanRootId) : false,
    localTrackId: fit?.localTrackId ?? null,
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
    const current = await latest(libraryId, albumId);
    if (current && (current.state === 'analyzing' || current.state === 'splitting')) {
      reply.status(202);
      return splitView(libraryId, albumId);
    }
    const [row] = await sql<Array<{ id: string }>>`
      insert into album_splits (library_id, local_album_id, file_id, release_id, state, created_by)
      values (${libraryId}, ${albumId}, ${fit.fileId}, ${fit.releaseId}, 'analyzing', ${request.user!.id})
      returning id::text as id`;
    await sendSplitJob({ splitId: row!.id, action: 'analyze' });
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
    const updated = await sql`
      update album_splits set state = 'splitting', created_by = ${request.user!.id}, updated_at = now()
       where id = ${splitId!} and library_id = ${libraryId} and local_album_id = ${albumId} and state = 'ready'
      returning id`;
    if (updated.length === 0) throw new ApiError(409, 'Conflict', 'This plan cannot be split now');
    await sendSplitJob({ splitId: splitId!, action: 'split' });
    reply.status(202);
    return splitView(libraryId, albumId);
  });
}
