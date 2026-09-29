/**
 * Gaps and the Tasks list (spec GAP-1/2/4/5, §14.2; decisions 0032).
 *
 * Each gap offers three choices: accept it as a task ("Add to my tasks",
 * state `todo`), hide it as not a problem, or hide it as wrong (the check was
 * mistaken). gaps.recompute keeps tasks until their condition is gone and then
 * marks them resolved; `accepted_at` keeps them listed under Done.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { gaps, libraries } from '@liner/db';
import { TASK_DONE_DAYS, TASK_NOTE_MAX, type GapTask, type GapTasksResponse } from '@liner/shared';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';

const STATES = new Set(['open', 'todo', 'dismissed', 'resolved']);
const DISMISS_REASONS = new Set(['not_interested', 'wrong_data', 'own_elsewhere']);

async function assertLibrary(userId: string, libraryId: string) {
  const lib = await getDb()
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
}

/** The gap, after checking it belongs to one of the user's libraries. */
async function loadGapForUser(userId: string, gapId: string) {
  const rows = await getDb()
    .select({ id: gaps.id, libraryId: gaps.libraryId, state: gaps.state })
    .from(gaps)
    .where(eq(gaps.id, gapId))
    .limit(1);
  if (!rows[0]) throw new ApiError(404, 'Not Found', 'Gap not found');
  await assertLibrary(userId, rows[0].libraryId);
  return rows[0];
}

function cleanNote(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new ApiError(400, 'Bad Request', 'The note must be text.');
  const note = raw.trim();
  if (note.length > TASK_NOTE_MAX) throw new ApiError(400, 'Bad Request', `Keep the note under ${TASK_NOTE_MAX} characters.`);
  return note || null;
}

/** Open tasks and the ones a scan resolved in the last TASK_DONE_DAYS days. */
export async function taskCounts(libraryId: string): Promise<{ todo: number; done: number }> {
  const [row] = await getDb().execute(sql`
    select count(*) filter (where state = 'todo')::int as todo,
           count(*) filter (where state = 'resolved'
                              and resolved_at > now() - make_interval(days => ${TASK_DONE_DAYS}))::int as done
      from gaps
     where library_id = ${libraryId} and accepted_at is not null`) as unknown as { todo: number; done: number }[];
  return { todo: Number(row?.todo ?? 0), done: Number(row?.done ?? 0) };
}

