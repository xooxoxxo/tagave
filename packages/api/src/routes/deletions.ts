/**
 * Deleting songs and albums (0073): Settings › Library › Deleting and
 * Library care › Deleting. Owner only (system.manage): a deletion reaches the
 * music folder itself.
 *
 *   GET  /libraries/:libraryId/deletions/mode         { mode, trashAvailable }
 *   PUT  /libraries/:libraryId/deletions/mode         { mode }  (Trash needs a writable root: 409)
 *   GET  /libraries/:libraryId/deletions              DeletingView
 *   POST /libraries/:libraryId/deletions              { trackIds?, albumIds? } in the library's mode
 *   POST /libraries/:libraryId/deletions/unmark       { fileIds }
 *   POST /libraries/:libraryId/deletions/restore      { fileIds }
 *   POST /libraries/:libraryId/deletions/empty-trash
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createDeletionsSchema, deleteModeUpdateSchema, deletionFilesSchema, emptyTrashSchema } from '@tagave/shared';
import type { z } from 'zod';
import { getDb, getSql } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';
import { markFilterCountsDirty } from '../lib/filterCounts.js';
import { bustFilterCountsCache } from './albums.js';
import { dispatchMaintenance, liveMaintenanceQueues, maintenanceView } from '../lib/maintenance.js';
import { albumsChanged } from '../lib/albumCare.js';
import {
  createDeletions, deleteModeOf, deletingView, librarySettings, restoreFiles, requestEmptyTrash, trashRootIds, unmarkFiles,
} from '../lib/deletions.js';

const OWNER = { config: { permission: 'system.manage' as const } };

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  return parsed.data;
}

async function settingsOf(libraryId: string): Promise<Record<string, unknown>> {
  const settings = await librarySettings(getSql(), libraryId);
  if (!settings) throw new ApiError(404, 'Not Found', 'Library not found');
  return settings;
}

/** The library's views and counts change with every deletion. */
async function changed(libraryId: string): Promise<void> {
  bustFilterCountsCache(libraryId);
  await markFilterCountsDirty(getDb(), libraryId);
}

/** The albums these files belong to (Library care rechecks them: a deleted album's problems go). */
async function albumsOfFiles(fileIds: readonly string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await getSql()<Array<{ id: string }>>`
    select distinct local_album_id::text as id from local_tracks
     where audio_file_id = any(${fileIds as string[]}::uuid[]) and local_album_id is not null`;
  return rows.map((r) => r.id);
}

async function albumsOfSelection(libraryId: string, trackIds: string[], albumIds: string[]): Promise<string[]> {
  const rows = await getSql()<Array<{ id: string }>>`
    select distinct lt.local_album_id::text as id from local_tracks lt join local_albums la on la.id = lt.local_album_id
     where la.library_id = ${libraryId} and (lt.id = any(${trackIds}::uuid[]) or lt.local_album_id = any(${albumIds}::uuid[]))`;
  return rows.map((r) => r.id);
}

const libraryOf = (request: FastifyRequest) => (request.params as { libraryId: string }).libraryId;

export async function createDeletionRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/deletions/mode', OWNER, async (request) => {
    const libraryId = libraryOf(request);
    const settings = await settingsOf(libraryId);
    return { mode: deleteModeOf(settings), trashAvailable: (await trashRootIds(getSql(), libraryId)).size > 0 };
  });

  fastify.put('/libraries/:libraryId/deletions/mode', OWNER, async (request) => {
    const libraryId = libraryOf(request);
    const { mode } = parse(deleteModeUpdateSchema, request.body);
    await settingsOf(libraryId);
    const sql = getSql();
    const trashAvailable = (await trashRootIds(sql, libraryId)).size > 0;
    if (mode === 'trash' && !trashAvailable) throw new ApiError(409, 'Conflict', 'No music folder is writable');
    await sql`update libraries set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{deleteMode}', to_jsonb(${mode}::text)) where id = ${libraryId}`;
    return { mode, trashAvailable };
  });

  fastify.get('/libraries/:libraryId/deletions', OWNER, async (request) => {
    const libraryId = libraryOf(request);
    return deletingView(getSql(), libraryId, await settingsOf(libraryId));
  });

  fastify.post('/libraries/:libraryId/deletions', OWNER, async (request, reply) => {
    const libraryId = libraryOf(request);
    const body = parse(createDeletionsSchema, request.body);
    const settings = await settingsOf(libraryId);
    const result = await createDeletions(getSql(), {
      libraryId, userId: request.user!.id, mode: deleteModeOf(settings),
      trackIds: body.trackIds ?? [], albumIds: body.albumIds ?? [],
    });
    await changed(libraryId);
    await albumsChanged(libraryId, await albumsOfSelection(libraryId, body.trackIds ?? [], body.albumIds ?? []), request.log);
    reply.status(201);
    return result;
  });

  fastify.post('/libraries/:libraryId/deletions/unmark', OWNER, async (request) => {
    const libraryId = libraryOf(request);
    const { fileIds } = parse(deletionFilesSchema, request.body);
    const unmarked = await unmarkFiles(getSql(), libraryId, fileIds);
    await changed(libraryId);
    await albumsChanged(libraryId, await albumsOfFiles(fileIds), request.log);
    return { unmarked };
  });

  fastify.post('/libraries/:libraryId/deletions/restore', OWNER, async (request) => {
    const libraryId = libraryOf(request);
    const { fileIds } = parse(deletionFilesSchema, request.body);
    return { restoring: await restoreFiles(getSql(), libraryId, fileIds) };
  });

  fastify.post('/libraries/:libraryId/deletions/empty-trash', { ...OWNER, bodyLimit: 4_000_050 }, async (request, reply) => {
    const libraryId = libraryOf(request);
    await settingsOf(libraryId);
    const { fileIds } = parse(emptyTrashSchema, request.body);
    const task = await requestEmptyTrash(getSql(), libraryId, fileIds);
    await dispatchMaintenance(task.id, request.log);
    return reply.status(202).send(maintenanceView(task, await liveMaintenanceQueues()));
  });
}
