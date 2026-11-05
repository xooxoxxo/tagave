/**
 * Settings › Modules › DJ (api › routes/dj.ts): the switch, how far the
 * analysis has got, Delete its data. Changing it needs a fresh step-up.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DjModuleView } from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey } from './useFacets';

export const djModuleKey = ['dj-module'] as const;

export function useDjModule(enabled = true) {
  return useQuery({ queryKey: djModuleKey, queryFn: () => api.get<DjModuleView>('/settings/dj'), enabled, retry: false });
}

function useAfter() {
  const client = useQueryClient();
  return (view: DjModuleView) => {
    client.setQueryData(djModuleKey, view);
    void client.invalidateQueries({ queryKey: facetsKey });
  };
}

export function useSetDjModule() {
  const after = useAfter();
  return useMutation({ mutationFn: (enabled: boolean) => api.put<DjModuleView>('/settings/dj', { enabled }), onSuccess: after });
}

export function useRemoveDjData() {
  const after = useAfter();
  return useMutation({ mutationFn: () => api.post<DjModuleView>('/settings/dj/remove-data', {}), onSuccess: after });
}
