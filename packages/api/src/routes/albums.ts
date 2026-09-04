import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  albumMatches, audioFiles, canonicalTracks, gaps, images, libraries, localAlbums,
  localTracks, matchCandidates, releaseGroups, releases, externalIds, entityTags,
} from '@liner/db';
import PgBoss from 'pg-boss';
import { parseDiscogsRef } from '@liner/core';

let bossSingleton: PgBoss | null = null;
async function getBossForAlbums(): Promise<PgBoss> {
  if (!bossSingleton) {
    bossSingleton = new PgBoss(process.env.DATABASE_URL!);
    await bossSingleton.start();
    await bossSingleton.createQueue('identify.album');
  }
  return bossSingleton;
}
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

export async function createAlbumRoutes(fastify: FastifyInstance) {
  // Get albums for a library with pagination and filters
  fastify.get('/libraries/:libraryId/albums', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const { limit = '50', offset = '0', sort = 'artist', filter, artist, search } =
      request.query as Record<string, string>;

    const db = getDb();

    // Verify library ownership
    const lib = await db
      .select()
      .from(libraries)
      .where(
        and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
      );

    if (lib.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    // Query local albums
    const conds = [eq(localAlbums.libraryId, libraryId)];
    if (artist) conds.push(eq(localAlbums.artistGuess, artist));
    if (search) {
      conds.push(
        sql`(title_guess ilike ${'%' + search + '%'} or artist_guess ilike ${'%' + search + '%'})`,
      );
    }
    if (filter && filter !== 'all') conds.push(eq(localAlbums.state, filter));
    const orderings: Record<string, ReturnType<typeof sql>> = {
      artist: sql`lower(coalesce(artist_guess, '')), year_guess nulls last, lower(coalesce(title_guess, ''))`,
      title: sql`lower(coalesce(title_guess, '')), lower(coalesce(artist_guess, ''))`,
      year: sql`year_guess desc nulls last, lower(coalesce(artist_guess, ''))`,
      added_date: sql`created_at desc`,
    };
    const albums = await db
      .select()
      .from(localAlbums)
      .where(and(...conds))
      .orderBy(orderings[sort] ?? orderings['artist']!)
      .limit(Math.min(parseInt(limit, 10), 500))
      .offset(parseInt(offset, 10));

    const limitN = parseInt(limit, 10);
    const offsetN = parseInt(offset, 10);
    // Shared contract (spec §13): cursor envelope { items, nextCursor }.
    // Cursor is the next offset until true keyset pagination lands.
    reply.status(200).send({
      items: await (async () => {
        const artRows = albums.length
          ? await db
              .select({ localAlbumId: images.localAlbumId })
              .from(images)
              .where(and(eq(images.kind, 'front'), inArray(images.localAlbumId, albums.map((a) => a.id))))
          : [];
        const withArt = new Set(artRows.map((r) => r.localAlbumId));
        // canonical track counts + open attention gaps for n/N badges (XO-311)
        const relIds = [...new Set(albums.map((a) => a.releaseId).filter((x): x is string => !!x))];
        const relRows = relIds.length
          ? await db.select({ id: releases.id, trackCount: releases.trackCount }).from(releases).where(inArray(releases.id, relIds))
          : [];
        const canonCount = new Map(relRows.map((r) => [r.id, r.trackCount]));
        const subjectIds = [...new Set(albums.flatMap((a) => [a.id, a.releaseGroupId]).filter((x): x is string => !!x))];
        const gapRows = subjectIds.length
          ? await db
              .select({ subjectId: gaps.subjectId })
              .from(gaps)
              .where(and(
                eq(gaps.state, 'open'),
                inArray(gaps.kind, ['incomplete_album', 'duplicate']),
                inArray(gaps.subjectId, subjectIds),
              ))
          : [];
        const flagged = new Set(gapRows.map((g) => g.subjectId));
        return albums.map((album) => ({
        id: album.id,
        libraryId: album.libraryId,
        localAlbumId: album.id,
        title: album.titleGuess ?? 'Unknown Album',
        artistCredit: album.artistGuess ?? 'Unknown Artist',
        ...(album.yearGuess ? { year: album.yearGuess } : {}),
        formats: album.formats ?? [],
        state: album.state,
        trackCount: album.trackCount ?? 0,
        canonicalTrackCount: (album.releaseId && canonCount.get(album.releaseId)) || null,
        needsAttention: flagged.has(album.id) || (!!album.releaseGroupId && flagged.has(album.releaseGroupId)),
        totalDurationMs: album.totalDurationMs ?? 0,
        coverUrl: withArt.has(album.id) ? `/api/v1/images/album/${album.id}` : null,
        ...(album.releaseId ? { releaseId: album.releaseId } : {}),
        ...(album.releaseGroupId ? { releaseGroupId: album.releaseGroupId } : {}),
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
        }));
      })(),
      nextCursor: albums.length === limitN ? String(offsetN + limitN) : null,
    });
  });

  // Get single album details
  fastify.get(
    '/libraries/:libraryId/albums/:albumId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };

      const db = getDb();

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(
          and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
        );

      if (lib.length === 0) {
        throw new ApiError(404, 'Not Found', 'Library not found');
      }

      // Get album
      const albums = await db
        .select()
        .from(localAlbums)
        .where(
          and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId))
        );

      if (albums.length === 0) {
        throw new ApiError(404, 'Not Found', 'Album not found');
      }

      const album = albums[0];
      if (!album) {
        // Invariant: this should never happen since we checked albums.length > 0 above
        throw new ApiError(404, 'Not Found', 'Album not found');
      }

      const trackRows = await db
        .select({
          id: localTracks.id,
          discNo: localTracks.discNo,
          trackNo: localTracks.trackNo,
          title: localTracks.titleGuess,
          artist: localTracks.artistGuess,
          durationMs: localTracks.durationMs,
          fileId: audioFiles.id,
          relPath: audioFiles.relPath,
          container: audioFiles.container,
          codec: audioFiles.codec,
          lossless: audioFiles.lossless,
          bitrateKbps: audioFiles.bitrateKbps,
          sampleRate: audioFiles.sampleRate,
          bitDepth: audioFiles.bitDepth,
          sizeBytes: audioFiles.sizeBytes,
          fileStatus: audioFiles.status,
          hasEmbeddedArt: audioFiles.hasEmbeddedArt,
        })
        .from(localTracks)
        .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
        .where(eq(localTracks.localAlbumId, albumId));

      let release: Record<string, unknown> | null = null;
      let canonicalTrackRows: Record<string, unknown>[] = [];
      if (album.releaseId) {
        const relRows = await db
          .select()
          .from(releases)
          .where(eq(releases.id, album.releaseId))
          .limit(1);
        const rel = relRows[0];
        if (rel) {
          const rgRows = await db
            .select()
            .from(releaseGroups)
            .where(eq(releaseGroups.id, rel.releaseGroupId))
            .limit(1);

          // Collect external links from release.mbid, rg.mbid, discogs ids, and external_ids
          const externalLinks: Array<{ title: string; url: string; source: string }> = [];

          // Add MusicBrainz release link
          if (rel.mbid) {
            externalLinks.push({
              title: 'MusicBrainz Release',
              url: `https://musicbrainz.org/release/${rel.mbid}`,
              source: 'musicbrainz',
            });
          }

          // Add MusicBrainz release group link
          if (rgRows[0]?.mbid) {
            externalLinks.push({
              title: 'MusicBrainz Release Group',
              url: `https://musicbrainz.org/release-group/${rgRows[0].mbid}`,
              source: 'musicbrainz',
            });
          }

          // Add Discogs release link
          if (rel.discogsReleaseId) {
            externalLinks.push({
              title: 'Discogs Release',
              url: `https://www.discogs.com/release/${rel.discogsReleaseId}`,
              source: 'discogs',
            });
          }

          // Add Discogs master link
          if (rgRows[0]?.discogsmasterId) {
            externalLinks.push({
              title: 'Discogs Master',
              url: `https://www.discogs.com/master/${rgRows[0].discogsmasterId}`,
              source: 'discogs',
            });
          }

          // Add external_ids rows with provider in ('wikidata', 'wikipedia')
          const extIdRows = await db
            .select()
            .from(externalIds)
            .where(
              and(
                inArray(externalIds.provider, ['wikidata', 'wikipedia']),
                eq(externalIds.entityType, 'release'),
                eq(externalIds.entityId, rel.id)
              )
            );
          extIdRows.forEach((row) => {
            if (row.url) {
              externalLinks.push({
                title: row.provider === 'wikidata' ? 'Wikidata' : 'Wikipedia',
                url: row.url,
                source: row.provider,
              });
            }
          });

          // Also check for release_group external_ids
          if (rgRows[0]) {
            const rgExtIdRows = await db
              .select()
              .from(externalIds)
              .where(
                and(
                  inArray(externalIds.provider, ['wikidata', 'wikipedia']),
                  eq(externalIds.entityType, 'release_group'),
                  eq(externalIds.entityId, rgRows[0].id)
                )
              );
            rgExtIdRows.forEach((row) => {
              if (row.url) {
                externalLinks.push({
                  title: row.provider === 'wikidata' ? 'Wikidata' : 'Wikipedia',
                  url: row.url,
                  source: row.provider,
                });
              }
            });
          }

          const tagRows = await db
            .select({ tag: entityTags.tag, kind: entityTags.kind, entityId: entityTags.entityId })
            .from(entityTags)
            .where(and(
              inArray(entityTags.entityId, rgRows[0] ? [rel.id, rgRows[0].id] : [rel.id]),
              inArray(entityTags.kind, ['genre', 'style']),
            ));
          const uniq = (kind: string) => [...new Set(tagRows.filter((t) => t.kind === kind).map((t) => t.tag))];
          release = {
            id: rel.id,
            mbid: rel.mbid ?? null,
            genres: uniq('genre'),
            styles: uniq('style'),
            title: rel.title,
            date: rel.date,
            country: rel.country,
            status: rel.status,
            barcode: rel.barcode,
            labels: rel.labels,
            trackCount: rel.trackCount,
            artistCredit: rgRows[0]?.artistCredit ?? null,
            releaseGroupMbid: rgRows[0]?.mbid ?? null,
            discogsReleaseId: rel.discogsReleaseId ?? null,
            discogsMasterId: rgRows[0]?.discogsmasterId ?? null,
            sourceOfTruth: rel.sourceOfTruth,
            externalLinks,
            fetchedAt: rel.fetchedAt?.toISOString() ?? null,
          };
          canonicalTrackRows = (await db
            .select()
            .from(canonicalTracks)
            .where(eq(canonicalTracks.releaseId, rel.id))) as unknown as Record<string, unknown>[];
        }
      }

      const matchRows = await db
        .select()
        .from(albumMatches)
        .where(eq(albumMatches.localAlbumId, albumId));
      const liveMatch = matchRows.find((m) => m.status === 'auto' || m.status === 'confirmed');

      const art = await db
        .select({ id: images.id, origin: images.origin, license: images.licenseNote })
        .from(images)
        .where(and(eq(images.localAlbumId, albumId), eq(images.kind, 'front')))
        .limit(1);

      // Everything the album page needs to act without leaving (XO-311):
      // open/dismissed gaps, scored candidates, sibling copies of the same RG.
      const gapSubjects = album.releaseGroupId ? [albumId, album.releaseGroupId] : [albumId];
      const gapRows = await db
        .select()
        .from(gaps)
        .where(and(inArray(gaps.subjectId, gapSubjects), inArray(gaps.state, ['open', 'dismissed'])));

      const candRows = await db
        .select({
          id: matchCandidates.id,
          distance: matchCandidates.distance,
          breakdown: matchCandidates.breakdown,
          source: matchCandidates.source,
          excluded: matchCandidates.excluded,
          releaseId: releases.id,
          releaseMbid: releases.mbid,
          discogsReleaseId: releases.discogsReleaseId,
          releaseTitle: releases.title,
          releaseDate: releases.date,
          releaseCountry: releases.country,
          releaseStatus: releases.status,
          releaseTrackCount: releases.trackCount,
          releaseLabels: releases.labels,
          sourceOfTruth: releases.sourceOfTruth,
          rgArtistCredit: releaseGroups.artistCredit,
          rgMbid: releaseGroups.mbid,
        })
        .from(matchCandidates)
        .innerJoin(releases, eq(releases.id, matchCandidates.releaseId))
        .innerJoin(releaseGroups, eq(releaseGroups.id, releases.releaseGroupId))
        .where(eq(matchCandidates.localAlbumId, albumId))
        .orderBy(sql`distance asc`);

      const duplicateRows = album.releaseGroupId
        ? await db
            .select({
              id: localAlbums.id,
              title: localAlbums.titleGuess,
              artist: localAlbums.artistGuess,
              trackCount: localAlbums.trackCount,
              formats: localAlbums.formats,
              state: localAlbums.state,
              dirPaths: localAlbums.dirPaths,
            })
            .from(localAlbums)
            .where(and(
              eq(localAlbums.releaseGroupId, album.releaseGroupId),
              sql`${localAlbums.id} != ${albumId}`,
            ))
        : [];

      const missingTracks = canonicalTrackRows
        .filter((c) => !c['isDataTrack'] && !c['isVideo'])
        .filter((c) => !trackRows.some(
          (t) => (t.discNo ?? 1) === ((c['mediumNo'] as number | null) ?? 1) && t.trackNo === c['position'],
        ))
        .map((c) => ({
          disc: c['mediumNo'] ?? 1,
          position: c['position'],
          title: c['title'],
          lengthMs: c['lengthMs'] ?? null,
        }));

      reply.status(200).send({
        id: album.id,
        libraryId: album.libraryId,
        title: album.titleGuess,
        artistCredit: album.artistGuess,
        year: album.yearGuess,
        state: album.state,
        dirPaths: album.dirPaths,
        formats: album.formats,
        discCount: album.discCount,
        trackCount: album.trackCount,
        totalDurationMs: album.totalDurationMs,
        coverUrl: art[0] ? `/api/v1/images/album/${album.id}` : null,
        coverOrigin: art[0]?.origin ?? null,
        release,
        match: liveMatch
          ? {
              status: liveMatch.status,
              decidedBy: liveMatch.decidedBy,
              distance: Number(liveMatch.distance),
              decidedAt: liveMatch.decidedAt?.toISOString() ?? null,
              reason: liveMatch.reason,
            }
          : null,
        tracks: trackRows
          .sort((a, b) => (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0))
          .map((t) => {
            const canon = canonicalTrackRows.find(
              (c) => (c['mediumNo'] ?? 1) === (t.discNo ?? 1) && c['position'] === t.trackNo,
            );
            return {
              id: t.id,
              discNo: t.discNo,
              trackNo: t.trackNo,
              title: t.title,
              artist: t.artist,
              durationMs: t.durationMs,
              canonicalTitle: (canon?.['title'] as string) ?? null,
              canonicalDurationMs: (canon?.['lengthMs'] as number) ?? null,
              file: {
                id: t.fileId,
                relPath: t.relPath,
                container: t.container,
                codec: t.codec,
                lossless: t.lossless,
                bitrateKbps: t.bitrateKbps,
                sampleRate: t.sampleRate,
                bitDepth: t.bitDepth,
                sizeBytes: t.sizeBytes,
                status: t.fileStatus,
                hasEmbeddedArt: t.hasEmbeddedArt,
              },
            };
          }),
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
        missingTracks,
        gaps: gapRows.map((g) => ({
          id: g.id,
          kind: g.kind,
          state: g.state,
          dismissReason: g.dismissReason,
          details: g.details,
        })),
        candidates: candRows.map((c) => ({
          id: c.id,
          releaseId: c.releaseId,
          releaseMbid: c.releaseMbid ?? null,
          discogsReleaseId: c.discogsReleaseId ?? null,
          title: c.releaseTitle,
          artistCredit: Array.isArray(c.rgArtistCredit)
            ? (c.rgArtistCredit as string[]).join(', ')
            : String(c.rgArtistCredit ?? ''),
          date: c.releaseDate,
          country: c.releaseCountry,
          status: c.releaseStatus,
          trackCount: c.releaseTrackCount,
          labels: c.releaseLabels,
          distance: Number(c.distance),
          breakdown: c.breakdown,
          source: c.source,
          provider: c.sourceOfTruth,
          rgMbid: c.rgMbid ?? null,
          excluded: c.excluded,
        })),
        duplicates: duplicateRows,
      });
    }
  );

  // Re-fetch cover art for one album
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/fetch-art',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
      const boss = await getBossForAlbums();
      await boss.send('art.fetch', { localAlbumId: albumId }, { singletonKey: `art:${albumId}` });
      reply.status(202).send({ ok: true });
    }
  );

  // IDN-6 manual entry: paste an MB release URL / MBID or Discogs URL / ID, match it outright.
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/match-mbid',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const { input } = (request.body ?? {}) as { input?: string };

      // Try MBID first
      const mbid = input?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (mbid) {
        // Check for non-release MB URLs
        if (input && /musicbrainz\.org\/(?!release\/)[a-z-]+\//i.test(input)) {
          throw new ApiError(400, 'Bad Request', 'That is not a release URL — use the release page (musicbrainz.org/release/...), not artist or release-group');
        }
        const db = getDb();
        const lib = await db
          .select()
          .from(libraries)
          .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
        if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
        const boss = await getBossForAlbums();
        await boss.send('identify.album', { localAlbumId: albumId, force: true, pinnedMbid: mbid }, {
          singletonKey: `identify:${albumId}`,
        });
        reply.status(202).send({ ok: true, mbid });
        return;
      }

      // Try Discogs
      const discogsRef = parseDiscogsRef(input || '');
      if (discogsRef) {
        const db = getDb();
        const lib = await db
          .select()
          .from(libraries)
          .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
        if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
        const boss = await getBossForAlbums();
        await boss.send('identify.album', { localAlbumId: albumId, force: true, pinnedDiscogs: discogsRef }, {
          singletonKey: `identify:${albumId}`,
        });
        reply.status(202).send({ ok: true, discogs: discogsRef });
        return;
      }

      // Neither worked
      throw new ApiError(400, 'Bad Request', 'No MusicBrainz MBID or Discogs URL / ID found in input — paste a MusicBrainz release URL / MBID or a Discogs release / master URL / ID');
    }
  );

  // Re-run identification for one album (spec IDN-6)
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/identify',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
      const boss = await getBossForAlbums();
      await boss.send('identify.album', { localAlbumId: albumId, force: true }, {
        singletonKey: `identify:${albumId}`,
      });
      reply.status(202).send({ ok: true });
    }
  );

  // Search albums
  fastify.get('/search', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { q, type = 'album', limit = '20' } = request.query as Record<string, string>;

    if (!q) {
      throw new ApiError(400, 'Bad Request', 'Search query required');
    }

    const db = getDb();

    // Get user's libraries
    const userLibraries = await db
      .select()
      .from(libraries)
      .where(eq(libraries.ownerUserId, request.user.id));

    const libraryIds = userLibraries.map((l) => l.id);

    // Search albums across libraries
    const results: any[] = [];

    if (type === 'album' || type === 'all') {
      const albums = await db
        .select()
        .from(localAlbums)
        .limit(parseInt(limit, 10));

      const filtered = albums.filter(
        (a) =>
          libraryIds.includes(a.libraryId) &&
          (a.titleGuess?.toLowerCase().includes(q.toLowerCase()) ||
            a.artistGuess?.toLowerCase().includes(q.toLowerCase()))
      );

      results.push(
        ...filtered.map((a) => ({
          type: 'album',
          id: a.id,
          title: a.titleGuess,
          artist: a.artistGuess,
          libraryId: a.libraryId,
        }))
      );
    }

    reply.status(200).send({ results: results.slice(0, parseInt(limit, 10)) });
  });
}
