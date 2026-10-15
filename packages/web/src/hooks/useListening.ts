/**
 * Listening, per person (Settings › Listening): their account on the player
 * server, Last.fm and ListenBrainz, their recent plays; and the owner's
 * Last.fm application (Settings › Playback › Scrobbling).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LastfmStartView, ListeningHistoryView, ListeningView, OwnPlayerAccount, PlayerAccountView, SaveLastfmApp, ScrobbleAccountView, ScrobbleService, ScrobblingSettingsView } from '@tagave/shared';
import { api } from '../services/api';
import { useCurrentLibrary } from './useCurrentLibrary';

export const listeningKey = (libraryId: string | undefined) => ['listening', libraryId] as const;
export const listeningHistoryKey = ['listening-history'] as const;
export const scrobblingKey = (libraryId: string | undefined) => ['scrobbling', libraryId] as const;

const q = (libraryId: string | undefined) => (libraryId ? `?libraryId=${encodeURIComponent(libraryId)}` : '');

export function useListening() {
  const { libraryId } = useCurrentLibrary();
  return useQuery({
    queryKey: listeningKey(libraryId),
    queryFn: () => api.get<ListeningView>(`/me/listening${q(libraryId)}`),
    retry: false,
    // the scrobble status moves while music plays
    refetchInterval: 30_000,
  });
}

export function useListeningHistory() {
  return useQuery({
    queryKey: listeningHistoryKey,
    queryFn: () => api.get<ListeningHistoryView>('/me/listening/history?limit=20'),
    retry: false,
    refetchInterval: 30_000,
  });
}

function useRefresh() {
  const client = useQueryClient();
  const { libraryId } = useCurrentLibrary();
  return () => {
    void client.invalidateQueries({ queryKey: listeningKey(libraryId) });
    void client.invalidateQueries({ queryKey: listeningHistoryKey });
  };
}

/** Starts the Last.fm web auth: the browser leaves for last.fm and comes back to Settings › Listening. */
export function useConnectLastfm() {
  const { libraryId } = useCurrentLibrary();
  return useMutation({
    mutationFn: () => api.post<LastfmStartView>(`/me/listening/lastfm/start${q(libraryId)}`),
    onSuccess: ({ url }) => { globalThis.location?.assign(url); },
  });
}

export function useConnectListenbrainz() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (token: string) => api.post<{ services: ScrobbleAccountView[] }>('/me/listening/listenbrainz', { token }),
    onSuccess: refresh,
  });
}

export function useDisconnectScrobbler() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (service: ScrobbleService) => api.delete<{ services: ScrobbleAccountView[] }>(`/me/listening/${service}`),
    onSuccess: refresh,
  });
}

export function useSetPhonePassword() {
  const refresh = useRefresh();
  const { libraryId } = useCurrentLibrary();
  return useMutation({
    mutationFn: (password: string) => api.put<{ account: PlayerAccountView }>(`/me/listening/phone-password${q(libraryId)}`, { password }),
    onSuccess: refresh,
  });
}

export function useClearPhonePassword() {
  const refresh = useRefresh();
  const { libraryId } = useCurrentLibrary();
  return useMutation({
    mutationFn: () => api.delete<{ account: PlayerAccountView }>(`/me/listening/phone-password${q(libraryId)}`),
    onSuccess: refresh,
  });
}

export function useSaveOwnAccount() {
  const refresh = useRefresh();
  const { libraryId } = useCurrentLibrary();
  return useMutation({
    mutationFn: (body: OwnPlayerAccount) => api.put<{ account: PlayerAccountView }>(`/me/listening/account${q(libraryId)}`, body),
    onSuccess: refresh,
  });
}

export function useRemoveOwnAccount() {
  const refresh = useRefresh();
  const { libraryId } = useCurrentLibrary();
  return useMutation({
    mutationFn: () => api.delete<{ account: PlayerAccountView }>(`/me/listening/account${q(libraryId)}`),
    onSuccess: refresh,
  });
}

// ---- the owner's Last.fm application ----

export function useScrobblingSettings(libraryId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: scrobblingKey(libraryId),
    queryFn: () => api.get<ScrobblingSettingsView>(`/libraries/${libraryId}/player/scrobbling`),
    enabled: enabled && !!libraryId,
    retry: false,
  });
}

function useScrobblingSettled(libraryId: string | undefined) {
  const client = useQueryClient();
  return (view: ScrobblingSettingsView) => {
    client.setQueryData(scrobblingKey(libraryId), view);
    void client.invalidateQueries({ queryKey: listeningKey(libraryId) });
  };
}

export function useSaveLastfmApp(libraryId: string | undefined) {
  const settled = useScrobblingSettled(libraryId);
  return useMutation({
    mutationFn: (body: SaveLastfmApp) => api.put<ScrobblingSettingsView>(`/libraries/${libraryId}/player/scrobbling`, body),
    onSuccess: settled,
  });
}

export function useRemoveLastfmApp(libraryId: string | undefined) {
  const settled = useScrobblingSettled(libraryId);
  return useMutation({
    mutationFn: () => api.delete<ScrobblingSettingsView>(`/libraries/${libraryId}/player/scrobbling`),
    onSuccess: settled,
  });
}