export async function createGapRoutes(fastify: FastifyInstance) {
  /** Needs Attention: gaps of one state (default open), newest first, with open counts per kind. */
  fastify.get('/libraries/:libraryId/gaps', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const { kind, state = 'open', limit = '100', offset = '0' } = request.query as Record<string, string>;
    if (!STATES.has(state)) throw new ApiError(400, 'Bad Request', `Unknown gap state: ${state}`);
    await assertLibrary(request.user.id, libraryId);
    const db = getDb();
    const limitN = Math.min(parseInt(limit, 10) || 100, 500);
    const offsetN = parseInt(offset, 10) || 0;

    const rows = await db.execute(sql`
      select g.*, la.title_guess as album_title, la.artist_guess as album_artist,
             la.dir_paths as album_dirs, rg.title as rg_title
      from gaps g
      left join local_albums la on g.subject_type = 'local_album' and la.id = g.subject_id
      left join release_groups rg on g.subject_type = 'release_group' and rg.id = g.subject_id
      where g.library_id = ${libraryId}
        and g.state = ${state}
        ${kind ? sql`and g.kind = ${kind}` : sql``}
      order by g.first_seen_at desc, g.subject_id, g.flag
      limit ${limitN + 1} offset ${offsetN}`) as unknown as Record<string, unknown>[];

    const counts = await db.execute(sql`
      select kind, count(*)::int as n from gaps
      where library_id = ${libraryId} and state = 'open' group by kind`) as unknown as { kind: string; n: number }[];

    reply.send({
      counts: Object.fromEntries(counts.map((c) => [c.kind, c.n])),
      tasks: await taskCounts(libraryId),
      items: rows.slice(0, limitN).map((g) => ({
        id: g['id'],
        kind: g['kind'],
        flag: g['flag'] ?? '',
        subjectType: g['subject_type'],
        subjectId: g['subject_id'],
        subjectTitle: g['album_title'] ?? g['rg_title'] ?? null,
        subjectArtist: g['album_artist'] ?? null,
        folder: (g['album_dirs'] as string[] | null)?.[0] ?? null,
        details: g['details'],
        state: g['state'],
        dismissReason: g['dismiss_reason'] ?? null,
        firstSeenAt: g['first_seen_at'],
      })),
      nextCursor: rows.length > limitN ? String(offsetN + limitN) : null,
    });
  });

  /** The Tasks list: accepted gaps still to do, and the ones a scan crossed out recently. */
  fastify.get('/libraries/:libraryId/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    const rows = await getDb().execute(sql`
      select g.id, g.kind, g.flag, g.state, g.subject_type, g.subject_id, g.details, g.note,
             g.accepted_at, g.resolved_at,
             la.id as la_id, la.dir_paths,
             coalesce(r.title, la.title_guess) as album_title,
             coalesce(liner_display_artist(la.artist_guess), la.artist_guess) as album_artist,
             rg.id as rg_id, rg.title as rg_title,
             ra.id as rg_artist_id, ra.name as rg_artist
        from gaps g
        left join local_albums la on g.subject_type = 'local_album' and la.id = g.subject_id
        left join releases r on r.id = la.release_id
        left join release_groups rg on g.subject_type = 'release_group' and rg.id = g.subject_id
        left join lateral (
          select a.id, a.name from release_group_artists rga join artists a on a.id = rga.artist_id
           where rga.release_group_id = rg.id order by rga.position limit 1) ra on true
       where g.library_id = ${libraryId}
         and g.accepted_at is not null
         and (g.state = 'todo'
              or (g.state = 'resolved' and g.resolved_at > now() - make_interval(days => ${TASK_DONE_DAYS})))
       order by g.state = 'todo' desc, coalesce(g.resolved_at, g.accepted_at) desc, g.id
       limit 1000`) as unknown as Record<string, unknown>[];

    const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
    const items: GapTask[] = rows.map((g) => {
      const details = (g['details'] ?? {}) as Record<string, unknown>;
      const isAlbum = g['subject_type'] === 'local_album';
      const dupIds = Array.isArray(details['albumIds']) ? (details['albumIds'] as string[]) : [];
      return {
        id: g['id'] as string,
        kind: g['kind'] as string,
        flag: (g['flag'] as string) ?? '',
        state: g['state'] === 'todo' ? 'todo' : 'resolved',
        subjectType: g['subject_type'] as string,
        subjectId: g['subject_id'] as string,
        details,
        note: (g['note'] as string | null) ?? null,
        acceptedAt: iso(g['accepted_at'])!,
        resolvedAt: iso(g['resolved_at']),
        albumId: isAlbum ? ((g['la_id'] as string | null) ?? null) : g['kind'] === 'duplicate' ? (dupIds[0] ?? null) : null,
        title: (isAlbum ? g['album_title'] : g['rg_title'] ?? details['title']) as string | null ?? null,
        artist: (isAlbum ? g['album_artist'] : g['rg_artist']) as string | null ?? null,
        artistId: isAlbum ? null : ((g['rg_artist_id'] as string | null) ?? null),
        folder: isAlbum ? ((g['dir_paths'] as string[] | null)?.[0] ?? null) : null,
        subjectGone: isAlbum ? g['la_id'] == null : g['subject_type'] === 'release_group' ? g['rg_id'] == null : false,
      };
    });
    const body: GapTasksResponse = {
      todo: items.filter((t) => t.state === 'todo'),
      done: items.filter((t) => t.state === 'resolved'),
    };
    reply.send(body);
  });

  /** "Add to my tasks": the owner confirms the gap and will fix it. */
  fastify.post('/gaps/:gapId/accept', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { gapId } = request.params as { gapId: string };
    const note = cleanNote((request.body as { note?: unknown } | null)?.note);
    const gap = await loadGapForUser(request.user.id, gapId);
    if (gap.state === 'resolved') throw new ApiError(409, 'Conflict', 'This issue is already fixed, so there is nothing to add.');
    await getDb().update(gaps)
      .set({ state: 'todo', dismissReason: null, acceptedAt: sql`coalesce(${gaps.acceptedAt}, now())`, note, decidedAt: sql`now()` })
      .where(eq(gaps.id, gapId));
    reply.send({ ok: true });
  });

  /** Edit the note on a task. */
  fastify.patch('/gaps/:gapId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { gapId } = request.params as { gapId: string };
    const note = cleanNote((request.body as { note?: unknown } | null)?.note);
    await loadGapForUser(request.user.id, gapId);
    await getDb().update(gaps).set({ note }).where(eq(gaps.id, gapId));
    reply.send({ ok: true });
  });

  /** "Not a problem" (not_interested) or "This is wrong" (wrong_data): hide it; it is no longer a task. */
  fastify.post('/gaps/:gapId/dismiss', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { gapId } = request.params as { gapId: string };
    const { reason = 'not_interested' } = (request.body ?? {}) as { reason?: string };
    if (!DISMISS_REASONS.has(reason)) throw new ApiError(400, 'Bad Request', `Unknown reason: ${reason}`);
    await loadGapForUser(request.user.id, gapId);
    await getDb().update(gaps)
      .set({ state: 'dismissed', dismissReason: reason, acceptedAt: null, decidedAt: sql`now()` })
      .where(eq(gaps.id, gapId));
    reply.send({ ok: true });
  });

  /** Show a hidden gap again, or take a task off the list: back to open, undecided. */
  fastify.post('/gaps/:gapId/reopen', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { gapId } = request.params as { gapId: string };
    const gap = await loadGapForUser(request.user.id, gapId);
    if (gap.state === 'resolved') throw new ApiError(409, 'Conflict', 'This issue is already fixed.');
    await getDb().update(gaps)
      .set({ state: 'open', dismissReason: null, acceptedAt: null, note: null, decidedAt: sql`now()` })
      .where(eq(gaps.id, gapId));
    reply.send({ ok: true });
  });

  /** "Check again now": queue a full gap check for the library (tasks resolve on it). */
  fastify.post('/libraries/:libraryId/gaps/recompute', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    const boss = await getBoss();
    await boss.createQueue('gaps.recompute');
    const jobId = await boss.send('gaps.recompute', { libraryId }, { singletonKey: `gaps:${libraryId}` });
    reply.code(202).send({ queued: jobId != null });
  });
}
