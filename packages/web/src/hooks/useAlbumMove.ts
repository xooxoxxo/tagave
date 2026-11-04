/**
 * Move to album (0080): the picker's albums, a move and its steps, Undo,
 * and Library care › Moved. Owner only (system.manage): nobody else asks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlbumMoveView, MoveAlbumOption, MoveListItem, MoveTarget } from '@tagave/shared';
import { api } from '../services/api';
import { useCan } from './usePermissions';
import { invalidateLibraryViews } from './useDeletions';

export const moveKey = (libraryId: string | undefined, moveId: string | null | undefined) => ['album-move', libraryId, moveId] as const;
const movesKey = (libraryId: string | undefined) => ['album-moves', libraryId] as const;

const BUSY = new Set(['searching', 'planning', 'moving', 'undoing']);

/** The picker: albums of the library by title or artist. */
export function useMoveAlbums(libraryId: string | undefined, q: string) {
  const owner = useCan('system.manage');
  const query = q.trim();
  return useQuery({
    queryKey: ['move-albums', libraryId, query],
    queryFn: () => api.get<{ items: MoveAlbumOption[] }>(`/libraries/${libraryId}/moves/albums?q=${encodeURIComponent(query)}`),
    enabled: owner && !!libraryId && query.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

/** One move; looks again every second while the worker is on it. */
export function useMove(libraryId: string | undefined, moveId: string | null) {
  const owner = useCan('system.manage');
  return useQuery({
    queryKey: moveKey(libraryId, moveId),
    queryFn: () => api.get<AlbumMoveView>(`/libraries/${libraryId}/moves/${moveId}`),
    enabled: owner && !!libraryId && !!moveId,
    refetchInterval: (query) => (BUSY.has(query.state.data?.state ?? '') ? 1000 : false),
  });
}

/** A new move of these songs of the album. */
export function useCreateMove(libraryId: string | undefined, albumId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { trackIds: string[]; target: MoveTarget }) => api.post<AlbumMoveView>(`/libraries/${libraryId}/albums/${albumId}/moves`, body),
    onSuccess: (view) => qc.setQueryData(moveKey(libraryId, view.id), view),
  });
}

/** Another target, before Move. */
export function useMoveTarget(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ moveId, target }: { moveId: string; target: MoveTarget }) => api.post<AlbumMoveView>(`/libraries/${libraryId}/moves/${moveId}/target`, { target }),
    onSuccess: (view) => qc.setQueryData(moveKey(libraryId, view.id), view),
  });
}

export function useRunMove(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (moveId: string) => api.post<AlbumMoveView>(`/libraries/${libraryId}/moves/${moveId}/run`, {}),
    onSuccess: (view) => qc.setQueryData(moveKey(libraryId, view.id), view),
  });
}

export function useUndoMove(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (moveId: string) => api.post<AlbumMoveView>(`/libraries/${libraryId}/moves/${moveId}/undo`, {}),
    onSuccess: (view) => {
      qc.setQueryData(moveKey(libraryId, view.id), view);
      void qc.invalidateQueries({ queryKey: movesKey(libraryId) });
    },
  });
}

/** Library care › Moved. */
export function useMoves(libraryId: string | undefined) {
  const owner = useCan('system.manage');
  return useQuery({
    queryKey: movesKey(libraryId),
    queryFn: () => api.get<{ items: MoveListItem[] }>(`/libraries/${libraryId}/moves`),
    enabled: owner && !!libraryId,
    refetchInterval: (query) => (query.state.data?.items.some((m) => BUSY.has(m.state)) ? 2000 : false),
  });
}

/** After a move or its undo: the albums, the lists, Attention, the moves. */
export function invalidateAfterMove(qc: ReturnType<typeof useQueryClient>, libraryId: string | undefined): Promise<unknown> {
  return Promise.all([
    invalidateLibraryViews(qc),
    qc.invalidateQueries({ queryKey: ['gaps'] }),
    qc.invalidateQueries({ queryKey: movesKey(libraryId) }),
  ]);
}
