/**
 * Settings › Connections: the person's Music Connections links (tagave as a
 * client). Add and Re-approve send the browser to the other app's consent
 * page; it comes back to Settings › Connections with ?linked= or ?error=.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { McConnectionsView, McLinkView, McStartView } from '@tagave/shared';
import { api } from '../services/api';

export const connectionsKey = ['connections'] as const;

export function useConnections() {
  return useQuery({
    queryKey: connectionsKey,
    queryFn: () => api.get<McConnectionsView>('/me/connections'),
    retry: false,
    // a sync runs in the background: its outcome shows up here
    refetchInterval: 20_000,
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => { void client.invalidateQueries({ queryKey: connectionsKey }); };
}

const leave = ({ authorizeUrl }: McStartView) => { globalThis.location?.assign(authorizeUrl); };

export function useAddConnection() {
  return useMutation({
    mutationFn: (url: string) => api.post<McStartView>('/me/connections', { url }),
    onSuccess: leave,
  });
}

export function useReapproveConnection() {
  return useMutation({
    mutationFn: (id: string) => api.post<McStartView>(`/me/connections/${encodeURIComponent(id)}/reapprove`),
    onSuccess: leave,
  });
}

export function useSyncConnection() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api.post<{ status: 'queued' }>(`/me/connections/${encodeURIComponent(id)}/sync`),
    onSuccess: refresh,
  });
}

export function useEditConnectionUrl() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, url }: { id: string; url: string }) => api.patch<McLinkView>(`/me/connections/${encodeURIComponent(id)}`, { url }),
    onSuccess: refresh,
  });
}

export function useRevokeConnection() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true; removed: boolean }>(`/me/connections/${encodeURIComponent(id)}`),
    onSuccess: refresh,
  });
}
