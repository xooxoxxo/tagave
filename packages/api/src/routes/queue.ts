import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  albumMatches, canonicalTracks, libraries, localAlbums, localTracks,
  matchCandidates, releaseGroups, releases,
} from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

async function assertLibrary(userId: string, libraryId: string) {
  const db = getDb();
  const lib = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
}

async function loadAlbumForUser(userId: string, albumId: string) {
  const db = getDb();
  const rows = await db.select().from(localAlbums).where(eq(localAlbums.id, albumId)).limit(1);
  const album = rows[0];
  if (!album) throw new ApiError(404, 'Not Found', 'Album not found');
  await assertLibrary(userId, album.libraryId);
  return album;
}

export async function createQueueRoutes(fastify: FastifyInstance) {
  /**
   * Review queue (spec IDN-4): needs_review albums ordered by closeness to
   * auto-accept, each carrying its scored candidates.
   */
  fastify.get('/libraries/:libraryId/queue', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const { limit = '30', offset = '0' } = request.query as Record<string, string>;
    await assertLibrary(request.user.id, libraryId);
    const db = getDb();

    const limitN = Math.min(parseInt(limit, 10) || 30, 100);
    const offsetN = parseInt(offset, 10) || 0;

    const albums = await db.execute(sql`
      select la.*, best.min_distance
      from local_albums la
      left join lateral (
        select min(mc.distance) as min_distance
        from match_candidates mc
        where mc.local_album_id = la.id and not mc.excluded
      ) best on true
      where la.library_id = ${libraryId} and la.state = 'needs_review'
      order by best.min_distance asc nulls last, la.created_at asc
      limit ${limitN + 1} offset ${offsetN}`) as unknown as Record<string, unknown>[];

    const page = albums.slice(0, limitN);
    const albumIds = page.map((a) => a['id'] as string);
    if (albumIds.length === 0) {
      reply.send({ items: [], nextCursor: null });
      return;
    }

    const tracks = await db
      .select()
      .from(localTracks)
      .where(inArray(localTracks.localAlbumId, albumIds));

    const cands = await db
      .select({
        id: matchCandidates.id,
        localAlbumId: matchCandidates.localAlbumId,
        distance: matchCandidates.distance,
        breakdown: matchCandidates.breakdown,
        source: matchCandidates.source,
        excluded: matchCandidates.excluded,
        releaseId: releases.id,
        releaseMbid: releases.mbid,
        releaseTitle: releases.title,
        releaseDate: releases.date,
        releaseCountry: releases.country,
        releaseStatus: releases.status,
        releaseTrackCount: releases.trackCount,
        releaseLabels: releases.labels,
        rgMbid: releaseGroups.mbid,
        rgArtistCredit: releaseGroups.artistCredit,
      })
      .from(matchCandidates)
      .innerJoin(releases, eq(releases.id, matchCandidates.releaseId))
      .innerJoin(releaseGroups, eq(releaseGroups.id, releases.releaseGroupId))
      .where(inArray(matchCandidates.localAlbumId, albumIds))
      .orderBy(asc(matchCandidates.distance));

    const items = page.map((a) => ({
      id: a['id'],
      title: a['title_guess'],
      artist: a['artist_guess'],
      year: a['year_guess'],
      dirPaths: a['dir_paths'],
      trackCount: a['track_count'],
      formats: a['formats'],
      bestDistance: a['min_distance'] !== null ? Number(a['min_distance']) : null,
      tracks: tracks
        .filter((t) => t.localAlbumId === a['id'])
        .sort((x, y) => (x.discNo ?? 1) - (y.discNo ?? 1) || (x.trackNo ?? 0) - (y.trackNo ?? 0))
        .map((t) => ({
          id: t.id,
          discNo: t.discNo,
          trackNo: t.trackNo,
          title: t.titleGuess,
          durationMs: t.durationMs,
        })),
      candidates: cands
        .filter((c) => c.localAlbumId === a['id'] && !c.excluded)
        .map((c) => ({
          id: c.id,
          releaseId: c.releaseId,
          releaseMbid: c.releaseMbid,
          title: c.releaseTitle,
          artistCredit: Array.isArray(c.rgArtistCredit) ? (c.rgArtistCredit as string[]).join(', ') : String(c.rgArtistCredit ?? ''),
          date: c.releaseDate,
          country: c.releaseCountry,
          status: c.releaseStatus,
          trackCount: c.releaseTrackCount,
          labels: c.releaseLabels,
          distance: Number(c.distance),
          breakdown: c.breakdown,
          source: c.source,
        })),
    }));

    reply.send({ items, nextCursor: albums.length > limitN ? String(offsetN + limitN) : null });
  });

  /** Accept a candidate (IDN-4 Enter): confirmed match, decided by user. */
  fastify.post('/albums/:albumId/match', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId } = request.params as { albumId: string };
    const { candidateId } = request.body as { candidateId?: string };
    if (!candidateId) throw new ApiError(400, 'Bad Request', 'candidateId required');
    const album = await loadAlbumForUser(request.user.id, albumId);
    const db = getDb();

    const candRows = await db
      .select()
      .from(matchCandidates)
      .where(and(eq(matchCandidates.id, candidateId), eq(matchCandidates.localAlbumId, albumId)))
      .limit(1);
    const cand = candRows[0];
    if (!cand) throw new ApiError(404, 'Not Found', 'Candidate not found for this album');

    const relRows = await db
      .select({ rgId: releases.releaseGroupId })
      .from(releases)
      .where(eq(releases.id, cand.releaseId))
      .limit(1);

    // §11.5: at most one live match; flip any prior live row to rejected first.
    await db.execute(sql`
      update album_matches set status = 'rejected', reason = 'superseded by user decision'
      where local_album_id = ${albumId} and status in ('auto', 'confirmed')`);
    await db.insert(albumMatches).values({
      libraryId: album.libraryId,
      localAlbumId: albumId,
      releaseId: cand.releaseId,
      distance: cand.distance,
      status: 'confirmed',
      decidedBy: 'user',
      reason: 'accepted in review queue',
    });
    await db
      .update(localAlbums)
      .set({
        state: 'matched',
        releaseId: cand.releaseId,
        releaseGroupId: relRows[0]?.rgId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(localAlbums.id, albumId));
    reply.send({ ok: true, state: 'matched' });
  });

  /** Keep as-is (IDN-4 'a'): no release; local tags treated as canonical. */
  fastify.post('/albums/:albumId/as-is', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId } = request.params as { albumId: string };
    await loadAlbumForUser(request.user.id, albumId);
    await getDb()
      .update(localAlbums)
      .set({ state: 'as_is', updatedAt: new Date() })
      .where(eq(localAlbums.id, albumId));
    reply.send({ ok: true, state: 'as_is' });
  });

  /** Ignore folder (IDN-4 'x'). */
  fastify.post('/albums/:albumId/ignore', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId } = request.params as { albumId: string };
    await loadAlbumForUser(request.user.id, albumId);
    await getDb()
      .update(localAlbums)
      .set({ state: 'ignored', updatedAt: new Date() })
      .where(eq(localAlbums.id, albumId));
    reply.send({ ok: true, state: 'ignored' });
  });

  /** Exclude a candidate and keep reviewing. */
  fastify.post('/albums/:albumId/exclude-candidate', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId } = request.params as { albumId: string };
    const { candidateId } = request.body as { candidateId?: string };
    if (!candidateId) throw new ApiError(400, 'Bad Request', 'candidateId required');
    await loadAlbumForUser(request.user.id, albumId);
    await getDb()
      .update(matchCandidates)
      .set({ excluded: true })
      .where(and(eq(matchCandidates.id, candidateId), eq(matchCandidates.localAlbumId, albumId)));
    reply.send({ ok: true });
  });
}
