/**
 * The artists list: canonical artists linked to the library's albums plus
 * unresolved album-artist guesses, ordered, grouped and paged.
 *
 * Rows come from @tagave/db fetchArtistRows and are ordered by @tagave/core
 * orderArtists (A–Z rules SQL collation cannot express). Computing that for
 * ~14.5k artists cost 200–400 ms per 120-row page (audit 2026-10-10), so the
 * worker keeps the ordered list in artist_list (facets.refresh) and
 * readArtistListPage pages it with an index range; the live path remains
 * for searches and for a library whose list was never built.
 */
import { sql } from 'drizzle-orm';
import { ARTIST_GROUP_ORDER, type ArtistGroupKey } from '@tagave/shared';
import { type ArtistGroupCount, type ArtistRow, type ArtistSort } from '@tagave/core';

export { fetchArtistRows } from '@tagave/db';
export {
  orderArtists, parseArtistGroup, parseArtistSort, ARTIST_SORTS,
  type ArtistRow, type ArtistSort, type ArtistGroupCount, type OrderedArtists,
} from '@tagave/core';

type Db = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export interface ArtistListPage {
  items: ArtistRow[];
  total: number;
  groups: ArtistGroupCount[];
}

/**
 * One page of the precomputed list, or null when artist_list was never
 * built for the library or a bulk action marked the facets stale since the
 * last build (then the caller computes the list live).
 *
 * Without a group filter the positions are dense (0..n-1), so "offset N" is
 * the key range pos >= N: an index range scan however deep the page. With a
 * group filter the page is an offset within that group's index range.
 */
export async function readArtistListPage(
  db: Db,
  libraryId: string,
  opts: { sort: ArtistSort; group: ArtistGroupKey | null; offset: number; limit: number },
): Promise<ArtistListPage | null> {
  const [state] = (await db.execute(sql`
    select artists_at, dirty_at from facet_state where library_id = ${libraryId}`)) as Array<{
    artists_at: Date | string | null; dirty_at: Date | string | null;
  }>;
  // raw timestamps come back as strings on the shared client: compare as Dates
  if (!state?.artists_at) return null;
  if (state.dirty_at && new Date(state.dirty_at).getTime() > new Date(state.artists_at).getTime()) return null;

  const pos = opts.sort === 'albums' ? sql.raw('pos_albums') : opts.sort === 'recent' ? sql.raw('pos_recent') : sql.raw('pos_name');
  const [rowsResult, groupRows] = await Promise.all([
    db.execute(opts.group
      ? sql`select * from artist_list where library_id = ${libraryId} and group_key = ${opts.group}
             order by ${pos} offset ${opts.offset} limit ${opts.limit}`
      : sql`select * from artist_list where library_id = ${libraryId} and ${pos} >= ${opts.offset}
             order by ${pos} limit ${opts.limit}`),
    db.execute(sql`select group_key, count(*)::int as n from artist_list where library_id = ${libraryId} group by group_key`),
  ]);
  const rows = rowsResult as Array<{
    artist_id: string | null; name: string; sort_name: string | null; resolved: boolean;
    album_count: number; track_count: number; year_from: number | null; year_to: number | null;
    added_at: Date | string | null;
  }>;
  const counts = new Map((groupRows as Array<{ group_key: ArtistGroupKey; n: number }>).map((g) => [g.group_key, Number(g.n)]));
  const groups = ARTIST_GROUP_ORDER.filter((key) => counts.has(key)).map((key) => ({ key, count: counts.get(key)! }));
  const total = opts.group ? (counts.get(opts.group) ?? 0) : [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    items: rows.map((r) => ({
      id: r.artist_id,
      name: r.name,
      sortName: r.sort_name,
      resolved: r.resolved,
      albumCount: Number(r.album_count),
      trackCount: Number(r.track_count),
      yearFrom: r.year_from,
      yearTo: r.year_to,
      addedAt: r.added_at ? new Date(r.added_at).toISOString() : null,
    })),
    total,
    groups,
  };
}

/** Map key for coversFor: the artist id, or "name:<name>" for a guess. */
export const coverKey = (row: Pick<ArtistRow, 'id' | 'name'>) => (row.id ? row.id : `name:${row.name}`);

/**
 * Up to four albums with a front cover per artist, oldest
 * first, for the card mosaic. One query for the whole page.
 */
export async function coversFor(db: Db, libraryId: string, rows: ArtistRow[], perArtist = 4): Promise<Map<string, string[]>> {
  const ids = rows.filter((r) => r.id).map((r) => r.id!);
  const names = rows.filter((r) => !r.id).map((r) => r.name);
  const out = new Map<string, string[]>();
  if (!ids.length && !names.length) return out;
  // Albums with a front cover, thumbnail built or not: a missing thumbnail
  // (after a restore) is served as a placeholder and rebuilt on that request.
  const hasThumb = sql`exists (select 1 from images im
    where im.local_album_id = la.id and im.kind = 'front')`;
  const arms = [];
  if (ids.length) {
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    arms.push(sql`
      select rga.artist_id::text as key, la.id::text as album_id, la.year_guess, la.created_at
        from release_group_artists rga
        join local_albums la on la.release_group_id = rga.release_group_id
       where la.library_id = ${libraryId}
         and rga.artist_id in (${idList})
         and ${hasThumb}`);
    // albums known only by their tags, under the artist of that name (as fetchArtistRows links them)
    arms.push(sql`
      select a.id::text as key, la.id::text as album_id, la.year_guess, la.created_at
        from artists a
        join local_albums la on la.library_id = ${libraryId}
                            and lower(tagave_display_artist(la.artist_guess)) = lower(a.name)
       where a.id in (${idList})
         and (la.release_group_id is null or not exists (
           select 1 from release_group_artists rga where rga.release_group_id = la.release_group_id))
         and ${hasThumb}`);
  }
  if (names.length) {
    arms.push(sql`
      select 'name:' || tagave_display_artist(la.artist_guess) as key, la.id::text as album_id, la.year_guess, la.created_at
        from local_albums la
       where la.library_id = ${libraryId}
         and tagave_display_artist(la.artist_guess) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
         and ${hasThumb}`);
  }
  const rowsOut = await db.execute(sql`
    select key, album_id from (
      select key, album_id,
             row_number() over (partition by key order by year_guess asc nulls last, created_at asc, album_id) as rn
        from (${sql.join(arms, sql` union all `)}) candidates
    ) ranked
    where rn <= ${perArtist}
    order by key, rn
  `) as Array<{ key: string; album_id: string }>;
  for (const r of rowsOut) {
    const list = out.get(r.key) ?? [];
    if (!list.includes(r.album_id)) list.push(r.album_id);
    out.set(r.key, list);
  }
  return out;
}
