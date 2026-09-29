import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { libraries } from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * Match tier of one text column against the query, lower is better:
 *   0 exact
 *   1 starts with the query as whole words   ("road salt" → "Road Salt One")
 *   2 the query's whole words appear anywhere ("salt" → "Road Salt One")
 *   3 starts with the query mid-word          ("salt" → "Salty Dog")
 *   4 a later word starts with the query      ("salt" → "Sea Saltwater")
 *   5 substring anywhere
 *   6 fuzzy only, or a null column            ("salt" → "Salva")
 *
 * `words` is the query folded to lowercase words joined by single spaces;
 * the column is folded the same way in SQL, so punctuation never breaks a
 * word match.
 */
export function rankSql(column: SQL, lowered: string, words: string, like: string): SQL {
  const folded = sql`(' ' || regexp_replace(lower(coalesce(${column}, '')), '[^[:alnum:]]+', ' ', 'g') || ' ')`;
  const w = escapeLike(words);
  const hasWords = words !== '';
  return sql`(case
    when lower(${column}) = ${lowered} then 0
    ${hasWords ? sql`when ${folded} like ${' ' + w + ' %'} then 1
    when ${folded} like ${'% ' + w + ' %'} then 2` : sql``}
    when lower(${column}) like ${escapeLike(lowered) + '%'} then 3
    ${hasWords ? sql`when ${folded} like ${'% ' + w + '%'} then 4` : sql``}
    when ${column} ilike ${like} then 5
    else 6 end)`;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** The query folded to lowercase words, the same way rankSql folds a column. */
export function foldWords(query: string): string {
  return query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * BRW-4: one box over albums, artists, tracks. Trigram similarity handles
 * typos; ilike prefix keeps short queries sane (similarity on 2 chars is
 * noise). Grouped result, 8 per group.
 *
 * Rows are ordered by match tier first (rankSql) and similarity second: a
 * trigram score alone let fuzzy "Salva" push "Road Salt One" down for "salt".
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
    const like = '%' + escapeLike(query) + '%';
    const lowered = query.toLowerCase();
    const words = foldWords(query);
    const rank = (column: SQL) => rankSql(column, lowered, words, like);

    const albums = await db.execute(sql`
      select la.id, la.title_guess as title, la.artist_guess as artist,
             la.year_guess as year, la.state, la.track_count,
             least(${rank(sql`la.title_guess`)}, ${rank(sql`la.artist_guess`)} + 1) as rank,
             greatest(similarity(la.title_guess, ${query}), similarity(coalesce(la.artist_guess, ''), ${query})) as score
      from local_albums la
      where la.library_id = ${libraryId}
        and (la.title_guess ilike ${like}
             or la.artist_guess ilike ${like}
             ${useSimilarity ? sql`or la.title_guess % ${query} or la.artist_guess % ${query}` : sql``})
      order by rank asc, score desc nulls last, lower(la.title_guess) asc
      limit 8`) as unknown as Record<string, unknown>[];

    // Canonical artists credited on this library's release groups, plus the
    // names that exist only in tags (albums with no credited release group).
    // Tag-only names are most of a young library, and leaving them out kept
    // this group empty. A tag-only name that also has a canonical row is
    // dropped so the same artist never shows twice.
    const artists = await db.execute(sql`
      with canon as (
        select a.id, a.name, count(distinct la.id)::int as album_count,
               least(${rank(sql`a.name`)}, ${rank(sql`a.sort_name`)},
                     ${rank(sql`array_to_string(a.aliases, ' ')`)} + 1) as rank,
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
          and (a.name ilike ${like}
               or a.sort_name ilike ${like}
               or array_to_string(a.aliases, ' ') ilike ${like}
               ${useSimilarity ? sql`or a.name % ${query} or a.sort_name % ${query} or array_to_string(a.aliases, ' ') % ${query}` : sql``})
        group by a.id, a.name, a.sort_name, a.aliases
      ),
      guess as (
        select null::uuid as id, la.artist_guess as name, count(distinct la.id)::int as album_count,
               min(${rank(sql`la.artist_guess`)}) as rank,
               max(similarity(la.artist_guess, ${query})) as score
        from local_albums la
        where la.library_id = ${libraryId}
          and la.artist_guess is not null
          and (la.release_group_id is null or not exists (
            select 1 from release_group_artists rga where rga.release_group_id = la.release_group_id))
          and (la.artist_guess ilike ${like}
               ${useSimilarity ? sql`or la.artist_guess % ${query}` : sql``})
          and not exists (select 1 from canon c where lower(c.name) = lower(la.artist_guess))
        group by la.artist_guess
      )
      select * from (select * from canon union all select * from guess) combined
      order by rank asc, score desc nulls last, album_count desc, lower(name) asc
      limit 8`) as unknown as Record<string, unknown>[];

    // Tracks match on their title or their own artist: on a compilation
    // each track credits someone else, and the row names that artist.
    const tracks = await db.execute(sql`
      select lt.id, lt.title_guess as title, lt.local_album_id,
             la.title_guess as album_title,
             coalesce(nullif(btrim(lt.artist_guess), ''), la.artist_guess) as artist,
             least(${rank(sql`lt.title_guess`)}, ${rank(sql`lt.artist_guess`)} + 1) as rank,
             greatest(similarity(lt.title_guess, ${query}), similarity(coalesce(lt.artist_guess, ''), ${query})) as score
      from local_tracks lt
      join local_albums la on la.id = lt.local_album_id
      where la.library_id = ${libraryId}
        and (lt.title_guess ilike ${like}
             or lt.artist_guess ilike ${like}
             ${useSimilarity ? sql`or lt.title_guess % ${query} or lt.artist_guess % ${query}` : sql``})
      order by rank asc, score desc nulls last, lower(lt.title_guess) asc
      limit 8`) as unknown as Record<string, unknown>[];

    reply.send({
      albums: albums.map((a) => ({
        id: a['id'], title: a['title'], artist: a['artist'],
        year: a['year'], state: a['state'], trackCount: a['track_count'],
      })),
      // id is null for a tag-only artist: the client opens the albums
      // filtered by that name instead of an artist page.
      artists: artists.map((a) => ({ id: a['id'], name: a['name'], albumCount: a['album_count'] })),
      tracks: tracks.map((t) => ({
        id: t['id'], title: t['title'], albumId: t['local_album_id'],
        albumTitle: t['album_title'], artist: t['artist'],
      })),
    });
  });
}
