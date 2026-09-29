/**
 * Compilations: the bulk tag editor's suggestions, "Treat as one album" and
 * split back. Writing tags always goes through a tag plan (preview first).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ManualTagValues } from '@liner/shared';
import { api } from '../services/api';

export type EditScope =
  | { type: 'albumIds'; albumIds: string[] }
  | { type: 'folder'; dirPath: string; scanRootId?: string };

export interface ValueCount { value: string; files: number }

export interface TagEditSuggestion {
  albumIds: string[];
  files: number;
  albums: number;
  current: {
    albumartist: ValueCount[];
    album: ValueCount[];
    artist: ValueCount[];
    date: ValueCount[];
    genre: ValueCount[];
    compilation: { yes: number; no: number };
  };
  distinct?: { albumartist: number; album: number; artist: number; date: number; genre: number };
  numberedAlbumArtists: number;
  trackArtistsDiffer: boolean;
  suggested: ManualTagValues;
  albumArtistOptions: string[];
  notes: string[];
  /** the selection reads as one album; the editor may start with the suggestion ticked */
  confident?: boolean;
}

const scopeKey = (scope: EditScope | null) =>
  scope === null ? 'none' : scope.type === 'albumIds' ? `ids:${[...scope.albumIds].sort().join(',')}` : `dir:${scope.scanRootId ?? ''}:${scope.dirPath}`;

export function useTagEditSuggestion(libraryId: string | undefined, scope: EditScope | null) {
  return useQuery({
    queryKey: ['tag-edit-suggest', libraryId, scopeKey(scope)],
    queryFn: () => api.post<TagEditSuggestion>(`/libraries/${libraryId}/tag-edit/suggest`, { scope }),
    enabled: !!libraryId && scope !== null,
    staleTime: 30_000,
  });
}

export interface MergeResponse {
  albumId: string;
  mergedAlbumIds: string[];
  files: number;
  identifyQueued: boolean;
}

export function useMergeAlbums(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { albumIds: string[]; targetId?: string }) =>
      api.post<MergeResponse>(`/libraries/${libraryId}/albums/merge`, input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['album', data.albumId] });
      for (const id of data.mergedAlbumIds) qc.removeQueries({ queryKey: ['album', id] });
      qc.invalidateQueries({ queryKey: ['albums'] });
      qc.invalidateQueries({ queryKey: ['album-facets'] });
      qc.invalidateQueries({ queryKey: ['artists'] });
    },
  });
}

export function useUnmergeAlbum(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (albumId: string) =>
      api.post<{ albumId: string; files: number; folders: number }>(`/libraries/${libraryId}/albums/${albumId}/unmerge`, {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['album', data.albumId] });
      qc.invalidateQueries({ queryKey: ['albums'] });
      qc.invalidateQueries({ queryKey: ['album-facets'] });
      qc.invalidateQueries({ queryKey: ['artists'] });
    },
  });
}

/** Queue identification for several albums (the plan page's "Identify" for unidentified files). */
export function useIdentifyAlbums(libraryId: string | undefined) {
  return useMutation({
    mutationFn: async (albumIds: string[]) => {
      let queued = 0;
      for (const id of albumIds) {
        try {
          await api.post(`/libraries/${libraryId}/albums/${id}/identify`);
          queued++;
        } catch { /* one already queued is fine */ }
      }
      return { queued };
    },
  });
}
