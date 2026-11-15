/**
 * Accept batches (api › routes/batches.ts), rule batches and model batches
 * alike: the list, one batch's detail, Undo, and the nightly bridge's pace
 * ("Drain faster", the owner's). Undoing a model's batch needs
 * system.manage; a rule batch is library care.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BatchDetail, BatchSummary, DrainEstimate } from '@tagave/shared';
import { api } from '../services/api';

export const batchesKey = (libraryId: string | undefined) => ['batches', libraryId] as const;

/** The paces the bridge can run at (@tagave/db ENRICH_PACES), slowest first. */
export const ENRICH_PACES = [400, 800, 1600] as const;

/** The next pace up, or null at the fastest. */
export function fasterPace(limit: number): number | null {
  return ENRICH_PACES.find((p) => p > limit) ?? null;
}

const moving = (b: Pick<BatchSummary, 'state'>) => b.state === 'queued' || b.state === 'accepting' || b.state === 'undoing';

export function useBatches(libraryId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: batchesKey(libraryId),
    queryFn: () => api.get<{ items: BatchSummary[] }>(`/libraries/${libraryId}/batches`),
    enabled: !!libraryId && enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data?.items.some(moving) ? 3000 : false),
  });
}

export function useBatch(libraryId: string | undefined, batchId: string | null) {
  return useQuery({
    queryKey: [...batchesKey(libraryId), batchId],
    queryFn: () => api.get<BatchDetail>(`/libraries/${libraryId}/batches/${batchId}`),
    enabled: !!libraryId && !!batchId,
    retry: false,
    refetchInterval: (q) => (q.state.data && moving(q.state.data) ? 3000 : false),
  });
}

export function useUndoBatch(libraryId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => api.post<{ ok: true }>(`/libraries/${libraryId}/batches/${batchId}/undo`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: batchesKey(libraryId) });
      void client.invalidateQueries({ queryKey: ['autotagger', libraryId] });
    },
  });
}

export function useSetEnrichPace(libraryId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (limit: number) => api.put<{ limit: number; drain: DrainEstimate }>(`/libraries/${libraryId}/enrich-pace`, { limit }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: batchesKey(libraryId) });
      void client.invalidateQueries({ queryKey: ['autotagger', libraryId, 'accept-preview'] });
    },
  });
}
