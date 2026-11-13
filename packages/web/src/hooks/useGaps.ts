/**
 * Gap decisions and the Tasks list (0032): counts for the nav and tabs, the
 * task list, and the three choices every gap offers.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { GapTaskCounts, GapTasksResponse } from '@tagave/shared';
import { api } from '../services/api';

export interface GapCountsResponse {
  /** open gaps per kind */
  counts: Record<string, number>;
  tasks?: GapTaskCounts;
}

/**
 * Library care after an operation that changed albums (rr85): its lists and
 * counts (the nav dot and Home read ['gaps', libraryId]), the task list, the
 * album pages' attention and upkeep notes, and the album grid's problem
 * filters. The server rechecks the albums an operation touched before it
 * answers; the slower quality check ends with a gaps.recompute job event,
 * which useJobEvents turns into the same refresh.
 */
export function invalidateAlbumCare(qc: Pick<QueryClient, 'invalidateQueries'>): Promise<unknown> {
  return Promise.all(['gaps', 'tasks', 'album', 'albums', 'album-facets', 'organize']
    .map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

/** Open gaps per kind and the task counts; one cached request shared by the nav, Home and Library care. */
export function useGapCounts(libraryId: string | null | undefined) {
  return useQuery({
    queryKey: ['gaps', libraryId],
    queryFn: () => api.get<GapCountsResponse>(`/libraries/${libraryId}/gaps/counts`),
    enabled: !!libraryId,
    staleTime: 30_000,
  });
}

export function useGapTasks(libraryId: string | null | undefined) {
  return useQuery({
    queryKey: ['tasks', libraryId],
    queryFn: () => api.get<GapTasksResponse>(`/libraries/${libraryId}/tasks`),
    enabled: !!libraryId,
  });
}

export type GapDecision =
  | { id: string; choice: 'task'; note?: string | null }
  | { id: string; choice: 'not_a_problem' }
  | { id: string; choice: 'wrong' }
  | { id: string; choice: 'reopen' };

/** Add to my tasks / Not a problem / This is wrong / Show again (or take off the task list). */
export function useDecideGap() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (d: GapDecision) => {
      switch (d.choice) {
        case 'task': return api.post(`/gaps/${d.id}/accept`, d.note ? { note: d.note } : {});
        case 'not_a_problem': return api.post(`/gaps/${d.id}/dismiss`, { reason: 'not_interested' });
        case 'wrong': return api.post(`/gaps/${d.id}/dismiss`, { reason: 'wrong_data' });
        case 'reopen': return api.post(`/gaps/${d.id}/reopen`, {});
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gaps'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['album'] });
      void queryClient.invalidateQueries({ queryKey: ['artist'] });
    },
  });
}

export function useSaveTaskNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => api.patch(`/gaps/${id}`, { note }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['album'] });
    },
  });
}

/** "Check again now": a full gap check; tasks whose problem is gone are crossed out. */
export function useRecheckGaps(libraryId: string | null | undefined) {
  return useMutation({
    mutationFn: () => api.post<{ queued: boolean }>(`/libraries/${libraryId}/gaps/recompute`, {}),
  });
}
