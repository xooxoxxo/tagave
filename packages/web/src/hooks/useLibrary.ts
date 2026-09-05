/**
 * Library and album data hooks
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AlbumSummary } from '@liner/shared';
import { api } from '../services/api';
import { LibraryState, LocalAlbum, ScanRootWithStatus, PaginatedResponse } from '../types/index';
import { ScanRoot, Library, LibrarySettingsView, PatchLibrarySettings } from '@liner/shared';

const LIBRARY_QUERY_KEY = ['library'];
const LIBRARIES_QUERY_KEY = ['libraries'];
const ALBUMS_QUERY_KEY = ['albums'];
const SCAN_ROOTS_QUERY_KEY = ['scan-roots'];

export function useLibraries() {
  return useQuery({
    queryKey: LIBRARIES_QUERY_KEY,
    queryFn: async () => {
      const response = await api.get<{ data: Library[] }>('/libraries');
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useLibrary(libraryId?: string) {
  return useQuery({
    queryKey: [...LIBRARY_QUERY_KEY, libraryId],
    queryFn: () => api.get<LibraryState>(`/libraries/${libraryId}`),
    enabled: !!libraryId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export interface AlbumsFilterOptions {
  artist?: string | undefined;
  offset?: number;
  limit?: number;
  search?: string;
  sort?: 'added_date' | 'added' | 'title' | 'artist' | 'year' | 'rating' | 'listened';
  filter?: string;
  decided?: string;
  order?: 'asc' | 'desc';
  // M1+: will add filter support for identification state, format, etc
}

export function useAlbums(libraryId: string | undefined, options: AlbumsFilterOptions = {}) {
  return useQuery({
    queryKey: [...ALBUMS_QUERY_KEY, libraryId, options],
    queryFn: () => {
      const params = new URLSearchParams();
      if (options.offset !== undefined) params.set('offset', String(options.offset));
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      if (options.search) params.set('search', options.search);
      if (options.artist) params.set('artist', options.artist);
      if (options.sort) params.set('sort', options.sort);
      if (options.filter) params.set('filter', options.filter);
      if (options.decided) params.set('decided', options.decided);
      if (options.order) params.set('order', options.order);
      return api.get<{ items: AlbumSummary[]; nextCursor: string | null }>(`/libraries/${libraryId}/albums?${params}`);
    },
    enabled: !!libraryId,
    staleTime: 1000 * 60 * 2, // 2 minutes
    gcTime: 1000 * 60 * 5, // Keep for 5 minutes
  });
}

export function useAlbum(libraryId: string | undefined, albumId: string | undefined) {
  return useQuery({
    queryKey: [...ALBUMS_QUERY_KEY, libraryId, 'detail', albumId],
    queryFn: () => api.get<LocalAlbum>(`/libraries/${libraryId}/albums/${albumId}`),
    enabled: !!libraryId && !!albumId,
    staleTime: 1000 * 60 * 5,
  });
}

export function useScanRoots(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId],
    queryFn: () =>
      api
        .get<{ data: ScanRootWithStatus[] }>(`/libraries/${libraryId}/scan-roots`)
        .then((r) => r.data),
    enabled: !!libraryId,
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 10, // Poll every 10 seconds for scan status
  });
}

export function useCreateScanRoot(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Omit<ScanRoot, 'id' | 'libraryId' | 'createdAt' | 'updatedAt'>) =>
      api.post<ScanRoot>(`/libraries/${libraryId}/scan-roots`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
    },
  });
}

export function useUpdateScanRoot(libraryId: string | undefined, rootId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<ScanRoot>) =>
      api.patch<ScanRoot>(`/libraries/${libraryId}/scan-roots/${rootId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
    },
  });
}

export function useDeleteScanRoot(libraryId: string | undefined, rootId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.delete(`/libraries/${libraryId}/scan-roots/${rootId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
    },
  });
}

export function useStartScan(libraryId: string | undefined, rootId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/scan-roots/${rootId}/scan`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
      queryClient.invalidateQueries({ queryKey: [...ALBUMS_QUERY_KEY, libraryId] });
    },
  });
}

const LIBRARY_SETTINGS_QUERY_KEY = ['library-settings'];

export function useLibrarySettings(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...LIBRARY_SETTINGS_QUERY_KEY, libraryId],
    queryFn: () => api.get<LibrarySettingsView>(`/libraries/${libraryId}/settings`),
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useUpdateLibrarySettings(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: PatchLibrarySettings) =>
      api.patch<LibrarySettingsView>(`/libraries/${libraryId}/settings`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...LIBRARY_SETTINGS_QUERY_KEY, libraryId] });
    },
  });
}

export function useEnrichSweep(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/enrich-sweep`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...ALBUMS_QUERY_KEY, libraryId] });
    },
  });
}
