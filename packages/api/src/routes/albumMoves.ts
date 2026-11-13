/**
 * Move to album (0080 album_moves): the album page's Maintenance › Move to
 * album and Library care › Moved. Owner only (system.manage): a move writes
 * the music folder, as Trash and Split do. The API never touches a music
 * file; the file worker (files.move) searches, plans, moves and undoes.
 *
 *   GET  /libraries/:libraryId/moves                       MoveListItem[] (finished moves)
 *   GET  /libraries/:libraryId/moves/albums?q=             MoveAlbumOption[] (the picker)
 *   POST /libraries/:libraryId/albums/:albumId/moves       { trackIds, target }: a new move
 *   GET  /libraries/:libraryId/moves/:moveId               AlbumMoveView
 *   POST /libraries/:libraryId/moves/:moveId/target        { target }: another target (before Move)
 *   POST /libraries/:libraryId/moves/:moveId/run           Move as planned (409: read-only folder, tag writes off, a name taken)
 *   POST /libraries/:libraryId/moves/:moveId/undo          put it all back
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { writableRootIds } from '@tagave/db';
import {
  createMoveSchema, moveTargetUpdateSchema,
  type AlbumMoveKind, type AlbumMoveState, type AlbumMoveView, type FilesMoveJobData, type MoveAlbumOption, type MoveCandidate,
  type MoveJournal, type MoveListItem, type MovePlan, type MoveTarget,
} from '@tagave/shared';
import { getSql } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { librarySettings } from '../lib/deletions.js';
import { containsPattern } from '../lib/textMatch.js';

const OWNER = { config: { permission: 'system.manage' as const } };

interface Row {
  id: string; state: AlbumMoveState; sourceAlbumId: string | null; targetAlbumId: string | null;
  candidates: MoveCandidate[] | null; plan: MovePlan | null; journal: MoveJournal | null; error: string | null;
  createdAt: Date | string; finishedAt: Date | string | null;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  return parsed.data;
}

async function sendMoveJob(data: FilesMoveJobData): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue('files.move');
  await boss.send('files.move', data, { singletonKey: `files.move:${data.moveId}:${data.action}` });
}

async function rowOf(libraryId: string, moveId: string): Promise<Row> {
  const [r] = await getSql()<Row[]>`
    select id::text as id, state, source_album_id::text as "sourceAlbumId", target_album_id::text as "targetAlbumId",
           candidates, plan, journal, error, created_at as "createdAt", finished_at as "finishedAt"
      from album_moves where id = ${moveId} and library_id = ${libraryId}`;
  if (!r) throw new ApiError(404, 'Not Found', 'No such move');
  return r;
}

/** Why Move cannot start now: the music folder must be writable (as Trash and Split) and tag writes on. */
async function blockedReason(libraryId: string, plan: MovePlan | null): Promise<string | null> {
  if (!plan) return null;
  const settings = await librarySettings(getSql(), libraryId);
  if (settings?.['tagWritesEnabled'] !== true) return 'Tag writes are off';
  if (!(await writableRootIds(getSql(), libraryId)).has(plan.scanRootId)) return 'Music folder is read-only';
  return null;
}

const undoable = (r: Pick<Row, 'state' | 'journal'>) => (r.state === 'done' || r.state === 'moving') && (r.state === 'moving' || (r.journal?.files.length ?? 0) > 0);

export async function moveView(libraryId: string, moveId: string): Promise<AlbumMoveView> {
  const r = await rowOf(libraryId, moveId);
  return {
    id: r.id, state: r.state, sourceAlbumId: r.sourceAlbumId, targetAlbumId: r.targetAlbumId,
    candidates: r.candidates, plan: r.plan,
    moved: r.state === 'done' ? (r.journal?.files.filter((f) => f.moved || f.tagged).length ?? 0) : null,
    error: r.error, undoable: undoable(r),
    blocked: r.state === 'ready' ? await blockedReason(libraryId, r.plan) : null,
    createdAt: iso(r.createdAt), finishedAt: r.finishedAt ? iso(r.finishedAt) : null,
  };
}

/** The target's columns and the first step: a search, or a plan. */
async function targetColumns(libraryId: string, sourceAlbumId: string, target: MoveTarget): Promise<{
  state: 'searching' | 'planning'; targetAlbumId: string | null; releaseMbid: string | null; query: { artist: string; title: string } | null;
}> {
  if ('search' in target) return { state: 'searching', targetAlbumId: null, releaseMbid: null, query: target.search };
  if ('releaseMbid' in target) return { state: 'planning', targetAlbumId: null, releaseMbid: target.releaseMbid, query: null };
  if (target.albumId === sourceAlbumId) throw new ApiError(409, 'Conflict', 'The songs are on that album already');
  const [a] = await getSql()<Array<{ state: string; releaseId: string | null }>>`
    select state, release_id::text as "releaseId" from local_albums where id = ${target.albumId} and library_id = ${libraryId}`;
  if (!a) throw new ApiError(404, 'Not Found', 'No such album');
  if (a.state !== 'matched' || !a.releaseId) throw new ApiError(409, 'Conflict', 'That album is not identified');
  return { state: 'planning', targetAlbumId: target.albumId, releaseMbid: null, query: null };
}

