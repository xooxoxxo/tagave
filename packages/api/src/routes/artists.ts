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
import { coverKey, coversFor, fetchArtistRows, orderArtists, parseArtistGroup, parseArtistSort } from '../lib/artistList.js';

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

    const rows = await fetchArtistRows(db, libraryId, search);
    const ordered = orderArtists(rows, { sort, group });
    const page = ordered.items.slice(offsetN, offsetN + limitN);
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
      total: ordered.items.length,
      groups: ordered.groups,
      nextCursor: offsetN + limitN < ordered.items.length ? String(offsetN + limitN) : null,
    });
  });

  /**
   * GET /libraries/:libraryId/artists/:artistId
   * Artist detail with discography, links, and follow status.
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

    // Get discography grouped by release group primary type with ownership
    // Left join with gaps to include missing_album gaps (open, on the task list, or dismissed)
    const discogRows = await db.execute(sql`
      select rg.id as release_group_id,
             rg.title,
             rg.first_release_date,
             rg.primary_type,
             (select la.id from local_albums la
              where la.release_group_id = rg.id and la.library_id = ${libraryId}
              limit 1) as local_album_id,
             exists (select 1 from local_albums la
                     where la.release_group_id = rg.id and la.library_id = ${libraryId}) as has_digital,
             exists (select 1 from collection_items ci
                     where ci.release_group_id = rg.id and ci.library_id = ${libraryId}
                       and ci.removed_at is null) as has_physical,
             g.id as gap_id,
             g.state as gap_state,
             g.dismiss_reason,
             g.first_seen_at
        from release_group_artists rga
        join release_groups rg on rga.release_group_id = rg.id
        left join gaps g on g.library_id = ${libraryId}
                         and g.subject_id = rg.id
                         and g.kind = 'missing_album'
                         and g.state in ('open', 'todo', 'dismissed')
       where rga.artist_id = ${artistId}
         and (exists (select 1 from local_albums la
                      where la.release_group_id = rg.id and la.library_id = ${libraryId})
              or exists (select 1 from collection_items ci
                         where ci.release_group_id = rg.id and ci.library_id = ${libraryId}
                           and ci.removed_at is null)
              or exists (select 1 from gaps gx
                         where gx.library_id = ${libraryId}
                           and gx.subject_id = rg.id
                           and gx.kind = 'missing_album'
                           and gx.state in ('open', 'todo', 'dismissed')))
    `) as unknown as Array<{
      release_group_id: string;
      title: string;
      first_release_date: string | null;
      primary_type: string | null;
      local_album_id: string | null;
      has_digital: boolean;
      has_physical: boolean;
      gap_id: string | null;
      gap_state: string | null;
      dismiss_reason: string | null;
      first_seen_at: string | null;
    }>;

    // Get cover images for albums in the discography
    const localAlbumIds = discogRows
      .filter((r) => r.local_album_id)
      .map((r) => r.local_album_id as string);

    const artRows = localAlbumIds.length
      ? await db.select().from(images)
          .where(and(eq(images.kind, 'front'), inArray(images.localAlbumId, localAlbumIds)))
      : [];
    const withArt = new Set(artRows.map((r) => r.localAlbumId));

    // Map primary types to response types
    const typeMap: Record<string, string> = {
      'Album': 'Album',
      'EP': 'EP',
      'Single': 'Single',
      'Live': 'Live',
      'Compilation': 'Compilation',
    };
    const getType = (pt: string | null) => typeMap[pt ?? ''] || 'Other';

    // Group by primary type
    const byType = new Map<string, typeof discogRows>();
    for (const row of discogRows) {
      const type = getType(row.primary_type);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(row);
    }

    const discography = Array.from(byType.entries()).map(([type, rows]) => ({
      type,
      items: rows.map((row) => {
        // Five-state ownership logic:
        // ignored = gap exists AND gap.state='dismissed'
        // missing = neither digital nor physical AND (no gap OR gap.state='open')
        // both = both digital and physical
        // digital = only digital
        // physical = only physical
        let ownership: 'digital' | 'physical' | 'both' | 'missing' | 'ignored';
        if (row.gap_state === 'dismissed') {
          ownership = 'ignored';
        } else if (!row.has_digital && !row.has_physical) {
          ownership = 'missing';
        } else if (row.has_digital && row.has_physical) {
          ownership = 'both';
        } else if (row.has_digital) {
          ownership = 'digital';
        } else {
          ownership = 'physical';
        }

        return {
          releaseGroupId: row.release_group_id,
          title: row.title,
          firstReleaseDate: row.first_release_date,
          ownership,
          localAlbumId: row.local_album_id,
          coverUrl: row.local_album_id && withArt.has(row.local_album_id)
            ? `/api/v1/images/album/${row.local_album_id}`
            : null,
          ...(row.gap_id && {
            gapId: row.gap_id,
            dismissReason: row.dismiss_reason,
            firstSeenAt: row.first_seen_at,
          }),
        };
      }),
    }));

    // Check if enrichment is needed (null or older than 7 days)
    const needsEnrich = !artist.enrichedAt ||
      new Date(artist.enrichedAt as any).getTime() < Date.now() - ENRICH_TTL_DAYS * 86_400_000;

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
      links,
      followed,
      discography,
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
