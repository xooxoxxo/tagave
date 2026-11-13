/**
 * Playlists (the playlists module; api › routes/playlists.ts): the person's
 * lists, one list, the changes to them, import and export, and the Settings
 * › Modules row. Off (or unknown): nothing is asked for.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlayHistoryEntry, PlaylistCollaboratorChoice, PlaylistImportResult, PlaylistSummary, PlaylistView, PlaylistsModuleView } from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey, useModuleOn } from './useFacets';
import { useCan } from './usePermissions';

export const playlistsKey = ['playlists'] as const;
export const playlistKey = (id: string | undefined) => ['playlists', 'one', id] as const;
export const playlistsModuleKey = ['playlists-module'] as const;
export const playHistoryKey = ['player-history'] as const;

/** Playlists can be used here: the module is on and the person may read the catalogue. */
export function usePlaylistsOn(): boolean {
  const on = useModuleOn('playlists');
  const canRead = useCan('catalog.read');
  return on === true && canRead;
}

export function usePlaylists() {
  const on = usePlaylistsOn();
  return useQuery({
    queryKey: playlistsKey,
    queryFn: async () => (await api.get<{ playlists: PlaylistSummary[] }>('/me/playlists')).playlists,
    enabled: on,
    staleTime: 30_000,
    retry: false,
  });
}

export function usePlaylist(id: string | undefined) {
  const on = usePlaylistsOn();
  return useQuery({
    queryKey: playlistKey(id),
    queryFn: () => api.get<PlaylistView>(`/me/playlists/${encodeURIComponent(id!)}`),
    enabled: on && !!id,
    retry: false,
  });
}

function useAfter() {
  const client = useQueryClient();
  return (view?: PlaylistView) => {
    if (view) client.setQueryData(playlistKey(view.id), view);
    void client.invalidateQueries({ queryKey: playlistsKey, exact: true });
  };
}

export function useCreatePlaylist() {
  const after = useAfter();
  return useMutation({
    mutationFn: (b: { name: string; trackIds?: string[] }) => api.post<PlaylistView>('/me/playlists', b),
    onSuccess: after,
  });
}

export function useAddToPlaylist() {
  const after = useAfter();
  return useMutation({
    mutationFn: ({ id, ...b }: { id: string; trackIds?: string[]; albumId?: string }) => api.post<PlaylistView>(`/me/playlists/${encodeURIComponent(id)}/items`, b),
    onSuccess: after,
  });
}

export function usePatchPlaylist() {
  const after = useAfter();
  return useMutation({
    mutationFn: ({ id, ...b }: { id: string; name?: string; order?: string[] }) => api.patch<PlaylistView>(`/me/playlists/${encodeURIComponent(id)}`, b),
    onSuccess: after,
  });
}

export function useRemovePlaylistItem() {
  const after = useAfter();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) => api.delete<PlaylistView>(`/me/playlists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`),
    onSuccess: after,
  });
}

export function useDeletePlaylist() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/me/playlists/${encodeURIComponent(id)}`),
    onSuccess: (_r, id) => {
      client.removeQueries({ queryKey: playlistKey(id) });
      void client.invalidateQueries({ queryKey: playlistsKey, exact: true });
    },
  });
}

/** The owner's Collaborators sheet: the install's other people, each on or off. */
export const playlistCollaboratorsKey = (id: string) => ['playlists', 'collaborators', id] as const;

export function usePlaylistCollaborators(id: string, enabled: boolean) {
  return useQuery({
    queryKey: playlistCollaboratorsKey(id),
    queryFn: async () => (await api.get<{ people: PlaylistCollaboratorChoice[] }>(`/me/playlists/${encodeURIComponent(id)}/collaborators`)).people,
    enabled,
    retry: false,
  });
}

export function useSetCollaborator(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, on }: { userId: string; on: boolean }) =>
      api.put<{ people: PlaylistCollaboratorChoice[] }>(`/me/playlists/${encodeURIComponent(id)}/collaborators/${encodeURIComponent(userId)}`, { on }),
    onSuccess: (r) => {
      client.setQueryData(playlistCollaboratorsKey(id), r.people);
      // the header's people and the lists' collaborative mark
      void client.invalidateQueries({ queryKey: playlistKey(id) });
      void client.invalidateQueries({ queryKey: playlistsKey, exact: true });
    },
  });
}

export function useImportPlaylists() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (b: { content: string; fileName?: string }) => api.post<PlaylistImportResult>('/me/playlists/import', b),
    onSuccess: () => void client.invalidateQueries({ queryKey: playlistsKey, exact: true }),
  });
}

/** Where a list's file (or every list's) downloads from. */
export const playlistExportUrl = (id?: string) => (id ? `/api/v1/me/playlists/${encodeURIComponent(id)}/export` : '/api/v1/me/playlists/export');
export const allPlaylistsExportUrl = '/api/v1/settings/playlists/export';

/** Downloads a file the API serves (the session cookie goes with it). */
export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The person's plays, newest first (the Now Playing view's History). */
export function usePlayHistory(enabled: boolean) {
  return useQuery({
    queryKey: playHistoryKey,
    queryFn: async () => (await api.get<{ plays: PlayHistoryEntry[] }>('/me/player/history?limit=50')).plays,
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}

/* ---------- Settings › Modules: the Playlists row ---------- */

export function usePlaylistsModule(enabled = true) {
  return useQuery({ queryKey: playlistsModuleKey, queryFn: () => api.get<PlaylistsModuleView>('/settings/playlists'), enabled, retry: false });
}

function useModuleAfter() {
  const client = useQueryClient();
  return (view: PlaylistsModuleView) => {
    client.setQueryData(playlistsModuleKey, view);
    for (const key of [facetsKey, playlistsKey]) void client.invalidateQueries({ queryKey: key });
  };
}

export function useSetPlaylistsModule() {
  const after = useModuleAfter();
  return useMutation({ mutationFn: (enabled: boolean) => api.put<PlaylistsModuleView>('/settings/playlists', { enabled }), onSuccess: after });
}

export function useRemovePlaylistsData() {
  const after = useModuleAfter();
  return useMutation({ mutationFn: () => api.post<PlaylistsModuleView>('/settings/playlists/remove-data'), onSuccess: after });
}
