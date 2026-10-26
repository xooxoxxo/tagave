/**
 * Listen elsewhere (the listen-links module; api › routes/listenLinks.ts):
 * the person's platforms, an album's and an artist's links, and the
 * Settings › Modules row. While a lookup is on its way the links are asked
 * for again every few seconds, a few times.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlbumListenLinksView, ArtistListenLinksView, ListenLinksModuleView, ListenPlatform, ListenPrefsView } from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey, useModuleOn } from './useFacets';

export const listenPrefsKey = ['listen-prefs'] as const;
export const listenModuleKey = ['listen-module'] as const;
const linksKey = ['listen-links'] as const;

const POLL_MS = 4000;
const POLLS = 5;

/** While `pending`, ask again (at most POLLS times). */
const poll = <T extends { pending: boolean }>(q: { state: { data: T | undefined; dataUpdateCount: number } }) =>
  q.state.data?.pending && q.state.dataUpdateCount <= POLLS ? POLL_MS : false;

export function useListenPrefs(enabled = true) {
  return useQuery({ queryKey: listenPrefsKey, queryFn: () => api.get<ListenPrefsView>('/me/listen-links'), enabled, retry: false });
}

export function useSetListenPrefs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (platforms: ListenPlatform[]) => api.put<ListenPrefsView>('/me/listen-links', { platforms }),
    onSuccess: (view) => {
      client.setQueryData(listenPrefsKey, view);
      void client.invalidateQueries({ queryKey: linksKey });
    },
  });
}

/** An album's links for the person, or null while the module is off or unknown. */
export function useAlbumListenLinks(libraryId: string | undefined, releaseGroupId: string | null | undefined) {
  const on = useModuleOn('listen-links');
  return useQuery({
    queryKey: [...linksKey, 'album', libraryId, releaseGroupId],
    queryFn: () => api.get<AlbumListenLinksView>(`/libraries/${libraryId}/release-groups/${releaseGroupId}/listen-links`),
    enabled: on === true && !!libraryId && !!releaseGroupId,
    retry: false,
    staleTime: 60_000,
    refetchInterval: poll,
  });
}

/** Links for each album an artist is missing, by release group id. */
export function useArtistListenLinks(libraryId: string | undefined, artistId: string | undefined, hasMissing: boolean) {
  const on = useModuleOn('listen-links');
  return useQuery({
    queryKey: [...linksKey, 'artist', libraryId, artistId],
    queryFn: () => api.get<ArtistListenLinksView>(`/libraries/${libraryId}/artists/${artistId}/listen-links`),
    enabled: on === true && hasMissing && !!libraryId && !!artistId,
    retry: false,
    staleTime: 60_000,
    refetchInterval: poll,
  });
}

/* ---------- Settings › Modules: the Listen elsewhere row ---------- */

export function useListenLinksModule(enabled = true) {
  return useQuery({ queryKey: listenModuleKey, queryFn: () => api.get<ListenLinksModuleView>('/settings/listen-links'), enabled, retry: false });
}

function useAfter() {
  const client = useQueryClient();
  return (view: ListenLinksModuleView) => {
    client.setQueryData(listenModuleKey, view);
    for (const key of [facetsKey, listenPrefsKey, linksKey]) void client.invalidateQueries({ queryKey: key });
  };
}

export function useSetListenLinksModule() {
  const after = useAfter();
  return useMutation({ mutationFn: (enabled: boolean) => api.put<ListenLinksModuleView>('/settings/listen-links', { enabled }), onSuccess: after });
}

export function useRemoveListenLinksData() {
  const after = useAfter();
  return useMutation({ mutationFn: () => api.post<ListenLinksModuleView>('/settings/listen-links/remove-data', {}), onSuccess: after });
}
