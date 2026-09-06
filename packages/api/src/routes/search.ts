import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { libraries } from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * BRW-4: one box over albums, artists, tracks. Trigram similarity handles
 * typos; ilike prefix keeps short queries sane (similarity on 2 chars is
 * noise). Grouped result, 8 per group.
 */
export async function createSearchRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/search', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const { q } = request.query as { q?: string };
    const db = getDb();

    const lib = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
    if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

    const query = (q ?? '').trim();
    if (query.length < 2) {
      reply.send({ albums: [], artists: [], tracks: [] });
      return;
    }
    const useSimilarity = query.length >= 4;

    const albums = await db.execute(sql`
      select la.id, la.title_guess as title, la.artist_guess as artist,
             la.year_guess as year, la.state, la.track_count,
             greatest(similarity(la.title_guess, ${query}), similarity(coalesce(la.artist_guess, ''), ${query})) as score
      from local_albums la
      where la.library_id = ${libraryId}
        and (la.title_guess ilike ${'%' + query + '%'}
             or la.artist_guess ilike ${'%' + query + '%'}
             ${useSimilarity ? sql`or la.title_guess % ${query} or la.artist_guess % ${query}` : sql``})
      order by score desc nulls last
      limit 8`) as unknown as Record<string, unknown>[];

    const artists = await db.execute(sql`
      select a.id, a.name, count(distinct la.id)::int as album_count,
             greatest(
               similarity(a.name, ${query}),
               similarity(coalesce(a.sort_name, ''), ${query}),
               similarity(array_to_string(a.aliases, ' '), ${query})
             ) as score
      from local_albums la
      join release_groups rg on rg.id = la.release_group_id
      join release_group_artists rga on rga.release_group_id = rg.id
      join artists a on a.id = rga.artist_id
      where la.library_id = ${libraryId}
        and (a.name ilike ${'%' + query + '%'}
             or a.sort_name ilike ${'%' + query + '%'}
             or array_to_string(a.aliases, ' ') ilike ${'%' + query + '%'}
             ${useSimilarity ? sql`or a.name % ${query} or a.sort_name % ${query} or array_to_string(a.aliases, ' ') % ${query}` : sql``})
      group by a.id, a.name, a.sort_name, a.aliases
      order by score desc nulls last, album_count desc
      limit 8`) as unknown as Record<string, unknown>[];

    const tracks = await db.execute(sql`
      select lt.id, lt.title_guess as title, lt.local_album_id,
             la.title_guess as album_title, la.artist_guess as artist,
             similarity(lt.title_guess, ${query}) as score
      from local_tracks lt
      join local_albums la on la.id = lt.local_album_id
      where la.library_id = ${libraryId}
        and (lt.title_guess ilike ${'%' + query + '%'}
             ${useSimilarity ? sql`or lt.title_guess % ${query}` : sql``})
      order by score desc nulls last
      limit 8`) as unknown as Record<string, unknown>[];

    reply.send({
      albums: albums.map((a) => ({
        id: a['id'], title: a['title'], artist: a['artist'],
        year: a['year'], state: a['state'], trackCount: a['track_count'],
      })),
      artists: artists.map((a) => ({ id: a['id'], name: a['name'], albumCount: a['album_count'] })),
      tracks: tracks.map((t) => ({
        id: t['id'], title: t['title'], albumId: t['local_album_id'],
        albumTitle: t['album_title'], artist: t['artist'],
      })),
    });
  });
}
