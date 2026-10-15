/**
 * The artists list rows of a library: canonical artists linked to the
 * library's albums (identified, or by an album-artist tag that names them)
 * plus the remaining unresolved album-artist guesses, aggregated but not
 * ordered (ordering lives in @tagave/core orderArtists). Shared by the API
 * (live list, searches) and the worker (facets.refresh rebuilds artist_list).
 */
import { sql } from 'drizzle-orm';

export interface ArtistRow {
  id: string | null;
  name: string;
  sortName: string | null;
  resolved: boolean;
  albumCount: number;
  trackCount: number;
  yearFrom: number | null;
  yearTo: number | null;
  /** when the newest of the artist's albums was first scanned (ISO) */
  addedAt: string | null;
}

type Db = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** Every artist row of a library, optionally narrowed by a name search. */
export async function fetchArtistRows(db: Db, libraryId: string, search: string): Promise<ArtistRow[]> {
  const like = `%${search}%`;
  const rows = await db.execute(sql`
    with linked as (
      -- Albums of identified release groups, under each credited artist
      select rga.artist_id, la.id as album_id, la.track_count, la.year_guess, la.created_at
        from local_albums la
        join release_group_artists rga on rga.release_group_id = la.release_group_id
       where la.library_id = ${libraryId}
      union
      -- Albums known only by their tags (no release group, or one with no
      -- credits) under the artist of that name (0040): Aarni's demos belong
      -- to Aarni even when only the split release was identified
      select a.id, la.id, la.track_count, la.year_guess, la.created_at
        from local_albums la
        join artists a on lower(a.name) = lower(tagave_display_artist(la.artist_guess))
       where la.library_id = ${libraryId}
         and tagave_display_artist(la.artist_guess) is not null
         and (la.release_group_id is null or not exists (
           select 1 from release_group_artists rga
            where rga.release_group_id = la.release_group_id))
    ),
    canon as (
      -- Canonical artists with albums in the library
      select a.id,
             a.name,
             a.sort_name,
             true as resolved,
             count(distinct l.album_id)::int as album_count,
             coalesce(sum(l.track_count), 0)::int as track_count,
             min(l.year_guess)::int as year_from,
             max(l.year_guess)::int as year_to,
             max(l.created_at) as added_at
        from linked l
        join artists a on a.id = l.artist_id
       where true
         ${search ? sql`and (a.name ilike ${like} or a.sort_name ilike ${like})` : sql``}
       group by a.id, a.name, a.sort_name
    ),
    canon_names as (select distinct lower(name) as lname from canon),
    guess as (
      -- Unresolved artist guesses (no release group, or one with no credits).
      -- A name that already has a canonical row is dropped: its albums are
      -- counted there (linked), not in a second, unclickable row.
      -- casts are required: a bare null in a CTE arm is text, and the
      -- union against canon.id (uuid) / canon.sort_name (varchar) fails.
      -- Names group as shown (migration 0028): "02. Stephane Pompougnac"
      -- … "17. Stephane Pompougnac" are one artist, and "Various", "VA"
      -- and "Various Artists" one compilations row.
      select null::uuid as id,
             tagave_display_artist(la.artist_guess) as name,
             null::varchar as sort_name,
             false as resolved,
             count(distinct la.id)::int as album_count,
             coalesce(sum(la.track_count), 0)::int as track_count,
             min(la.year_guess)::int as year_from,
             max(la.year_guess)::int as year_to,
             max(la.created_at) as added_at
        from local_albums la
       where la.library_id = ${libraryId}
         and tagave_display_artist(la.artist_guess) is not null
         and (la.release_group_id is null or not exists (
           select 1 from release_group_artists rga
            where rga.release_group_id = la.release_group_id))
         and not exists (
           select 1 from canon_names cn where cn.lname = lower(tagave_display_artist(la.artist_guess)))
         ${search ? sql`and la.artist_guess ilike ${like}` : sql``}
       group by tagave_display_artist(la.artist_guess)
    )
    select * from canon union all select * from guess
  `) as Array<{
    id: string | null; name: string; sort_name: string | null; resolved: boolean;
    album_count: number; track_count: number; year_from: number | null; year_to: number | null;
    added_at: string | Date | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sortName: r.sort_name,
    resolved: r.resolved,
    albumCount: r.album_count,
    trackCount: r.track_count,
    yearFrom: r.year_from,
    yearTo: r.year_to,
    addedAt: r.added_at ? new Date(r.added_at).toISOString() : null,
  }));
}
