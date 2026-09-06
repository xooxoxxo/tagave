/**
 * URL search params of /albums (spec BRW-1: filters are URL-encoded so views
 * are bookmarkable). Kept as a pure module so the router and the page share
 * one parser without a circular import.
 */
import type { AlbumsQuery } from '@liner/shared';

export type AlbumsSearch = AlbumsQuery & { page?: number };

export const ALBUMS_SORTS = ['artist', 'title', 'year', 'added_date', 'rating', 'listened'] as const;
const STRING_KEYS = ['q', 'artist', 'state', 'decided', 'review', 'genre', 'format', 'label', 'owned', 'gap'] as const;

export function parseAlbumsSearch(raw: Record<string, unknown>): AlbumsSearch {
  const out: AlbumsSearch = {};
  for (const k of STRING_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) (out as Record<string, string>)[k] = v.trim();
  }
  const sort = raw['sort'];
  if (typeof sort === 'string' && (ALBUMS_SORTS as readonly string[]).includes(sort)) out.sort = sort as AlbumsSearch['sort'];
  const view = raw['view'];
  if (view === 'list' || view === 'grid') out.view = view;
  const decade = Number(raw['decade']);
  if (Number.isInteger(decade) && decade >= 1900 && decade <= 2100) out.decade = decade;
  const page = Number(raw['page']);
  if (Number.isInteger(page) && page > 1) out.page = page;
  return out;
}

/** Everything except paging/presentation — what a saved view stores and what the API filters on. */
export function albumsQueryOf(search: AlbumsSearch): AlbumsQuery {
  const { page: _page, ...rest } = search;
  return rest;
}

export function activeFilterCount(search: AlbumsSearch): number {
  const { page: _p, sort: _s, view: _v, ...rest } = search;
  return Object.values(rest).filter((v) => v !== undefined && v !== '').length;
}
