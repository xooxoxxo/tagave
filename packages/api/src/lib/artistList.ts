/**
 * The artists list: canonical artists linked to the library's albums plus
 * unresolved album-artist guesses, ordered, grouped and paged.
 *
 * Ordering happens here rather than in SQL because "A–Z" has rules SQL
 * collation cannot express portably: control and zero-width characters are
 * ignored, symbol-only and blank names file last under "#", other scripts
 * keep their own group, and a leading "The" does not count (see
 * @liner/shared artistLabels). A library has at most tens of thousands of
 * artist rows, so sorting the aggregated rows in memory costs a few
 * milliseconds next to the aggregate query itself.
 */
import { sql } from 'drizzle-orm';
import {
  ARTIST_GROUP_ORDER, artistGroup, artistNameKey, compareArtistNameKeys, type ArtistGroupKey,
} from '@liner/shared';

export type ArtistSort = 'name' | 'albums' | 'recent';
export const ARTIST_SORTS: readonly ArtistSort[] = ['name', 'albums', 'recent'];

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

export interface ArtistGroupCount { key: ArtistGroupKey; count: number }

export interface OrderedArtists {
  items: ArtistRow[];
  /** every group with at least one artist, in list order, before the group filter */
  groups: ArtistGroupCount[];
}

export function parseArtistSort(value: unknown): ArtistSort {
  return ARTIST_SORTS.includes(value as ArtistSort) ? value as ArtistSort : 'name';
}

export function parseArtistGroup(value: unknown): ArtistGroupKey | null {
  return typeof value === 'string' && ARTIST_GROUP_ORDER.includes(value) ? value : null;
}

/** Sort rows, count groups, then keep one group when asked. Pure. */
export function orderArtists(rows: ArtistRow[], opts: { sort: ArtistSort; group?: ArtistGroupKey | null }): OrderedArtists {
  const keyed = rows.map((row) => ({ row, key: artistNameKey(row), group: artistGroup(row.name, row.sortName) }));
  const byName = (a: typeof keyed[number], b: typeof keyed[number]) => compareArtistNameKeys(a.key, b.key);
  const time = (row: ArtistRow) => (row.addedAt ? Date.parse(row.addedAt) : 0);
  keyed.sort(
    opts.sort === 'albums' ? (a, b) => b.row.albumCount - a.row.albumCount || byName(a, b)
      : opts.sort === 'recent' ? (a, b) => time(b.row) - time(a.row) || byName(a, b)
        : byName,
  );

  const counts = new Map<ArtistGroupKey, number>();
  for (const k of keyed) counts.set(k.group, (counts.get(k.group) ?? 0) + 1);
  const groups = ARTIST_GROUP_ORDER.filter((key) => counts.has(key)).map((key) => ({ key, count: counts.get(key)! }));

  const kept = opts.group ? keyed.filter((k) => k.group === opts.group) : keyed;
  return { items: kept.map((k) => k.row), groups };
}

type Db = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** Every artist row of a library, optionally narrowed by a name search. */
export async function fetchArtistRows(db: Db, libraryId: string, search: string): Promise<ArtistRow[]> {
  const like = `%${search}%`;
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
             max(la.year_guess)::int as year_to,
             max(la.created_at) as added_at
        from artists a
        join release_group_artists rga on a.id = rga.artist_id
        join release_groups rg on rga.release_group_id = rg.id
        join local_albums la on rg.id = la.release_group_id
       where la.library_id = ${libraryId}
         ${search ? sql`and (a.name ilike ${like} or a.sort_name ilike ${like})` : sql``}
       group by a.id, a.name, a.sort_name
    ),
    canon_names as (select distinct lower(name) as lname from canon),
    guess as (
      -- Unresolved artist guesses (no release group, or one with no credits).
      -- A name that already has a canonical row is dropped: the artist's
      -- undecided albums must not add a second, unclickable row for them.
      -- casts are required: a bare null in a CTE arm is text, and the
      -- union against canon.id (uuid) / canon.sort_name (varchar) fails.
      -- Names group as shown (migration 0028): "02. Stephane Pompougnac"
      -- … "17. Stephane Pompougnac" are one artist, and "Various", "VA"
      -- and "Various Artists" one compilations row.
      select null::uuid as id,
             liner_display_artist(la.artist_guess) as name,
             null::varchar as sort_name,
             false as resolved,
             count(distinct la.id)::int as album_count,
             coalesce(sum(la.track_count), 0)::int as track_count,
             min(la.year_guess)::int as year_from,
             max(la.year_guess)::int as year_to,
             max(la.created_at) as added_at
        from local_albums la
       where la.library_id = ${libraryId}
         and liner_display_artist(la.artist_guess) is not null
         and (la.release_group_id is null or not exists (
           select 1 from release_group_artists rga
            where rga.release_group_id = la.release_group_id))
         and not exists (
           select 1 from canon_names cn where cn.lname = lower(liner_display_artist(la.artist_guess)))
         ${search ? sql`and la.artist_guess ilike ${like}` : sql``}
       group by liner_display_artist(la.artist_guess)
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

/** Map key for coversFor: the artist id, or "name:<name>" for a guess. */
export const coverKey = (row: Pick<ArtistRow, 'id' | 'name'>) => (row.id ? row.id : `name:${row.name}`);

/**
 * Up to four albums with a stored front-cover thumbnail per artist, oldest
 * first, for the card mosaic. One query for the whole page.
 */
export async function coversFor(db: Db, libraryId: string, rows: ArtistRow[], perArtist = 4): Promise<Map<string, string[]>> {
  const ids = rows.filter((r) => r.id).map((r) => r.id!);
  const names = rows.filter((r) => !r.id).map((r) => r.name);
  const out = new Map<string, string[]>();
  if (!ids.length && !names.length) return out;
  const hasThumb = sql`exists (select 1 from images im
    where im.local_album_id = la.id and im.kind = 'front' and im.thumb_bytes is not null)`;
  const arms = [];
  if (ids.length) {
    arms.push(sql`
      select rga.artist_id::text as key, la.id::text as album_id, la.year_guess, la.created_at
        from release_group_artists rga
        join local_albums la on la.release_group_id = rga.release_group_id
       where la.library_id = ${libraryId}
         and rga.artist_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
         and ${hasThumb}`);
  }
  if (names.length) {
    arms.push(sql`
      select 'name:' || liner_display_artist(la.artist_guess) as key, la.id::text as album_id, la.year_guess, la.created_at
        from local_albums la
       where la.library_id = ${libraryId}
         and liner_display_artist(la.artist_guess) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
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
