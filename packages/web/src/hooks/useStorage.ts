/**
 * Settings › Storage: disk use (GET /storage) and the tag-change cleanup
 * (preview GET /storage/tag-changes, run POST /storage/tag-changes/cleanup).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StorageOverview, TagChangeCleanupPreview, TagChangeCleanupRequest, TagChangeCleanupResult, TagChangeCleanupScope } from '@liner/shared';
import { api } from '../services/api';

export function useStorage() {
  return useQuery({
    queryKey: ['storage'],
    queryFn: () => api.get<StorageOverview>('/storage'),
    staleTime: 60 * 1000,
  });
}

export function useTagChangeCleanupPreview(scope: TagChangeCleanupScope) {
  return useQuery({
    queryKey: ['storage', 'tag-changes', scope],
    queryFn: () => api.get<TagChangeCleanupPreview>(`/storage/tag-changes?scope=${scope}`),
  });
}

export function useTagChangeCleanup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TagChangeCleanupRequest) => api.post<TagChangeCleanupResult>('/storage/tag-changes/cleanup', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['storage'] });
      void queryClient.invalidateQueries({ queryKey: ['tag-plans'] });
    },
  });
}
