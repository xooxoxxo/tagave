/**
 * Album folder maintenance: rescan the album's directory, split a mixed
 * album by format, merge a split-off album back.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

export interface RescanResponse {
  queued: Array<{ scanRootId: string; dirPath: string; jobId: string | null }>;
}

export interface SplitResponse {
  newAlbumId: string;
  moved: number;
  kept: number;
}

export interface MergeResponse {
  originalAlbumId: string;
  moved: number;
}

const invalidateAlbum = (qc: ReturnType<typeof useQueryClient>, libraryId: string | undefined, albumId: string) => {
  qc.invalidateQueries({ queryKey: ['album', albumId] });
  qc.invalidateQueries({ queryKey: ['albums', libraryId] });
  qc.invalidateQueries({ queryKey: ['album-facets'] });
  qc.invalidateQueries({ queryKey: ['jobs', libraryId] });
};

export function useRescanAlbumFolder(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (albumId: string) => api.post<RescanResponse>(`/libraries/${libraryId}/albums/${albumId}/rescan`, {}),
    onSuccess: (_d, albumId) => invalidateAlbum(qc, libraryId, albumId),
  });
}

export function useSplitAlbumByFormat(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ albumId, keep }: { albumId: string; keep: 'lossless' | 'lossy' }) =>
      api.post<SplitResponse>(`/libraries/${libraryId}/albums/${albumId}/split-by-format`, { keep }),
    onSuccess: (_d, { albumId }) => invalidateAlbum(qc, libraryId, albumId),
  });
}

export function useMergeSplitAlbum(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (albumId: string) => api.post<MergeResponse>(`/libraries/${libraryId}/albums/${albumId}/merge-back`, {}),
    onSuccess: (data, albumId) => {
      invalidateAlbum(qc, libraryId, albumId);
      qc.invalidateQueries({ queryKey: ['album', data.originalAlbumId] });
    },
  });
}
