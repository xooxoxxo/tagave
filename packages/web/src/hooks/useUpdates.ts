/**
 * Build identity + release feed (spec PLT-5, XO-313).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdatesStatus } from '@liner/shared';
import { api } from '../services/api';

const key = (libraryId: string | undefined) => ['updates', libraryId] as const;

export function useUpdates(libraryId: string | undefined) {
  return useQuery({
    queryKey: key(libraryId),
    queryFn: () => api.get<UpdatesStatus>(`/libraries/${libraryId}/updates`),
    enabled: !!libraryId,
    staleTime: 60_000,
  });
}

export function useSetUpdatesFeed(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (url: string | null) => api.put<UpdatesStatus>(`/libraries/${libraryId}/updates/feed`, { url }),
    onSuccess: (data) => queryClient.setQueryData(key(libraryId), data),
  });
}

export function useCheckUpdates(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<UpdatesStatus>(`/libraries/${libraryId}/updates/check`),
    onSuccess: (data) => queryClient.setQueryData(key(libraryId), data),
  });
}
