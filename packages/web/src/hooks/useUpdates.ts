/**
 * Build identity + release feed (spec PLT-5, XO-313).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetUpdatesFeed, UpdatesStatus } from '@liner/shared';
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
    mutationFn: (body: SetUpdatesFeed) => api.put<UpdatesStatus>(`/libraries/${libraryId}/updates/feed`, body),
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

/** "Skip this version" (null: stop skipping). */
export function useSkipUpdate(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: string | null) => api.put<UpdatesStatus>(`/libraries/${libraryId}/updates/skip`, { version }),
    onSuccess: (data) => queryClient.setQueryData(key(libraryId), data),
  });
}

/**
 * The quiet "new version" dot on the Settings nav item. Same query as the
 * page (the server refreshes the feed on its own every 12 hours); refetched
 * hourly so a long-open tab notices.
 */
export function useUpdateAvailable(libraryId: string | undefined): boolean {
  const { data } = useQuery({
    queryKey: key(libraryId),
    queryFn: () => api.get<UpdatesStatus>(`/libraries/${libraryId}/updates`),
    enabled: !!libraryId,
    staleTime: 60_000,
    refetchInterval: 3600_000,
    retry: false,
  });
  return !!data?.updateAvailable;
}
