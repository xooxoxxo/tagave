/**
 * Album grid facets and saved views (spec BRW-1).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlbumFacets, AlbumsQuery, CreateSavedView, SavedView } from '@liner/shared';
import { api } from '../services/api';
import { apiSearchParams } from '../pages/albumsSearch';

export function facetParams(query: AlbumsQuery): URLSearchParams {
  const { sort: _sort, ...filters } = query;
  return apiSearchParams(filters);
}

export function useAlbumFacets(libraryId: string | undefined, query: AlbumsQuery) {
  const params = facetParams(query).toString();
  return useQuery({
    queryKey: ['album-facets', libraryId, params],
    queryFn: () => api.get<AlbumFacets>(`/libraries/${libraryId}/albums/facets?${params}`),
    enabled: !!libraryId,
    staleTime: 1000 * 60 * 2,
    placeholderData: (prev) => prev,
  });
}

const SAVED_VIEWS_KEY = ['saved-views'];

export function useSavedViews(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...SAVED_VIEWS_KEY, libraryId],
    queryFn: () => api.get<{ items: SavedView[] }>(`/libraries/${libraryId}/saved-views`).then((r) => r.items),
    enabled: !!libraryId,
    staleTime: 1000 * 60 * 5,
  });
}

export function useCreateSavedView(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSavedView) => api.post<SavedView>(`/libraries/${libraryId}/saved-views`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...SAVED_VIEWS_KEY, libraryId] }),
  });
}

export function useDeleteSavedView(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) => api.delete<{ ok: boolean }>(`/saved-views/${viewId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...SAVED_VIEWS_KEY, libraryId] }),
  });
}
