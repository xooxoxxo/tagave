/**
 * Album grid data: an infinite query behind the virtualized list (spec BRW-1
 * "renders 12,000 items"), and bulk actions over a selection (§14.2).
 */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AlbumSummary, AlbumsQuery, BulkAlbumsRequest, BulkAlbumsResult } from '@liner/shared';
import { api } from '../services/api';
import { apiSearchParams } from '../pages/albumsSearch';

export const GRID_PAGE_SIZE = 100;

interface AlbumsPageResponse {
  items: AlbumSummary[];
  nextCursor: string | null;
}

export function useAlbumsInfinite(libraryId: string | undefined, query: AlbumsQuery, sort: string) {
  const params = apiSearchParams(query, { sort, limit: GRID_PAGE_SIZE }).toString();
  return useInfiniteQuery({
    queryKey: ['albums', 'infinite', libraryId, params],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<AlbumsPageResponse>(`/libraries/${libraryId}/albums?${params}&offset=${pageParam as number}`),
    // The list endpoint returns the next offset as its cursor; a short page
    // means the end, so the virtualizer stops asking.
    getNextPageParam: (last, pages) =>
      last.nextCursor && last.items.length === GRID_PAGE_SIZE ? pages.length * GRID_PAGE_SIZE : undefined,
    enabled: !!libraryId,
    staleTime: 1000 * 60,
  });
}

export function useBulkAlbums(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkAlbumsRequest) =>
      api.post<BulkAlbumsResult>(`/libraries/${libraryId}/albums/bulk`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['albums'] });
      queryClient.invalidateQueries({ queryKey: ['album-facets'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      queryClient.invalidateQueries({ queryKey: ['identify-stats'] });
    },
  });
}
