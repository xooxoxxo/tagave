/**
 * Hooks for artists and genres (XO-310 enrichment plan)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

export interface ArtistListItem {
  id: string | null;
  name: string;
  sortName: string | null;
  albumCount: number;
  trackCount: number;
  yearFrom: number | null;
  yearTo: number | null;
  resolved: boolean;
  /** when the artist's newest album was first scanned (ISO) */
  addedAt?: string | null;
  /** up to four of the artist's albums that have a front cover, oldest first */
  coverAlbumIds?: string[];
}

export type ArtistSort = 'name' | 'albums' | 'recent';

export interface ArtistGroupCount {
  key: string;
  count: number;
}

export type ArtistAlbumOwnership = 'digital' | 'physical' | 'both' | 'missing' | 'ignored';

/** One album on the artist page: in the library (on disk or the shelf) or missing. */
export interface ArtistAlbum {
  /** the local album id, or "rg:<release group id>" for a release group not on disk */
  key: string;
  localAlbumId: string | null;
  releaseGroupId: string | null;
  title: string;
  year: number | null;
  /** MusicBrainz primary type (Album, EP, Single, …); null when unknown */
  primaryType: string | null;
  ownership: ArtistAlbumOwnership;
  /** tracks on disk */
  trackCount: number | null;
  coverUrl: string | null;
  /** credit: an identified release group; tags: the album-artist tag; gap: missing; shelf: physical only */
  matchedBy: 'credit' | 'tags' | 'gap' | 'shelf';
  gapId?: string;
  dismissReason?: string | null;
  firstSeenAt?: string | null;
}

export interface ArtistDetail {
  id: string;
  mbid: string | null;
  discogsId: number | null;
  name: string;
  sortName: string | null;
  disambiguation: string | null;
  type: string | null;
  country: string | null;
  beginDate: string | null;
  endDate: string | null;
  aliases: string[];
  bio: {
    source: string;
    license: string;
    text: string;
    url: string;
    title: string;
    fetchedAt: string;
  } | null;
  enrichedAt: string | null;
  enrichError: string | null;
  /** the API omits links it cannot build, so every key is optional */
  links: {
    musicbrainz?: string | null;
    discogs?: string | null;
    wikidata?: string | null;
    wikipedia?: string | null;
  };
  /** false: no MusicBrainz id, so details are never fetched */
  canEnrich: boolean;
  followed: boolean;
  /** oldest first: in the library, then a followed artist's missing and skipped ones */
  albums: ArtistAlbum[];
  /** albums in the library (disk or shelf) and their tracks on disk */
  owned: { albums: number; tracks: number };
}

export interface ArtistsListResponse {
  items: ArtistListItem[];
  nextCursor: string | null;
  /** every artist matching search and group */
  total?: number;
  /** artists per A–Z group for the search, before the group filter */
  groups?: ArtistGroupCount[];
}

export interface GenreMap {
  whitelist: string[];
  aliases: Record<string, string>;
  maxGenres: number;
}

export interface RawTag {
  tag: string;
  kind: 'genre' | 'style' | 'tag';
  source: string;
  weight: number | null;
}

export interface GenrePreviewTag extends RawTag {
  count: number;
  mappedTo: string | null;
}

export interface GenrePreviewResponse {
  map: GenreMap;
  tags: GenrePreviewTag[];
  histogram: Array<{ genre: string; albums: number }>;
}

export interface FollowRules {
  includePrimary: string[];
  excludeSecondary: string[];
  autoFollowMinAlbums: number;
}

/**
 * List artists with optional search
 */
export function useArtistsList(
  libraryId: string | undefined,
  opts?: { search?: string; limit?: number; offset?: number }
) {
  return useQuery({
    queryKey: ['artists-list', libraryId, opts],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.search) params.append('search', opts.search);
      if (opts?.limit) params.append('limit', String(opts.limit));
      if (opts?.offset) params.append('offset', String(opts.offset));
      const query = params.toString() ? `?${params.toString()}` : '';
      return api.get<ArtistsListResponse>(`/libraries/${libraryId}/artists${query}`);
    },
    enabled: !!libraryId,
    staleTime: 60_000,
  });
}

export const ARTISTS_PAGE_SIZE = 120;

/**
 * The artists browser: pages of ARTISTS_PAGE_SIZE behind a virtualized grid
 * or list, ordered and filtered by the server.
 */
