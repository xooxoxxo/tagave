/**
 * The opt-in player module: is a player installed and answering for this
 * library (every Play control hangs on it), Settings › Playback, and the
 * per-device quality choice kept in this browser.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CapabilitiesView, type PlayerAlbumAvailability, type PlayerCapability, type PlayerQuality, type PlayerScanStatus, type PlayerSettingsView, type SavePlayerServer } from '@tagave/shared';
import { api } from '../services/api';
import { useCurrentLibrary } from './useCurrentLibrary';
import { useMe } from './useAuth';
import { DEFAULT_QUALITY } from '../player/logic';
import { getPlayerQuality, setPlayerQuality, subscribePlayerQuality } from '../player/quality';

export const capabilitiesKey = (libraryId: string | undefined) => ['capabilities', libraryId] as const;
export const playerSettingsKey = (libraryId: string | undefined) => ['player-settings', libraryId] as const;
export const albumAvailabilityKey = (albumId: string | undefined) => ['player-availability', albumId] as const;
export const playerScanKey = (libraryId: string | undefined) => ['player-scan', libraryId] as const;

/** While the player is installed but not answering, ask again this often (it may be busy scanning). */
const UNREACHABLE_RETRY_MS = 20_000;
/** While the player server scans, its progress is read this often... */
const SCAN_POLL_MS = 10_000;
/** ...and an album it has not reached yet is checked again this often. */
const WAITING_ALBUM_POLL_MS = 60_000;

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
    // installed but not answering: Play comes back by itself once it answers
    refetchInterval: (q) => {
      const p = (q.state.data as CapabilitiesView | undefined)?.player;
      return p?.installed && !p.reachable ? UNREACHABLE_RETRY_MS : false;
    },
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

/**
 * Can Play start on this album now (GET /player/albums/:id/availability)?
 * Asked once per visit while a player answers; while the server's scan has
 * not reached the album, its progress is polled lightly and the album is
 * checked again now and then, and once more when the scan ends, so Play
 * turns on without a reload. Nothing polls when nothing is scanning.
 */
export function useAlbumPlayability(albumId: string | undefined, enabled: boolean) {
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  const availability = useQuery({
    queryKey: albumAvailabilityKey(albumId),
    queryFn: () => api.get<PlayerAlbumAvailability>(`/player/albums/${encodeURIComponent(albumId!)}/availability`),
    enabled: enabled && !!albumId,
    staleTime: 30_000,
    retry: false,
    refetchInterval: (q) => {
      const a = q.state.data as PlayerAlbumAvailability | undefined;
      return a && a.playable === 0 && a.scan?.scanning ? WAITING_ALBUM_POLL_MS : false;
    },
  });
  const a = availability.data;
  const waiting = !!a && a.playable === 0 && !!a.scan?.scanning;
  const scan = useQuery({
    queryKey: playerScanKey(libraryId),
    queryFn: () => api.get<PlayerScanStatus>(`/libraries/${libraryId}/player/scan-status`),
    enabled: waiting && !!libraryId,
    retry: false,
    refetchInterval: (q) => ((q.state.data as PlayerScanStatus | undefined)?.scanning ? SCAN_POLL_MS : false),
  });
  // the newer of the two answers (the album's own, or the progress poll)
  const latest = scan.data && scan.dataUpdatedAt > availability.dataUpdatedAt ? scan.data : a?.scan ?? null;
  // the scan ended: check the album again at once
  const wasScanning = useRef(false);
  const scanning = waiting ? !!latest?.scanning : false;
  useEffect(() => {
    if (wasScanning.current && !scanning) void queryClient.invalidateQueries({ queryKey: albumAvailabilityKey(albumId) });
    wasScanning.current = scanning;
  }, [scanning, albumId, queryClient]);
  return {
    availability: a ?? null,
    /** the latest scan progress while the album waits for it */
    scan: latest,
  };
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
