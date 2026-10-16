/**
 * Settings › Modules, the Music Connections row (api › routes/facets.ts):
 * a setting, not a container. Changing it needs a fresh step-up.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { McModuleView } from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey } from './useFacets';
import { connectionsKey } from './useConnections';
import { wantlistKey } from './useWantlist';

export const mcModuleKey = ['mc-module'] as const;

export function useMcModule(enabled = true) {
  return useQuery({ queryKey: mcModuleKey, queryFn: () => api.get<McModuleView>('/settings/music-connections'), enabled, retry: false });
}

function useAfter() {
  const client = useQueryClient();
  return (view: McModuleView) => {
    client.setQueryData(mcModuleKey, view);
    for (const key of [facetsKey, connectionsKey, wantlistKey]) void client.invalidateQueries({ queryKey: key });
  };
}

export function useSetMcModule() {
  const after = useAfter();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put<McModuleView>('/settings/music-connections', { enabled }),
    onSuccess: after,
  });
}

export function useRemoveMcData() {
  const after = useAfter();
  return useMutation({
    mutationFn: (keepFills: boolean) => api.post<McModuleView>('/settings/music-connections/remove-data', { keepFills }),
    onSuccess: after,
  });
}
