/**
 * Where identification stands for a few albums (POST /identify/status): each
 * album's existence, state and the owner's latest request. Polls while any
 * request is still queued or running, so a note like "identification queued"
 * turns into what actually happened.
 */
import { useQuery } from '@tanstack/react-query';
import type { IdentifyRequestView } from '@liner/shared';
import { api } from '../services/api';

export type IdentifyStatusItem =
  | { albumId: string; exists: false }
  | {
      albumId: string;
      exists: true;
      title: string | null;
      artist: string | null;
      state: string;
      reason: string | null;
      request: IdentifyRequestView | null;
    };

export function useIdentifyStatus(libraryId: string | undefined, albumIds: readonly string[]) {
  const ids = [...new Set(albumIds)].sort().slice(0, 50);
  return useQuery({
    queryKey: ['identify-status', libraryId, ids.join(',')],
    queryFn: () => api.post<{ items: IdentifyStatusItem[] }>(`/libraries/${libraryId}/identify/status`, { albumIds: ids }),
    enabled: !!libraryId && ids.length > 0,
    refetchInterval: (q) => {
      const items = (q.state.data as { items: IdentifyStatusItem[] } | undefined)?.items ?? [];
      return items.some((i) => i.exists && i.request && i.request.status !== 'done') ? 3000 : false;
    },
  });
}
