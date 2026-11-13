/**
 * Get missing albums through Lidarr (the lidarr module; api › routes/lidarr.ts):
 * the artist page's requests, Get / Get all missing / Retry / Cancel,
 * Library care › Getting and Settings › Modules › Lidarr. While a
 * request is on its way its state is asked for again every half minute.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ArtistLidarrView, LidarrConnectionRequest, LidarrGettingView, LidarrRequestView, LidarrRootCheckView, LidarrSettingsView, LidarrStatusView,
  LidarrTestRequest, LidarrTestResult,
} from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey, useModuleOn } from './useFacets';

export const lidarrKey = ['lidarr'] as const;
export const lidarrSettingsKey = ['lidarr', 'settings'] as const;
export const lidarrRootKey = ['lidarr', 'settings', 'root-folder'] as const;

const OPEN_POLL_MS = 30_000;
const isOpen = (r: LidarrRequestView) => r.state === 'wanted' || r.state === 'downloading' || r.state === 'imported';

export function useLidarrStatus() {
  const on = useModuleOn('lidarr');
  return useQuery({ queryKey: [...lidarrKey, 'status'], queryFn: () => api.get<LidarrStatusView>('/lidarr'), enabled: on === true, retry: false, staleTime: 60_000 });
}

export function useArtistLidarr(libraryId: string | undefined, artistId: string | undefined, hasMissing: boolean) {
  const on = useModuleOn('lidarr');
  return useQuery({
    queryKey: [...lidarrKey, 'artist', libraryId, artistId],
    queryFn: () => api.get<ArtistLidarrView>(`/libraries/${libraryId}/artists/${artistId}/lidarr`),
    enabled: on === true && hasMissing && !!libraryId && !!artistId,
    retry: false,
    staleTime: 15_000,
    refetchInterval: (q) => (Object.values(q.state.data?.requests ?? {}).some(isOpen) ? OPEN_POLL_MS : false),
  });
}

export function useGetting(libraryId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...lidarrKey, 'getting', libraryId],
    queryFn: () => api.get<LidarrGettingView>(`/libraries/${libraryId}/lidarr/requests`),
    enabled: enabled && !!libraryId,
    retry: false,
    refetchInterval: (q) => (q.state.data?.items.some(isOpen) ? OPEN_POLL_MS : false),
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: lidarrKey });
}

export function useLidarrGet(libraryId: string | undefined) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (releaseGroupId: string) => api.post<LidarrRequestView>(`/libraries/${libraryId}/lidarr/requests`, { releaseGroupId }),
    onSettled: refresh,
  });
}

export function useLidarrGetAll(libraryId: string | undefined, artistId: string | undefined) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => api.post<{ queued: boolean }>(`/libraries/${libraryId}/artists/${artistId}/lidarr/get-all`, {}),
    onSettled: refresh,
  });
}

export function useLidarrRetry(libraryId: string | undefined) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api.post<LidarrRequestView>(`/libraries/${libraryId}/lidarr/requests/${id}/retry`, {}),
    onSettled: refresh,
  });
}

export function useLidarrCancel(libraryId: string | undefined) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/libraries/${libraryId}/lidarr/requests/${id}`),
    onSettled: refresh,
  });
}

/* ---------- Settings › Modules › Lidarr ---------- */

export function useLidarrSettings(enabled = true) {
  return useQuery({ queryKey: lidarrSettingsKey, queryFn: () => api.get<LidarrSettingsView>('/settings/lidarr'), enabled, retry: false });
}

function useAfterSettings() {
  const client = useQueryClient();
  return (view: LidarrSettingsView) => {
    client.setQueryData(lidarrSettingsKey, view);
    void client.invalidateQueries({ queryKey: lidarrRootKey });
    void client.invalidateQueries({ queryKey: facetsKey });
    void client.invalidateQueries({ queryKey: [...lidarrKey, 'status'] });
    void client.invalidateQueries({ queryKey: [...lidarrKey, 'artist'] });
  };
}

export function useSetLidarrModule() {
  const after = useAfterSettings();
  return useMutation({ mutationFn: (enabled: boolean) => api.put<LidarrSettingsView>('/settings/lidarr', { enabled }), onSuccess: after });
}

export function useTestLidarr() {
  return useMutation({ mutationFn: (body: LidarrTestRequest) => api.post<LidarrTestResult>('/settings/lidarr/test', body) });
}

export function useSaveLidarr() {
  const after = useAfterSettings();
  return useMutation({ mutationFn: (body: LidarrConnectionRequest) => api.put<LidarrSettingsView>('/settings/lidarr/connection', body), onSuccess: after });
}

export function useDisconnectLidarr() {
  const after = useAfterSettings();
  return useMutation({ mutationFn: () => api.delete<LidarrSettingsView>('/settings/lidarr/connection'), onSuccess: after });
}

export function useRemoveLidarrData() {
  const after = useAfterSettings();
  return useMutation({ mutationFn: () => api.post<LidarrSettingsView>('/settings/lidarr/remove-data', {}), onSuccess: after });
}

/**
 * The root folder: made in Lidarr when it is the drop pool and Lidarr has
 * none there, then whether Lidarr can write there. Looked at again every
 * minute while Lidarr cannot (the owner is mounting the share).
 */
export function useLidarrRootCheck(enabled: boolean) {
  return useQuery({
    queryKey: lidarrRootKey,
    queryFn: () => api.post<LidarrRootCheckView>('/settings/lidarr/root-folder', {}),
    enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data && q.state.data.reach !== 'writable' ? 60_000 : false),
  });
}
