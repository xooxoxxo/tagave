/**
 * What is on (GET /api/v1/facets): the app hides what a module that is off
 * would show (the Connections page, wantlist suggestions, linked apps'
 * critic scores). Unknown while loading: callers treat null as "not yet".
 */
import { useQuery } from '@tanstack/react-query';
import type { FacetsView } from '@tagave/shared';
import { api } from '../services/api';

export const facetsKey = ['facets'] as const;

export function useFacets() {
  return useQuery({
    queryKey: facetsKey,
    queryFn: () => api.get<FacetsView>('/facets'),
    staleTime: 60_000,
    retry: false,
  });
}

/** Whether a module is on: true, false, or null while unknown. */
export function useModuleOn(id: string): boolean | null {
  const { data } = useFacets();
  const m = data?.modules.find((x) => x.id === id);
  return m ? m.enabled : null;
}
