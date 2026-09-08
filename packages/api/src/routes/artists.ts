/**
 * Artist routes: canonical + unresolved artists, detail, follow (XO-310).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  artists, releaseGroupArtists, releaseGroups, localAlbums,
  collectionItems, followedArtists, externalIds, libraries,
  images,
} from '@liner/db';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';

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
   * List canonical + unresolved artists (union of canonical artists linked to the library's RGs,
   * and unresolved artist_guess entries).
   */
  fastify.get('/libraries/:libraryId/artists', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const { search = '', limit = '100', offset = '0' } = request.query as Record<string, string>;

    await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    const limitN = Math.min(parseInt(limit, 10) || 100, 500);
    const offsetN = parseInt(offset, 10) || 0;

    // Union of canonical artists and unresolved guesses
    const rows = await db.execute(sql`
      with canon as (
        -- Canonical artists linked to release groups of the library's albums
        select a.id,
               a.name,
               a.sort_name,
               true as resolved,
               count(distinct la.id)::int as album_count,
               coalesce(sum(la.track_count), 0)::int as track_count,
               min(la.year_guess)::int as year_from,
               max(la.year_guess)::int as year_to
          from artists a
          join release_group_artists rga on a.id = rga.artist_id
          join release_groups rg on rga.release_group_id = rg.id
          join local_albums la on rg.id = la.release_group_id
         where la.library_id = ${libraryId}
           ${search ? sql`and (a.name ilike ${('%' + search + '%')}
                             or a.sort_name ilike ${('%' + search + '%')})` : sql``}
         group by a.id, a.name, a.sort_name
      ),
      canon_names as (select distinct lower(name) as lname from canon),
      guess as (
        -- Unresolved artist guesses (no release group, or one with no credits).
        -- A name that already has a canonical row is dropped: the artist's
        -- undecided albums must not add a second, unclickable row for them.
        -- casts are required: a bare null in a CTE arm is text, and the
        -- union against canon.id (uuid) / canon.sort_name (varchar) fails
        select null::uuid as id,
               la.artist_guess as name,
               null::varchar as sort_name,
               false as resolved,
               count(distinct la.id)::int as album_count,
               coalesce(sum(la.track_count), 0)::int as track_count,
               min(la.year_guess)::int as year_from,
               max(la.year_guess)::int as year_to
          from local_albums la
         where la.library_id = ${libraryId}
           and la.artist_guess is not null
           and (la.release_group_id is null or not exists (
             select 1 from release_group_artists rga
              where rga.release_group_id = la.release_group_id))
           and not exists (
             select 1 from canon_names cn where cn.lname = lower(la.artist_guess))
           ${search ? sql`and la.artist_guess ilike ${('%' + search + '%')}` : sql``}
         group by la.artist_guess
      )
      select * from (select * from canon union all select * from guess) combined
      order by lower(name)
      limit ${limitN + 1} offset ${offsetN}
    `) as unknown as Array<{
      id: string | null;
      name: string;
      sort_name: string | null;
      resolved: boolean;
      album_count: number;
      track_count: number;
      year_from: number | null;
      year_to: number | null;
    }>;

    const items = rows.slice(0, limitN).map((r) => ({
      id: r.id,
      name: r.name,
      sortName: r.sort_name,
      albumCount: r.album_count,
      trackCount: r.track_count,
      yearFrom: r.year_from,
      yearTo: r.year_to,
      resolved: r.resolved,
    }));

    reply.send({
      items,
      nextCursor: rows.length > limitN ? String(offsetN + limitN) : null,
    });
  });

  /**
   * GET /libraries/:libraryId/artists/:artistId
   * Artist detail with discography, links, and follow status.
   * Side effect: enqueue artists.enrich if enriched_at is null or older than 7 days.
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
                       and ci.removed_at is null) as has_physical
        from release_group_artists rga
        join release_groups rg on rga.release_group_id = rg.id
       where rga.artist_id = ${artistId}
         and (exists (select 1 from local_albums la
                      where la.release_group_id = rg.id and la.library_id = ${libraryId})
              or exists (select 1 from collection_items ci
                         where ci.release_group_id = rg.id and ci.library_id = ${libraryId}
                           and ci.removed_at is null))
    `) as unknown as Array<{
      release_group_id: string;
      title: string;
      first_release_date: string | null;
      primary_type: string | null;
      local_album_id: string | null;
      has_digital: boolean;
      has_physical: boolean;
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
      items: rows.map((row) => ({
        releaseGroupId: row.release_group_id,
        title: row.title,
        firstReleaseDate: row.first_release_date,
        ownership: (row.has_digital && row.has_physical) ? 'both' : row.has_digital ? 'digital' : 'physical',
        localAlbumId: row.local_album_id,
        coverUrl: row.local_album_id && withArt.has(row.local_album_id)
          ? `/api/v1/images/album/${row.local_album_id}`
          : null,
      })),
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

    await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    // Verify artist exists
    const [artist] = await db.select().from(artists).where(eq(artists.id, artistId));
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');

    if (followed) {
      // Insert or update (upsert)
      const [existing] = await db.select().from(followedArtists)
        .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

      if (!existing) {
        await db.insert(followedArtists).values({
          libraryId,
          artistId,
          mode: 'manual',
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
      await boss.send('artist.refresh', { libraryId, artistId }, {
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
}
