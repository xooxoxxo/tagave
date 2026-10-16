/**
 * Wantlist suggestions from linked apps and the wantlist entries kept in
 * tagave (api › routes/mcWantlist.ts). A decision goes to the app that made
 * the suggestion first; its refusal comes back as the error's detail.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WantlistDecision, WantlistSuggestionView, WantlistView } from '@tagave/shared';
import { api } from '../services/api';

export const wantlistKey = ['wantlist'] as const;

export function useWantlist(libraryId: string | undefined) {
  return useQuery({
    queryKey: [...wantlistKey, libraryId],
    queryFn: () => api.get<WantlistView>(`/me/wantlist?libraryId=${encodeURIComponent(libraryId!)}`),
    enabled: !!libraryId,
    retry: false,
  });
}

/** An accepted album joins the wantlist of `libraryId` (the current library). */
export function useWantlistDecision(libraryId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: WantlistDecision }) =>
      api.post<WantlistSuggestionView>(`/me/wantlist-suggestions/${encodeURIComponent(id)}/decision`, { decision, libraryId }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: wantlistKey }); },
  });
}