export function useArtistsInfinite(
  libraryId: string | undefined,
  opts: { search: string; sort: ArtistSort; group: string | null },
) {
  const params = new URLSearchParams({ sort: opts.sort, limit: String(ARTISTS_PAGE_SIZE) });
  if (opts.search) params.set('search', opts.search);
  if (opts.group) params.set('group', opts.group);
  const query = params.toString();
  return useInfiniteQuery({
    queryKey: ['artists-list', 'infinite', libraryId, query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<ArtistsListResponse>(`/libraries/${libraryId}/artists?${query}&offset=${pageParam as number}`),
    getNextPageParam: (last) => (last.nextCursor ? Number(last.nextCursor) : undefined),
    enabled: !!libraryId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Polls while details are being fetched: every 5 s, at most 12 times (one minute). */
export const ARTIST_ENRICH_POLLS = 12;

/**
 * Get artist detail. While the details are being fetched (enrichedAt null,
 * no error, an MBID to fetch by) it polls every 5 s, ARTIST_ENRICH_POLLS
 * times at most; `waiting` says whether the page should still show the
 * fetch in progress, so a fetch that never finishes ends in a plain state
 * instead of an endless spinner. `restartPolling` starts a new round (after
 * Retry or Refresh details).
 */
export function useArtist(libraryId: string | undefined, artistId: string | undefined) {
  // fetches since the page (or Retry) started waiting: the first load plus
  // the polls. Counted in queryFn, since refetchInterval is consulted on
  // every observer update, not once per fetch.
  const fetchesRef = useRef(0);
  const [round, setRound] = useState(0);
  const query = useQuery({
    queryKey: ['artist', libraryId, artistId],
    queryFn: async () => {
      const detail = await api.get<ArtistDetail>(`/libraries/${libraryId}/artists/${artistId}`);
      fetchesRef.current += 1;
      return detail;
    },
    enabled: !!libraryId && !!artistId,
    refetchInterval: (q) => (isFetchingDetails(q.state.data) && fetchesRef.current <= ARTIST_ENRICH_POLLS ? 5000 : false),
    staleTime: 0,
  });
  // a new artist starts a new round
  useEffect(() => { fetchesRef.current = 0; }, [artistId, round]);
  // read so every poll re-renders: `waiting` turns false after the last one
  void query.dataUpdatedAt;
  const waiting = isFetchingDetails(query.data) && fetchesRef.current <= ARTIST_ENRICH_POLLS;
  const restartPolling = useCallback(() => {
    fetchesRef.current = 0;
    setRound((n) => n + 1);
  }, []);
  return { ...query, waiting, restartPolling };
}

/** Details are on their way: not fetched yet, no error, and an MBID to fetch them by. */
export function isFetchingDetails(artist: Pick<ArtistDetail, 'enrichedAt' | 'enrichError' | 'canEnrich'> | undefined): boolean {
  return !!artist && artist.enrichedAt === null && !artist.enrichError && artist.canEnrich !== false;
}

/**
 * Fetch the artist's details again (Retry after a failure, Refresh details
 * in Maintenance); a followed artist's discography is refreshed with them.
 */
export function useEnrichArtist(libraryId: string | undefined, artistId: string | undefined, onQueued?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ queued: boolean }>(`/libraries/${libraryId}/artists/${artistId}/enrich`, {}),
    onSuccess: () => {
      onQueued?.();
      void queryClient.invalidateQueries({ queryKey: ['artist', libraryId, artistId] });
    },
  });
}

/**
 * Follow/unfollow an artist (mutation)
 */
export function useFollowArtist(libraryId: string | undefined, artistId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (followed: boolean) =>
      api.post<{ followed: boolean }>(
        `/libraries/${libraryId}/artists/${artistId}/follow`,
        { followed }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['artist', libraryId, artistId] });
    },
  });
}

/**
 * Get genre map (settings)
 */
export function useGenreMap(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['genre-map', libraryId],
    queryFn: async () => {
      const settings = await api.get<{ genreMap: GenreMap }>(
        `/libraries/${libraryId}/settings`
      );
      return settings.genreMap;
    },
    enabled: !!libraryId,
    staleTime: 60_000,
  });
}

/**
 * Patch genre map (mutation)
 */
export function usePatchGenreMap(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (genreMap: GenreMap) =>
      api.patch(`/libraries/${libraryId}/settings`, { genreMap }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['genre-map', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['genre-preview', libraryId] });
    },
  });
}

/**
 * Get genre preview (raw tags + histogram)
 */
export function useGenrePreview(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['genre-preview', libraryId],
    queryFn: () => api.get<GenrePreviewResponse>(`/libraries/${libraryId}/genres/preview`),
    enabled: !!libraryId,
    staleTime: 60_000,
  });
}

/**
 * Reopen a dismissed gap (mutation)
 */
export function useReopenGap(libraryId: string | undefined, artistId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (gapId: string) =>
      api.post<{ ok: boolean }>(`/gaps/${gapId}/reopen`, {}),
    onSuccess: () => {
      // Invalidate the artist query to refresh the discography
      queryClient.invalidateQueries({ queryKey: ['artist', libraryId, artistId] });
    },
  });
}

/**
 * Get follow rules (settings) for library
 */
export function useFollowRules(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['follow-rules', libraryId],
    queryFn: async () => {
      const settings = await api.get<{ followRules: FollowRules }>(
        `/libraries/${libraryId}/settings`
      );
      return settings.followRules;
    },
    enabled: !!libraryId,
    staleTime: 60_000,
  });
}

/**
 * Patch follow rules (mutation)
 */
export function usePatchFollowRules(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (followRules: FollowRules) =>
      api.patch(`/libraries/${libraryId}/settings`, { followRules }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-rules', libraryId] });
    },
  });
}

/**
 * Patch per-artist follow rules (mutation)
 */
export function usePatchArtistFollowRules(
  libraryId: string | undefined,
  artistId: string | undefined
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (rules: { includePrimary?: string[]; excludeSecondary?: string[] }) =>
      api.patch<{ includePrimary: string[]; excludeSecondary: string[] }>(
        `/libraries/${libraryId}/artists/${artistId}/follow-rules`,
        rules
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['artist', libraryId, artistId] });
    },
  });
}

/**
 * Reset per-artist follow rules to library defaults (mutation)
 */
export function useResetArtistFollowRules(
  libraryId: string | undefined,
  artistId: string | undefined
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ includePrimary: string[]; excludeSecondary: string[] }>(
        `/libraries/${libraryId}/artists/${artistId}/follow-rules/reset`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['artist', libraryId, artistId] });
    },
  });
}
