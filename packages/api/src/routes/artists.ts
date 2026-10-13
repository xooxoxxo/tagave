/**
 * Artist routes: canonical + unresolved artists, detail, follow (XO-310).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  artists, releaseGroupArtists, releaseGroups, localAlbums,
  collectionItems, followedArtists, externalIds, libraries,
  images, gaps,
} from '@liner/db';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { normalizeFollowRules } from '@liner/core';
import { followRulesSchema } from '@liner/shared/library';
import { ApiError } from '../middleware/errorHandler.js';
import { followDefaultsFor } from '../lib/followRules.js';
import { fetchArtistAlbums } from '../lib/artistAlbums.js';
import {
  coverKey, coversFor, fetchArtistRows, orderArtists, parseArtistGroup, parseArtistSort, readArtistListPage,
  type ArtistGroupCount, type ArtistRow,
} from '../lib/artistList.js';

const ENRICH_TTL_DAYS = 7;

async function ownedLibrary(userId: string, libraryId: string) {
  const db = getDb();
  const rows = await db.select().from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  const lib = rows[0];
  if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
  return lib;
}

export async function createArtistsRoutes(fastify: FastifyInstance) {
  /**
   * GET /libraries/:libraryId/artists
   * Canonical artists linked to the library's release groups plus unresolved
   * artist_guess names, ordered and paged.
   *
   * Query: search (name contains), sort = name | albums | recent,
   * group = one ARTIST_GROUP_ORDER key ("A", "0-9", "other", "#"),
   * limit (<=500), offset. Each item carries up to four album ids with a
   * front cover (coverAlbumIds) for the card mosaic; `groups` counts every
   * group before the group filter so a jump bar can grey out empty letters.
   */
  fastify.get('/libraries/:libraryId/artists', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const query = request.query as Record<string, string | undefined>;
    const search = (query['search'] ?? '').trim();
    const sort = parseArtistSort(query['sort']);
    const group = parseArtistGroup(query['group']);

    await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    const limitN = Math.max(1, Math.min(parseInt(query['limit'] ?? '', 10) || 100, 500));
    const offsetN = Math.max(0, parseInt(query['offset'] ?? '', 10) || 0);

    // The worker-built artist_list answers unsearched pages with an index
    // range; a search (or a list never built) computes the rows live.
    const summary = search ? null : await readArtistListPage(db, libraryId, { sort, group, offset: offsetN, limit: limitN });
    let page: ArtistRow[];
    let ordered: { total: number; groups: ArtistGroupCount[] };
    if (summary) {
      page = summary.items;
      ordered = summary;
      reply.header('x-liner-artists', 'summary');
    } else {
      const all = orderArtists(await fetchArtistRows(db, libraryId, search), { sort, group });
      page = all.items.slice(offsetN, offsetN + limitN);
      ordered = { total: all.items.length, groups: all.groups };
      reply.header('x-liner-artists', 'live');
    }
    const covers = await coversFor(db, libraryId, page);

    reply.send({
      items: page.map((r) => ({
        id: r.id,
        name: r.name,
        sortName: r.sortName,
        albumCount: r.albumCount,
        trackCount: r.trackCount,
        yearFrom: r.yearFrom,
        yearTo: r.yearTo,
        resolved: r.resolved,
        addedAt: r.addedAt,
        coverAlbumIds: covers.get(coverKey(r)) ?? [],
      })),
      total: ordered.total,
      groups: ordered.groups,
      nextCursor: offsetN + limitN < ordered.total ? String(offsetN + limitN) : null,
    });
  });

  /**
   * GET /libraries/:libraryId/artists/:artistId
   * Artist detail: details, links, follow status, the albums the library
   * holds (owned: albums · tracks) and a followed artist's missing ones.
   * Side effect: enqueue artists.enrich if enriched_at is null or older than 7 days.
   * Side effect: update followed_artists.last_viewed_at to current timestamp if artist is followed.
   */
  fastify.get('/libraries/:libraryId/artists/:artistId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };

    await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    // Get artist
    const [artist] = await db.select().from(artists).where(eq(artists.id, artistId));
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');

    // Check if followed
    const [followRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    const followed = !!followRow;

    // Update last_viewed_at if artist is followed
    if (followed) {
      await db.update(followedArtists)
        .set({ lastViewedAt: new Date() })
        .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    }

    // Get external IDs for links
    const extIds = await db.select().from(externalIds)
      .where(and(eq(externalIds.entityType, 'artist'), eq(externalIds.entityId, artistId)));

    const links: Record<string, string | undefined> = {
      musicbrainz: artist.mbid ? `https://musicbrainz.org/artist/${artist.mbid}` : undefined,
      discogs: artist.discogsId ? `https://www.discogs.com/artist/${artist.discogsId}` : undefined,
    };

    for (const ext of extIds) {
      if (ext.provider === 'wikidata') {
        links.wikidata = `https://www.wikidata.org/wiki/${ext.externalId}`;
      } else if (ext.provider === 'wikipedia') {
        links.wikipedia = ext.url || `https://en.wikipedia.org/wiki/${ext.externalId}`;
      }
    }

    // What the library holds of the artist (credited and tag-matched albums,
    // the shelf) and what a followed artist is missing (lib/artistAlbums.ts)
    const { albums, owned } = await fetchArtistAlbums(db, libraryId, { id: artist.id, name: artist.name });

    // Check if enrichment is needed (null or older than 7 days)
    // Enrichment reads MusicBrainz by MBID: an artist without one is never
    // enriched, so nothing is queued and the page shows what it has.
    const canEnrich = !!artist.mbid;
    const needsEnrich = canEnrich && (!artist.enrichedAt ||
      new Date(artist.enrichedAt as any).getTime() < Date.now() - ENRICH_TTL_DAYS * 86_400_000);

    if (needsEnrich) {
      try {
        const boss = await getBoss();
        await boss.send('artists.enrich', { artistId }, {
          singletonKey: `artist:${artistId}`,
          retryLimit: 2,
          retryDelay: 30,
        });
      } catch (err) {
        // Fire-and-forget: log but don't fail the response
        console.warn('Failed to enqueue artists.enrich', { artistId, err });
      }
    }

    reply.send({
      id: artist.id,
      mbid: artist.mbid,
      discogsId: artist.discogsId,
      name: artist.name,
      sortName: artist.sortName,
      disambiguation: artist.disambiguation,
      type: artist.type,
      country: artist.country,
      beginDate: artist.beginDate ? new Date(artist.beginDate as any).toISOString().split('T')[0] : null,
      endDate: artist.endDate ? new Date(artist.endDate as any).toISOString().split('T')[0] : null,
      aliases: artist.aliases ?? [],
      bio: artist.bio ? (typeof artist.bio === 'string' ? JSON.parse(artist.bio) : artist.bio) : null,
      enrichedAt: artist.enrichedAt ? new Date(artist.enrichedAt as any).toISOString() : null,
      enrichError: artist.enrichError,
      canEnrich,
      links,
      followed,
      albums,
      owned,
    });
  });

  /**
   * POST /libraries/:libraryId/artists/:artistId/follow
   * Follow or unfollow an artist.
   */
  fastify.post('/libraries/:libraryId/artists/:artistId/follow', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };
    const { followed } = request.body as { followed?: boolean };

    const lib = await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    // Verify artist exists
    const [artist] = await db.select().from(artists).where(eq(artists.id, artistId));
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');

    if (followed) {
      // Insert or update (upsert)
      const [existing] = await db.select().from(followedArtists)
        .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

      if (!existing) {
        // Type filters start as a copy of the library's follow rules (XO-345),
        // not the schema defaults, so a library that follows EPs gets EP gaps.
        const defaults = followDefaultsFor(lib.settings);
        await db.insert(followedArtists).values({
          libraryId,
          artistId,
          mode: 'manual',
          includePrimary: defaults.includePrimary,
          excludeSecondary: defaults.excludeSecondary,
        });
      }
    } else {
      // Delete
      await db.delete(followedArtists)
        .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    }

    reply.send({ followed });
  });

  /**
   * POST /libraries/:libraryId/artists/:artistId/enrich
   * Fetch the artist's details again (MusicBrainz, Wikidata, Wikipedia): the
   * Maintenance "Refresh details" and the Retry after a failed fetch. Clears
   * the last error and the enrichment time, so the page shows the fetch in
   * progress until the job finishes; a followed artist's discography is
   * refreshed with it.
   */
  fastify.post('/libraries/:libraryId/artists/:artistId/enrich', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };

    await ownedLibrary(request.user.id, libraryId);
    const db = getDb();
    const [artist] = await db.select().from(artists).where(eq(artists.id, artistId));
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');
    if (!artist.mbid) throw new ApiError(409, 'Conflict', 'This artist has no MusicBrainz id to fetch details by');
    const [followRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    try {
      const boss = await getBoss();
      await boss.send('artists.enrich', { artistId, force: true }, {
        singletonKey: `artist:${artistId}`,
        retryLimit: 2,
        retryDelay: 30,
      });
      if (followRow) {
        await boss.send('artist.refresh', { libraryId, artistId, force: true }, {
          singletonKey: `artist.refresh:${artistId}`,
          retryLimit: 2,
          retryDelay: 30,
        });
      }
    } catch (err) {
      console.warn('Failed to enqueue artists.enrich', { artistId, err });
      throw new ApiError(500, 'Internal Server Error', 'Failed to enqueue the details fetch');
    }
    // queued: the page shows the fetch until enriched_at is set again
    await db.update(artists).set({ enrichedAt: null, enrichError: null }).where(eq(artists.id, artistId));
    reply.code(202).send({ queued: true });
  });

  /**
   * POST /libraries/:libraryId/artists/:artistId/refresh
   * Enqueue manual refresh of artist's discography from MusicBrainz (XO-348).
   * Only allowed if artist is followed.
   */
  fastify.post('/libraries/:libraryId/artists/:artistId/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };

    await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    // Verify artist exists
    const [artist] = await db.select().from(artists).where(eq(artists.id, artistId));
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');

    // Verify artist is followed
    const [followRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    if (!followRow) throw new ApiError(403, 'Forbidden', 'Artist must be followed to refresh');

    try {
      const boss = await getBoss();
      // force: a manual refresh must reach MusicBrainz, not the 6-day browse cache
      await boss.send('artist.refresh', { libraryId, artistId, force: true }, {
        singletonKey: `artist.refresh:${artistId}`,
        retryLimit: 2,
        retryDelay: 30,
      });
    } catch (err) {
      console.warn('Failed to enqueue artist.refresh', { libraryId, artistId, err });
      throw new ApiError(500, 'Internal Server Error', 'Failed to enqueue refresh job');
    }

    reply.send({ discographyUpdated: false });
  });

  /**
   * PATCH /libraries/:libraryId/artists/:artistId/follow-rules
   * Update per-artist type filter overrides (includePrimary, excludeSecondary).
   * Artist must be followed first.
   */
  fastify.patch('/libraries/:libraryId/artists/:artistId/follow-rules', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };
    const body = request.body as { includePrimary?: string[]; excludeSecondary?: string[] };

    await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    // Verify artist exists
    const [artist] = await db.select().from(artists).where(eq(artists.id, artistId));
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');

    // Verify artist is followed
    const [followRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    if (!followRow) throw new ApiError(403, 'Forbidden', 'Artist must be followed to set type filters');

    // Validate and normalize the provided rules
    const current = {
      includePrimary: (followRow.includePrimary ?? ['Album']) as string[],
      excludeSecondary: (followRow.excludeSecondary ?? ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack']) as string[],
    };

    const updates: Record<string, unknown> = {};
    let normalized;
    try {
      normalized = normalizeFollowRules({
        includePrimary: (body.includePrimary ?? current.includePrimary) as any,
        excludeSecondary: (body.excludeSecondary ?? current.excludeSecondary) as any,
      });
    } catch (err) {
      throw new ApiError(400, 'Bad Request', (err as Error).message);
    }

    if (body.includePrimary !== undefined) {
      updates.includePrimary = normalized.includePrimary;
    }
    if (body.excludeSecondary !== undefined) {
      updates.excludeSecondary = normalized.excludeSecondary;
    }

    if (Object.keys(updates).length > 0) {
      await db.update(followedArtists)
        .set(updates)
        .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    }

    // Return the updated arrays
    const [updated] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    if (!updated) {
      throw new ApiError(500, 'Internal Server Error', 'Failed to retrieve updated follow rules');
    }

    reply.send({
      includePrimary: (updated.includePrimary ?? ['Album']) as string[],
      excludeSecondary: (updated.excludeSecondary ?? ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack']) as string[],
    });
  });

  /**
   * POST /libraries/:libraryId/artists/:artistId/follow-rules/reset
   * Reset per-artist type filters to library defaults.
   * Artist must be followed first.
   */
  fastify.post('/libraries/:libraryId/artists/:artistId/follow-rules/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };

    const lib = await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    // Verify artist exists
    const [artist] = await db.select().from(artists).where(eq(artists.id, artistId));
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');

    // Verify artist is followed
    const [followRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    if (!followRow) throw new ApiError(403, 'Forbidden', 'Artist must be followed to reset type filters');

    // Get library defaults from settings
    const settings = typeof lib.settings === 'string'
      ? JSON.parse(lib.settings)
      : (lib.settings ?? {});
    const followRulesRaw = (settings as Record<string, any>)['followRules'] ?? null;
    let libraryDefaults;
    try {
      libraryDefaults = normalizeFollowRules(followRulesRaw);
    } catch {
      throw new ApiError(400, 'Bad Request', 'Invalid library follow rules configuration');
    }

    // Copy library defaults to artist row
    await db.update(followedArtists)
      .set({
        includePrimary: libraryDefaults.includePrimary,
        excludeSecondary: libraryDefaults.excludeSecondary,
      })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    reply.send({
      includePrimary: libraryDefaults.includePrimary,
      excludeSecondary: libraryDefaults.excludeSecondary,
    });
  });
}
