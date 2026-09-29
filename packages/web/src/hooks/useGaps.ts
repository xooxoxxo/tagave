/**
 * Gap decisions and the Tasks list (0032): counts for the nav and tabs, the
 * task list, and the three choices every gap offers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GapTaskCounts, GapTasksResponse } from '@liner/shared';
import { api } from '../services/api';

export interface GapCountsResponse {
  /** open gaps per kind */
  counts: Record<string, number>;
  tasks?: GapTaskCounts;
}

/** Open gaps per kind and the task counts; one cached request shared by the nav, Home and Library care. */
export function useGapCounts(libraryId: string | null | undefined) {
  return useQuery({
    queryKey: ['gaps', libraryId],
    queryFn: () => api.get<GapCountsResponse>(`/libraries/${libraryId}/gaps?limit=1`),
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
