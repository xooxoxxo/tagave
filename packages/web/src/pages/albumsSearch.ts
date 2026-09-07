/**
 * URL search params of /albums (spec BRW-1: filters are URL-encoded so views
 * are bookmarkable). Kept as a pure module so the router and the page share
 * one parser without a circular import. Multi-value filters travel as arrays
 * in the browser URL and as repeated parameters on the API request.
 */
import { MULTI_FILTER_KEYS, type AlbumsQuery, type MultiFilterKey } from '@liner/shared';

export type AlbumsSearch = AlbumsQuery;

export const ALBUMS_SORTS = ['artist', 'title', 'year', 'added_date', 'rating', 'listened'] as const;
const SINGLE_KEYS = ['q', 'artist', 'decided', 'review', 'owned'] as const;
const MULTI_KEYS = MULTI_FILTER_KEYS;

function toArray(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map(String).filter((s) => s !== '');
  // A router that stringifies arrays as JSON hands them back as a string.
  const s = String(v);
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String).filter((x) => x !== '');
    } catch {
      /* not JSON — treat as one value */
    }
  }
  return [s];
}

export function parseAlbumsSearch(raw: Record<string, unknown>): AlbumsSearch {
  const out: Record<string, unknown> = {};
  for (const k of SINGLE_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  for (const k of MULTI_KEYS) {
    const values = toArray(raw[k]);
    if (values.length === 0) continue;
    out[k] = k === 'decade'
      ? values.map(Number).filter((n) => Number.isInteger(n) && n >= 1900 && n <= 2100)
      : values;
    if ((out[k] as unknown[]).length === 0) delete out[k];
  }
  const sort = raw['sort'];
  if (typeof sort === 'string' && (ALBUMS_SORTS as readonly string[]).includes(sort)) out['sort'] = sort;
  const view = raw['view'];
  if (view === 'list' || view === 'grid') out['view'] = view;
  return out as AlbumsSearch;
}

/** Everything except presentation — what a saved view stores and what the API filters on. */
export function albumsQueryOf(search: AlbumsSearch): AlbumsQuery {
  return search;
}

export function activeFilterCount(search: AlbumsSearch): number {
  const { sort: _s, view: _v, ...rest } = search;
  return Object.values(rest).reduce<number>(
    (n, v) => n + (Array.isArray(v) ? v.length : v === undefined || v === '' ? 0 : 1),
    0,
  );
}

/** Add or remove one value of a multi-select filter, returning the new value (or undefined when empty). */
export function toggleMulti<K extends MultiFilterKey>(
  search: AlbumsSearch,
  key: K,
  value: string | number,
): AlbumsSearch[K] | undefined {
  const current = (search[key] ?? []) as Array<string | number>;
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return (next.length ? next : undefined) as AlbumsSearch[K] | undefined;
}

export function isMultiActive(search: AlbumsSearch, key: MultiFilterKey, value: string | number): boolean {
  return ((search[key] ?? []) as Array<string | number>).includes(value);
}

/** Query string for the API: repeated parameters for multi-value filters. */
export function apiSearchParams(query: AlbumsQuery, extra: Record<string, string | number> = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === '' || k === 'view') continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else params.set(k, String(v));
  }
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  return params;
}
