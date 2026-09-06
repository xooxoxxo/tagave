/**
 * Library and album data hooks
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AlbumSummary } from '@liner/shared';
import { api } from '../services/api';
import { LibraryState, LocalAlbum, ScanRootWithStatus, PaginatedResponse } from '../types/index';
import { ScanRoot, Library, LibrarySettingsView, PatchLibrarySettings, CreateScanRootRequest } from '@liner/shared';

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
  review?: string;
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
      if (options.review) params.set('review', options.review);
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
    refetchInterval: (query) => {
      const hasPending = (query.state.data as ScanRootWithStatus[] | undefined)?.some(
        (r) => r.validationStatus === 'pending'
      );
      return hasPending ? 1000 * 3 : false; // Poll every 3s while pending, stop when all validated
    },
  });
}

export function useCreateScanRoot(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateScanRootRequest) =>
      api.post<ScanRoot>(`/libraries/${libraryId}/scan-roots`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
    },
  });
}

// Root id is the mutation variable, so one hook instance at the top of a
// page serves every row (hooks must not be created inside handlers).
export function useUpdateScanRoot(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rootId, data }: { rootId: string; data: Partial<ScanRoot> }) =>
      api.patch<ScanRoot>(`/libraries/${libraryId}/scan-roots/${rootId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
    },
  });
}

export function useDeleteScanRoot(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rootId: string) => api.delete(`/libraries/${libraryId}/scan-roots/${rootId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
    },
  });
}

export function useStartScan(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rootId: string) => api.post(`/libraries/${libraryId}/scan-roots/${rootId}/scan`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
      queryClient.invalidateQueries({ queryKey: [...ALBUMS_QUERY_KEY, libraryId] });
    },
  });
}

export function useValidateScanRoot(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rootId: string) => api.post(`/libraries/${libraryId}/scan-roots/${rootId}/validate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCAN_ROOTS_QUERY_KEY, libraryId] });
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

export interface Edition {
  releaseId: string;
  mbid: string;
  title: string;
  disambiguation?: string;
  status?: string | null;
  date?: string | null;
  country?: string | null;
  barcode?: string | null;
  packaging?: string | null;
  labels: Array<{ name: string; catalogNumber?: string | null }>;
  media: Array<{ position?: string | number | null; format?: string | null; trackCount?: number | null }>;
  trackCount: number;
  owned: boolean;
  ownedByOtherAlbums: number;
}

export interface EditionsData {
  fetchedAt: string | null;
  releaseGroupMbid: string;
  editions: Edition[];
}

export function useAlbumEditions(libraryId: string | undefined, albumId: string | undefined) {
  return useQuery({
    queryKey: [...ALBUMS_QUERY_KEY, libraryId, 'editions', albumId],
    queryFn: () => api.get<EditionsData>(`/libraries/${libraryId}/albums/${albumId}/editions`),
    enabled: !!libraryId && !!albumId,
    refetchInterval: (query) => {
      const data = query.state.data as EditionsData | undefined;
      return data?.fetchedAt ? false : 3000; // Poll every 3s while null
    },
  });
}

export function useRefreshEditions(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (albumId: string) =>
      api.post(`/libraries/${libraryId}/albums/${albumId}/editions/refresh`),
    onSuccess: (_, albumId) => {
      queryClient.invalidateQueries({ queryKey: [...ALBUMS_QUERY_KEY, libraryId, 'editions', albumId] });
    },
  });
}

export function useMatchAnyEdition(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (albumId: string) =>
      api.post(`/libraries/${libraryId}/albums/${albumId}/match-any-edition`),
    onSuccess: (_, albumId) => {
      queryClient.invalidateQueries({ queryKey: ['album', albumId] });
    },
  });
}

export function useClearAnyEdition(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (albumId: string) =>
      api.delete(`/libraries/${libraryId}/albums/${albumId}/match-any-edition`),
    onSuccess: (_, albumId) => {
      queryClient.invalidateQueries({ queryKey: ['album', albumId] });
    },
  });
}

const COLLECTION_QUERY_KEY = ['collection'];

interface CollectionFilters {
  view?: 'physical_only' | 'both' | 'unmapped' | 'removed' | 'all';
  folder?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function useCollectionSources(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...COLLECTION_QUERY_KEY, 'sources', libraryId],
    queryFn: () => api.get(`/libraries/${libraryId}/collection-sources`),
    enabled: !!libraryId,
    staleTime: 1000 * 5, // 5 seconds when syncing
    refetchInterval: (query) => {
      const data = query.state.data as any;
      const status = data?.sources?.[0]?.status;
      return status === 'syncing' ? 5000 : false;
    },
  });
}

export function useCollection(libraryId: string | undefined, filters: CollectionFilters = {}) {
  return useQuery({
    queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId, filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.view) params.set('view', filters.view);
      if (filters.folder) params.set('folder', filters.folder);
      if (filters.q) params.set('q', filters.q);
      if (filters.limit !== undefined) params.set('limit', String(filters.limit));
      if (filters.offset !== undefined) params.set('offset', String(filters.offset));
      return api.get(`/libraries/${libraryId}/collection?${params}`);
    },
    enabled: !!libraryId,
    staleTime: 1000 * 30, // 30 seconds
  });
}

export function useReconciliation(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...COLLECTION_QUERY_KEY, 'reconciliation', libraryId],
    queryFn: () => api.get(`/libraries/${libraryId}/collection/reconciliation`),
    enabled: !!libraryId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useSyncCollection(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/collection-sources/sync`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'sources', libraryId] });
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId] });
    },
  });
}

export function useRemapCollection(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/collection-sources/remap`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId] });
    },
  });
}

export function useMapCollectionItem(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: string }) =>
      api.post(`/collection-items/${itemId}/map`, { input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId] });
    },
  });
}

export function useUnmapCollectionItem(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (itemId: string) =>
      api.delete(`/collection-items/${itemId}/map`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId] });
    },
  });
}

export function useCollectionOptions(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...COLLECTION_QUERY_KEY, 'options', libraryId],
    queryFn: () => api.get(`/libraries/${libraryId}/collection-sources/options`),
    enabled: !!libraryId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

interface AddCollectionItemInput {
  input: string;
  folderId?: number;
  mediaCondition?: string;
  sleeveCondition?: string;
  notes?: string;
  rating?: number;
}

export function useAddCollectionItem(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: AddCollectionItemInput) =>
      api.post(`/libraries/${libraryId}/collection/items`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'sources', libraryId] });
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId] });
    },
  });
}

export function useRemoveCollectionItem(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (itemId: string) =>
      api.delete(`/collection-items/${itemId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'sources', libraryId] });
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId] });
    },
  });
}

export function useRetryPush(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (itemId: string) =>
      api.post(`/collection-items/${itemId}/retry-push`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'sources', libraryId] });
      queryClient.invalidateQueries({ queryKey: [...COLLECTION_QUERY_KEY, 'items', libraryId] });
    },
  });
}
