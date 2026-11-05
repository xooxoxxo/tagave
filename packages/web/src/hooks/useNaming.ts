/**
 * Naming rules, the drop pool, Library care › Organize and › Inbox (0081).
 * Owner only (system.manage): each of them moves files in the music folder.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DropPoolView, InboxAction, InboxItem, NamingExample, NamingRulesInput, NamingView, OrganizeView, PutDropPool,
} from '@tagave/shared';
import { api } from '../services/api';
import { useCan } from './usePermissions';
import { invalidateAfterMove } from './useAlbumMove';

export const namingKey = (libraryId: string | undefined) => ['naming', libraryId] as const;
export const dropPoolKey = (libraryId: string | undefined) => ['drop-pool', libraryId] as const;
export const organizeKey = (libraryId: string | undefined) => ['organize', libraryId] as const;
export const inboxKey = (libraryId: string | undefined) => ['inbox', libraryId] as const;

/** Pool states the worker is on: the Inbox looks again while any row is in one. */
export const POOL_BUSY = new Set(['waiting', 'identifying', 'importing']);

export function useNaming(libraryId: string | undefined) {
  const owner = useCan('system.manage');
  return useQuery({
    queryKey: namingKey(libraryId),
    queryFn: () => api.get<NamingView>(`/libraries/${libraryId}/naming`),
    enabled: owner && !!libraryId,
  });
}

export function useSaveNaming(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: NamingRulesInput) => api.put<NamingView>(`/libraries/${libraryId}/naming`, { rules }),
    onSuccess: (view) => {
      qc.setQueryData(namingKey(libraryId), view);
      void qc.invalidateQueries({ queryKey: organizeKey(libraryId) });
    },
  });
}

/** Examples of unsaved rules, as the owner types. */
export function useNamingExamples(libraryId: string | undefined) {
  return useMutation({
    mutationFn: (rules: NamingRulesInput) =>
      api.post<{ examples: NamingExample[]; problems: Record<string, string> }>(`/libraries/${libraryId}/naming/examples`, { rules }),
  });
}

export function useDropPool(libraryId: string | undefined) {
  const owner = useCan('system.manage');
  return useQuery({
    queryKey: dropPoolKey(libraryId),
    queryFn: () => api.get<DropPoolView>(`/libraries/${libraryId}/drop-pool`),
    enabled: owner && !!libraryId,
    // the file worker's first look at a pool just turned on lands within seconds
    refetchInterval: (q) => (q.state.data?.enabled && q.state.data.state === null ? 5_000 : false),
  });
}

export function useSaveDropPool(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutDropPool) => api.put<DropPoolView>(`/libraries/${libraryId}/drop-pool`, body),
    onSuccess: (view) => {
      qc.setQueryData(dropPoolKey(libraryId), view);
      void qc.invalidateQueries({ queryKey: inboxKey(libraryId) });
    },
  });
}

export function useOrganize(libraryId: string | undefined) {
  const owner = useCan('system.manage');
  return useQuery({
    queryKey: organizeKey(libraryId),
    queryFn: () => api.get<OrganizeView>(`/libraries/${libraryId}/organize`),
    enabled: owner && !!libraryId,
  });
}

/** Organize these albums: batches of 50, one after another (the API takes up to 200). */
export function useRunOrganize(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (albumIds: string[]) => {
      let queued = 0;
      for (let i = 0; i < albumIds.length; i += 50) {
        const r = await api.post<{ queued: number }>(`/libraries/${libraryId}/organize`, { albumIds: albumIds.slice(i, i + 50) });
        queued += r.queued;
      }
      return { queued };
    },
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: organizeKey(libraryId) }),
      invalidateAfterMove(qc, libraryId),
    ]),
  });
}

export function useInbox(libraryId: string | undefined) {
  const owner = useCan('system.manage');
  return useQuery({
    queryKey: inboxKey(libraryId),
    queryFn: () => api.get<{ items: InboxItem[] }>(`/libraries/${libraryId}/inbox`),
    enabled: owner && !!libraryId,
    refetchInterval: (query) => (query.state.data?.items.some((i) => POOL_BUSY.has(i.state)) ? 5000 : false),
  });
}

export function useInboxAction(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, action }: { itemId: string; action: InboxAction }) =>
      api.post<InboxItem>(`/libraries/${libraryId}/inbox/${itemId}`, action),
    onSuccess: (item) => {
      qc.setQueryData<{ items: InboxItem[] }>(inboxKey(libraryId), (prev) =>
        prev ? { items: prev.items.map((i) => (i.id === item.id ? item : i)) } : prev);
      void qc.invalidateQueries({ queryKey: inboxKey(libraryId) });
      void qc.invalidateQueries({ queryKey: dropPoolKey(libraryId) });
    },
  });
}

/** A plan's Organize files: the plan goes back to draft and is previewed again. */
export function usePlanOrganize(libraryId: string | undefined, planId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => api.post<{ organize: boolean }>(`/libraries/${libraryId}/tag-plans/${planId}/organize`, { on }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
      void qc.invalidateQueries({ queryKey: ['tag-plan', libraryId, planId] });
      void qc.invalidateQueries({ queryKey: ['tag-plan-items', libraryId, planId] });
      void qc.invalidateQueries({ queryKey: ['tag-plan-summary', libraryId, planId] });
    },
  });
}

/** The UUID in a MusicBrainz release URL or a bare MBID; null when there is none. */
export function releaseMbidOf(text: string): string | null {
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
}
