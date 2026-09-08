/**
 * Hooks for artists and genres (XO-310 enrichment plan)
 */
import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
}

export interface ArtistDiscographyItem {
  releaseGroupId: string;
  title: string;
  firstReleaseDate: string | null;
  ownership: 'digital' | 'physical' | 'both' | 'missing' | 'ignored';
  localAlbumId: string | null;
  coverUrl: string | null;
  gapId?: string;
  dismissReason?: string | null;
  firstSeenAt?: string | null;
}

export interface ArtistDiscography {
  type: 'Album' | 'EP' | 'Single' | 'Live' | 'Compilation' | 'Other';
  items: ArtistDiscographyItem[];
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
  followed: boolean;
  discography: ArtistDiscography[];
}

export interface ArtistsListResponse {
  items: ArtistListItem[];
  nextCursor: string | null;
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

/**
 * Get artist detail with auto-refetch every 5s while enrichedAt is null,
 * capped at ~12 polls (up to 1 minute)
 */
export function useArtist(libraryId: string | undefined, artistId: string | undefined) {
  const pollCountRef = useRef(0);

  return useQuery({
    queryKey: ['artist', libraryId, artistId],
    queryFn: () => api.get<ArtistDetail>(`/libraries/${libraryId}/artists/${artistId}`),
    enabled: !!libraryId && !!artistId,
    refetchInterval: (query) => {
      const data = query.state.data;
      // If enrichedAt is null and we haven't exceeded ~12 polls, keep polling every 5s
      if (data?.enrichedAt === null && pollCountRef.current < 12) {
        pollCountRef.current += 1;
        return 5000;
      }
      // Otherwise, disable refetching
      return false;
    },
    staleTime: 0,
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
