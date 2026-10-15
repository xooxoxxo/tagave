/**
 * Ordering, grouping and positions of the artists list (rows from
 * @tagave/db fetchArtistRows).
 *
 * Ordering happens here rather than in SQL because "A–Z" has rules SQL
 * collation cannot express portably: control and zero-width characters are
 * ignored, symbol-only and blank names file last under "#", other scripts
 * keep their own group, and a leading "The" does not count (see
 * @tagave/shared artistLabels). A library has at most tens of thousands of
 * artist rows, so sorting the aggregated rows in memory costs a few
 * milliseconds next to the aggregate query itself.
 */
import {
  ARTIST_GROUP_ORDER, artistGroup, artistNameKey, compareArtistNameKeys, type ArtistGroupKey,
} from '@tagave/shared';

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

export interface ArtistPositions<T extends ArtistRow = ArtistRow> {
  row: T;
  posName: number;
  posAlbums: number;
  posRecent: number;
  group: ArtistGroupKey;
}

/**
 * Each row's 0-based position under every sort, for artist_list (built by
 * facets.refresh): the API pages a sort with an index range on its column.
 * Returned in A–Z order.
 */
export function artistListPositions<T extends ArtistRow>(rows: T[]): ArtistPositions<T>[] {
  const byName = orderArtists(rows, { sort: 'name' }).items as T[];
  const byAlbums = orderArtists(rows, { sort: 'albums' }).items;
  const byRecent = orderArtists(rows, { sort: 'recent' }).items;
  const albumsPos = new Map(byAlbums.map((r, i) => [r, i]));
  const recentPos = new Map(byRecent.map((r, i) => [r, i]));
  return byName.map((row, i) => ({
    row,
    posName: i,
    posAlbums: albumsPos.get(row)!,
    posRecent: recentPos.get(row)!,
    group: artistGroup(row.name, row.sortName),
  }));
}
