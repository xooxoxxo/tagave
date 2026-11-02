/**
 * Deleting songs and albums (Settings › Library › Deleting, Library care ›
 * Deleting). Owner only: listeners and editors never ask.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CreateDeletionsResult, DeleteMode, DeletingView } from '@tagave/shared';
import { api } from '../services/api';
import { useCan } from './usePermissions';

export const DELETIONS_KEY = ['deletions'];

export interface DeleteModeView { mode: DeleteMode; trashAvailable: boolean }

/** The library's mode, for the one delete item in every ⋮ (null for anyone but the owner). */
export function useDeleteMode(libraryId: string | undefined): DeleteModeView | null {
  const owner = useCan('system.manage');
  const q = useQuery({
    queryKey: [...DELETIONS_KEY, 'mode', libraryId],
    queryFn: () => api.get<DeleteModeView>(`/libraries/${libraryId}/deletions/mode`),
    enabled: !!libraryId && owner,
    staleTime: 60_000,
  });
  return owner ? q.data ?? null : null;
}

export function useDeletingView(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...DELETIONS_KEY, 'view', libraryId],
    queryFn: () => api.get<DeletingView>(`/libraries/${libraryId}/deletions`),
    enabled: !!libraryId,
    // a move or restore is the worker's: look again while one is on its way
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && d.trash.some((g) => g.state === 'moving' || g.state === 'restoring') ? 2000 : false;
    },
  });
}

/** Everything a deletion changes: the albums, the album page, search, counts, artists, playlists, the Deleting page. */
export function invalidateLibraryViews(qc: QueryClient): Promise<unknown> {
  return Promise.all(['albums', 'album', 'album-facets', 'library-stats', 'search', 'artists-list', 'artists', 'artist', 'playlist', 'playlists', 'deletions']
    .map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

/** Sends a deletion (after its Undo window): tracks or albums, in the library's mode. */
export function useCommitDeletion(libraryId: string | undefined) {
  const qc = useQueryClient();
  return async (body: { trackIds?: string[]; albumIds?: string[] }, { keepalive }: { keepalive: boolean }) => {
    await api.post<CreateDeletionsResult>(`/libraries/${libraryId}/deletions`, body, keepalive ? { keepalive } : undefined);
    await invalidateLibraryViews(qc);
  };
}

function useDeletionMutation<T>(fn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidateLibraryViews(qc) });
}

export function useUnmark(libraryId: string | undefined) {
  return useDeletionMutation((fileIds: string[]) => api.post(`/libraries/${libraryId}/deletions/unmark`, { fileIds }));
}

export function useRestore(libraryId: string | undefined) {
  return useDeletionMutation((fileIds: string[]) => api.post(`/libraries/${libraryId}/deletions/restore`, { fileIds }));
}

export function useEmptyTrash(libraryId: string | undefined) {
  return useDeletionMutation(() => api.post(`/libraries/${libraryId}/deletions/empty-trash`));
}

export function useSetDeleteMode(libraryId: string | undefined) {
  return useDeletionMutation((mode: DeleteMode) => api.put(`/libraries/${libraryId}/deletions/mode`, { mode }));
}
