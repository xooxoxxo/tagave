/**
 * The opt-in player module: is a player installed and answering for this
 * library (every Play control hangs on it), Settings › Playback, and the
 * per-device quality choice kept in this browser.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CapabilitiesView, type PlayerCapability, type PlayerQuality, type PlayerSettingsView, type SavePlayerServer } from '@liner/shared';
import { api } from '../services/api';
import { useCurrentLibrary } from './useCurrentLibrary';
import { useMe } from './useAuth';
import { DEFAULT_QUALITY } from '../player/logic';
import { getPlayerQuality, setPlayerQuality, subscribePlayerQuality } from '../player/quality';

export const capabilitiesKey = (libraryId: string | undefined) => ['capabilities', libraryId] as const;
export const playerSettingsKey = (libraryId: string | undefined) => ['player-settings', libraryId] as const;

/** GET /capabilities for the current library; the server caches the ping for 30 s, so do we. */
export function useCapabilities() {
  const { libraryId } = useCurrentLibrary();
  const { data: user } = useMe();
  return useQuery({
    queryKey: capabilitiesKey(libraryId),
    queryFn: () => api.get<CapabilitiesView>(`/capabilities?libraryId=${encodeURIComponent(libraryId!)}`),
    enabled: !!user && !!libraryId,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
}

/** Playback can be offered: a player is installed and answered. */
export function playbackAvailable(player: PlayerCapability | null | undefined): boolean {
  return !!player?.installed && !!player.reachable;
}

/** Whether Play buttons, per-track play and the player bar may show. */
export function usePlaybackAvailable(): boolean {
  return playbackAvailable(useCapabilities().data?.player);
}

export function usePlayerSettings(libraryId: string | undefined) {
  return useQuery({
    queryKey: playerSettingsKey(libraryId),
    queryFn: () => api.get<PlayerSettingsView>(`/libraries/${libraryId}/player`),
    enabled: !!libraryId,
    retry: false,
  });
}

function useSettled(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return (view?: PlayerSettingsView) => {
    if (view) queryClient.setQueryData(playerSettingsKey(libraryId), view);
    void queryClient.invalidateQueries({ queryKey: playerSettingsKey(libraryId) });
    void queryClient.invalidateQueries({ queryKey: capabilitiesKey(libraryId) });
  };
}

/** Saves the bring-your-own server; the API tests the connection first (400 with the server's words when it fails). */
export function useSavePlayerServer(libraryId: string | undefined) {
  const settled = useSettled(libraryId);
  return useMutation({
    mutationFn: (body: SavePlayerServer) => api.put<PlayerSettingsView>(`/libraries/${libraryId}/player/server`, body),
    onSuccess: (view) => settled(view),
  });
}

export function useRemovePlayerServer(libraryId: string | undefined) {
  const settled = useSettled(libraryId);
  return useMutation({
    mutationFn: () => api.delete<PlayerSettingsView>(`/libraries/${libraryId}/player/server`),
    onSuccess: (view) => settled(view),
  });
}

export function useScanPlayer(libraryId: string | undefined) {
  const settled = useSettled(libraryId);
  return useMutation({
    mutationFn: () => api.post<unknown>(`/libraries/${libraryId}/player/scan`),
    onSuccess: () => settled(),
  });
}

// ---- the per-device quality (player/quality.ts) ----

export function usePlayerQuality(): [PlayerQuality, (patch: Partial<PlayerQuality>) => void] {
  const quality = useSyncExternalStore(subscribePlayerQuality, getPlayerQuality, () => DEFAULT_QUALITY);
  const update = useCallback((patch: Partial<PlayerQuality>) => setPlayerQuality(patch), []);
  return [quality, update];
}
