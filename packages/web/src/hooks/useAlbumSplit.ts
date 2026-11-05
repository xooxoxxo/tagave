/**
 * Whole album in one file (0078): the album's split, its cut points, and
 * Split. Owner only (system.manage): nobody else asks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlbumSplitView } from '@tagave/shared';
import { api } from '../services/api';
import { useCan } from './usePermissions';
import { invalidateLibraryViews } from './useDeletions';
import { invalidateAlbumCare } from './useGaps';

export const albumSplitKey = (libraryId: string | undefined, albumId: string | undefined) => ['album-split', libraryId, albumId] as const;

const base = (libraryId: string | undefined, albumId: string | undefined) => `/libraries/${libraryId}/albums/${albumId}/split`;

/** The album's latest split; looks again every 2 s while the worker is on it. */
export function useAlbumSplit(libraryId: string | undefined, albumId: string | undefined, enabled = true) {
  const owner = useCan('system.manage');
  return useQuery({
    queryKey: albumSplitKey(libraryId, albumId),
    queryFn: () => api.get<AlbumSplitView>(base(libraryId, albumId)),
    enabled: enabled && owner && !!libraryId && !!albumId,
    refetchInterval: (query) => {
      const s = query.state.data?.split?.state;
      return s === 'analyzing' || s === 'splitting' ? 2000 : false;
    },
  });
}

/** Find the cut points (a new plan). */
export function useAnalyzeSplit(libraryId: string | undefined, albumId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AlbumSplitView>(base(libraryId, albumId), {}),
    onSuccess: (view) => qc.setQueryData(albumSplitKey(libraryId, albumId), view),
  });
}

/** Split as planned. */
export function useRunSplit(libraryId: string | undefined, albumId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (splitId: string) => api.post<AlbumSplitView>(`${base(libraryId, albumId)}/${splitId}/run`, {}),
    onSuccess: (view) => {
      qc.setQueryData(albumSplitKey(libraryId, albumId), view);
      void invalidateAlbumCare(qc);
    },
  });
}

/** After a split: the album, the lists, Attention. */
export function invalidateAfterSplit(qc: ReturnType<typeof useQueryClient>): Promise<unknown> {
  return Promise.all([invalidateLibraryViews(qc), invalidateAlbumCare(qc)]);
}
