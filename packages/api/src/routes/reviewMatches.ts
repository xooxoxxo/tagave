/**
 * Review matches: auto-accept rules and pasted editions.
 *
 *   GET  /libraries/:lib/auto-accept           rules + what they accepted lately
 *   PUT  /libraries/:lib/auto-accept           save the rules
 *   POST /libraries/:lib/auto-accept/preview   dry run: how many queued albums the given rules accept now
 *   POST /libraries/:lib/auto-accept/run       "Accept N now": the saved rules over the queue (worker job)
 *   POST /albums/:albumId/editions             "Not listed?": fetch a pasted release as a candidate (worker job)
 *   GET  /albums/:albumId/editions/:jobId      that job: pending, the new candidate, or why not
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  autoAcceptRules, libraries, localAlbums, fetchAutoAcceptRulesRow, fetchRulesInputs,
} from '@tagave/db';
import { evaluateAutoAccept, rulesFromStored } from '@tagave/core';
import {
  autoAcceptRulesSchema, matchPercent, AUTO_ACCEPT_REASON_PREFIX,
  type AutoAcceptPreview, type AutoAcceptRules, type AutoAcceptView,
} from '@tagave/shared';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { parseMatchInput } from '../lib/matchInput.js';

/** How many recent decisions the rules dialog lists. */
const RECENT_LIMIT = 8;

async function assertLibrary(userId: string, libraryId: string): Promise<void> {
  const rows = await getDb().select({ id: libraries.id }).from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (rows.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
}

async function albumForUser(userId: string, albumId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(albumId)) throw new ApiError(404, 'Not Found', 'Album not found');
  const album = (await getDb().select({ id: localAlbums.id, libraryId: localAlbums.libraryId })
    .from(localAlbums).where(eq(localAlbums.id, albumId)).limit(1))[0];
  if (!album) throw new ApiError(404, 'Not Found', 'Album not found');
  await assertLibrary(userId, album.libraryId);
  return album;
}

function parseRules(body: unknown): AutoAcceptRules {
  const parsed = autoAcceptRulesSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ApiError(400, 'Bad Request', first ? `${first.path.join('.') || 'rules'}: ${first.message}` : 'Invalid rules');
  }
  return parsed.data;
}

/** Dry run: the rules over the library's needs_review albums, nothing written. */
export async function previewAutoAccept(libraryId: string, rules: AutoAcceptRules): Promise<AutoAcceptPreview> {
  const albums = await fetchRulesInputs(getDb(), libraryId);
  let wouldAccept = 0;
  for (const a of albums) {
    if (evaluateAutoAccept(rules, a, a.candidates).accept) wouldAccept += 1;
  }
  return { wouldAccept, total: albums.length };
}

async function viewFor(libraryId: string): Promise<AutoAcceptView> {
  const db = getDb();
  const row = await fetchAutoAcceptRulesRow(db, libraryId);
  const prefix = `${AUTO_ACCEPT_REASON_PREFIX}%`;
  const recent = await db.execute(sql`
    select am.local_album_id, am.distance, am.decided_at, la.title_guess, la.artist_guess
      from album_matches am
      join local_albums la on la.id = am.local_album_id
     where am.library_id = ${libraryId} and am.decided_by = 'system' and am.reason like ${prefix}
     order by am.decided_at desc
     limit ${RECENT_LIMIT}`) as unknown as Array<Record<string, unknown>>;
  const [total] = await db.execute(sql`
    select count(*)::int as n from album_matches
     where library_id = ${libraryId} and decided_by = 'system' and reason like ${prefix}`) as unknown as [{ n: number }];
  return {
    rules: rulesFromStored(row),
    updatedAt: row?.updatedAt ?? null,
    recent: recent.map((r) => ({
      albumId: String(r['local_album_id']),
      title: (r['title_guess'] as string | null) ?? null,
      artist: (r['artist_guess'] as string | null) ?? null,
      percent: matchPercent(Number(r['distance'])),
      decidedAt: new Date(r['decided_at'] as string | Date).toISOString(),
    })),
    acceptedTotal: total?.n ?? 0,
  };
}

export async function createReviewMatchesRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/auto-accept', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    reply.send(await viewFor(libraryId));
  });

  fastify.put('/libraries/:libraryId/auto-accept', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    const rules = parseRules(request.body);
    const values = { ...rules, updatedAt: new Date() };
    await getDb().insert(autoAcceptRules).values({ libraryId, ...values })
      .onConflictDoUpdate({ target: autoAcceptRules.libraryId, set: values });
    reply.send(await viewFor(libraryId));
  });

  fastify.post('/libraries/:libraryId/auto-accept/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    reply.send(await previewAutoAccept(libraryId, parseRules(request.body)));
  });

  fastify.post('/libraries/:libraryId/auto-accept/run', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    const boss = await getBoss();
    const jobId = await boss.send('queue.autoaccept', { libraryId, mode: 'rules' });
    reply.status(202).send({ ok: true, jobId: jobId ?? null });
  });

  fastify.post('/albums/:albumId/editions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId } = request.params as { albumId: string };
    const { input } = (request.body ?? {}) as { input?: unknown };
    const parsed = parseMatchInput(typeof input === 'string' ? input : '');
    if (!parsed.ok) throw new ApiError(400, 'Bad Request', parsed.message);
    const t = parsed.target;
    if (t.source === 'musicbrainz' && t.entity === 'release-group') {
      throw new ApiError(400, 'Bad Request', 'That is a release group, which holds several editions. Open it on MusicBrainz and paste the release you have.');
    }
    await albumForUser(request.user.id, albumId);
    const boss = await getBoss();
    const target = t.source === 'musicbrainz' ? { source: 'musicbrainz', mbid: t.mbid } : { source: 'discogs', kind: t.kind, id: t.id };
    // One quick retry for a provider blip; the screen is waiting.
    const jobId = await boss.send('edition.add', { localAlbumId: albumId, target }, { retryLimit: 1, retryDelay: 5, retryBackoff: false, expireInSeconds: 300 });
    if (!jobId) throw new ApiError(503, 'Service Unavailable', 'Could not queue the lookup. Try again.');
    reply.status(202).send({ ok: true, jobId });
  });

  fastify.get('/albums/:albumId/editions/:jobId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId, jobId } = request.params as { albumId: string; jobId: string };
    await albumForUser(request.user.id, albumId);
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new ApiError(404, 'Not Found', 'Lookup not found');
    const boss = await getBoss();
    const job = await boss.getJobById<{ localAlbumId: string }>('edition.add', jobId);
    if (!job || job.data?.localAlbumId !== albumId) throw new ApiError(404, 'Not Found', 'Lookup not found');
    if (job.state === 'completed') {
      reply.send({ state: 'done', result: job.output ?? { ok: false, message: 'The lookup finished without a result.' } });
      return;
    }
    if (job.state === 'failed' || job.state === 'cancelled') {
      reply.send({ state: 'done', result: { ok: false, message: 'MusicBrainz or Discogs did not answer. Try again in a minute.' } });
      return;
    }
    reply.send({ state: 'pending' });
  });
}