const paramsOf = (request: FastifyRequest) => request.params as { libraryId: string; albumId?: string; moveId?: string };

export async function createAlbumMoveRoutes(fastify: FastifyInstance) {
  /** Library care › Moved: the moves made, newest first. */
  fastify.get('/libraries/:libraryId/moves', OWNER, async (request): Promise<{ items: MoveListItem[] }> => {
    const { libraryId } = paramsOf(request);
    const rows = await getSql()<Array<{
      id: string; kind: AlbumMoveKind; state: AlbumMoveState; plan: MovePlan | null; journal: MoveJournal | null; error: string | null;
      targetAlbumId: string | null; finishedAt: Date | string | null; undoneAt: Date | string | null;
    }>>`
      select id::text as id, kind, state, plan, journal, error, target_album_id::text as "targetAlbumId",
             finished_at as "finishedAt", undone_at as "undoneAt"
        from album_moves
       where library_id = ${libraryId} and (state in ('done', 'undoing', 'undone', 'moving') or (kind <> 'move' and state = 'failed'))
       order by coalesce(finished_at, created_at) desc limit 200`;
    return {
      items: rows.map((r) => {
        const files = r.journal?.files ?? [];
        const from = files[0]?.fromPath ?? r.plan?.files.find((f) => f.toPath)?.fromPath ?? null;
        return {
          id: r.id, kind: r.kind, state: r.state,
          title: r.plan?.release.title ?? 'Untitled', artist: r.plan?.release.artist ?? null,
          fromDir: from ? (from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '') : null,
          toDir: r.plan?.toDir ?? null,
          files: files.length || (r.plan?.files.filter((f) => f.toPath).length ?? 0),
          targetAlbumId: r.targetAlbumId,
          finishedAt: r.undoneAt ? iso(r.undoneAt) : r.finishedAt ? iso(r.finishedAt) : null,
          undoable: undoable(r),
          error: r.error,
        };
      }),
    };
  });

  /** The picker: the library's identified albums by title or artist (diacritics ignored). */
  fastify.get('/libraries/:libraryId/moves/albums', OWNER, async (request): Promise<{ items: MoveAlbumOption[] }> => {
    const { libraryId } = paramsOf(request);
    const q = String((request.query as { q?: string }).q ?? '').trim().slice(0, 200);
    if (!q) return { items: [] };
    const pattern = containsPattern(q);
    const rows = await getSql()<Array<MoveAlbumOption & { dirPaths: string[] | null }>>`
      select la.id::text as id, coalesce(la.title_guess, 'Untitled') as title, la.artist_guess as artist, la.year_guess as year,
             coalesce(la.track_count, 0)::int as tracks, la.dir_paths as "dirPaths", (la.state = 'matched' and la.release_id is not null) as matched
        from local_albums la
       where la.library_id = ${libraryId}
         and (la.title_guess ilike ${pattern} or unaccent(la.title_guess) ilike unaccent(${pattern}::text)
              or la.artist_guess ilike ${pattern} or unaccent(la.artist_guess) ilike unaccent(${pattern}::text)
              or unaccent(coalesce(la.artist_guess, '') || ' ' || coalesce(la.title_guess, '')) ilike unaccent(${pattern}::text))
       order by (la.state = 'matched') desc, la.artist_guess nulls last, la.year_guess nulls last, la.title_guess
       limit 30`;
    return { items: rows.map(({ dirPaths, ...r }) => ({ ...r, folder: dirPaths?.[0] ?? null })) };
  });

  /** A new move of these songs of the album. */
  fastify.post('/libraries/:libraryId/albums/:albumId/moves', OWNER, async (request, reply) => {
    const { libraryId, albumId } = paramsOf(request);
    const body = parse(createMoveSchema, request.body);
    const sql = getSql();
    const trackIds = [...new Set(body.trackIds)];
    const [own] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from local_tracks lt join local_albums la on la.id = lt.local_album_id
       where lt.id = any(${trackIds}::uuid[]) and la.id = ${albumId!} and la.library_id = ${libraryId}`;
    if (!own || own.n !== trackIds.length) throw new ApiError(404, 'Not Found', 'Those songs are not on this album');
    const t = await targetColumns(libraryId, albumId!, body.target);
    const [row] = await sql<Array<{ id: string }>>`
      insert into album_moves (library_id, source_album_id, target_album_id, release_mbid, source_track_ids, state, query, created_by)
      values (${libraryId}, ${albumId!}, ${t.targetAlbumId}, ${t.releaseMbid}, ${trackIds}::uuid[], ${t.state},
              ${t.query ? JSON.stringify(t.query) : null}::jsonb, ${request.user!.id})
      returning id::text as id`;
    await sendMoveJob({ moveId: row!.id, action: t.state === 'searching' ? 'search' : 'plan' });
    reply.status(202);
    return moveView(libraryId, row!.id);
  });

  fastify.get('/libraries/:libraryId/moves/:moveId', OWNER, async (request) => {
    const { libraryId, moveId } = paramsOf(request);
    return moveView(libraryId, moveId!);
  });

  /** Another target (a search, a release it found, an album), before the move is made. */
  fastify.post('/libraries/:libraryId/moves/:moveId/target', OWNER, async (request, reply) => {
    const { libraryId, moveId } = paramsOf(request);
    const { target } = parse(moveTargetUpdateSchema, request.body);
    const r = await rowOf(libraryId, moveId!);
    if (!r.sourceAlbumId) throw new ApiError(409, 'Conflict', 'The album is gone');
    const t = await targetColumns(libraryId, r.sourceAlbumId, target);
    const updated = await getSql()`
      update album_moves set state = ${t.state}, target_album_id = ${t.targetAlbumId}, release_mbid = ${t.releaseMbid},
             release_id = null, query = coalesce(${t.query ? JSON.stringify(t.query) : null}::jsonb, query),
             candidates = case when ${t.state} = 'searching' then null else candidates end,
             plan = null, error = null, updated_at = now(), finished_at = null
       where id = ${moveId!} and library_id = ${libraryId} and state in ('choosing', 'ready', 'failed')
      returning id`;
    if (updated.length === 0) throw new ApiError(409, 'Conflict', 'This move cannot change now');
    await sendMoveJob({ moveId: moveId!, action: t.state === 'searching' ? 'search' : 'plan' });
    reply.status(202);
    return moveView(libraryId, moveId!);
  });

  /** Move as planned. */
  fastify.post('/libraries/:libraryId/moves/:moveId/run', OWNER, async (request, reply) => {
    const { libraryId, moveId } = paramsOf(request);
    const r = await rowOf(libraryId, moveId!);
    if (r.state !== 'ready' || !r.plan) throw new ApiError(409, 'Conflict', 'This move cannot run now');
    const blocked = await blockedReason(libraryId, r.plan);
    if (blocked) throw new ApiError(409, 'Conflict', blocked);
    if (r.plan.files.some((f) => f.clash)) throw new ApiError(409, 'Conflict', 'A new name is taken in the folder');
    if (!r.plan.files.some((f) => f.toPath)) throw new ApiError(409, 'Conflict', 'No song pairs with a track of that album');
    const updated = await getSql()`
      update album_moves set state = 'moving', created_by = ${request.user!.id}, error = null, undo_requested = false, updated_at = now()
       where id = ${moveId!} and library_id = ${libraryId} and state = 'ready' returning id`;
    if (updated.length === 0) throw new ApiError(409, 'Conflict', 'This move cannot run now');
    await sendMoveJob({ moveId: moveId!, action: 'move' });
    reply.status(202);
    return moveView(libraryId, moveId!);
  });

  /** Undo: the files back to their old names, their old tags written back. While the move still runs, it is undone as it ends. */
  fastify.post('/libraries/:libraryId/moves/:moveId/undo', OWNER, async (request, reply) => {
    const { libraryId, moveId } = paramsOf(request);
    const sql = getSql();
    const asked = await sql`
      update album_moves set undo_requested = true, updated_at = now()
       where id = ${moveId!} and library_id = ${libraryId} and state = 'moving' returning id`;
    if (asked.length === 0) {
      const updated = await sql`
        update album_moves set state = 'undoing', created_by = ${request.user!.id}, updated_at = now()
         where id = ${moveId!} and library_id = ${libraryId} and state = 'done'
           and jsonb_array_length(coalesce(journal->'files', '[]'::jsonb)) > 0
        returning id`;
      if (updated.length === 0) throw new ApiError(409, 'Conflict', 'This move cannot be undone now');
      await sendMoveJob({ moveId: moveId!, action: 'undo' });
    }
    reply.status(202);
    return moveView(libraryId, moveId!);
  });
}
