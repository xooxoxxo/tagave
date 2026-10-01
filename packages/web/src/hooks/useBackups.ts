/**
 * Settings › Backups: the dumps in the backups folder, "Back up now",
 * delete, and the nightly schedule and retention.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupSettingsView, BackupsStatus } from '@liner/shared';
import { api } from '../services/api';

const key = ['backups'] as const;

export function useBackups() {
  return useQuery({
    queryKey: key,
    queryFn: () => api.get<BackupsStatus>('/backups'),
    // poll while a backup runs so the new one appears when it is done
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });
}

export function useBackUpNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<BackupsStatus>('/backups'),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
}

export function useDeleteBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.delete<void>(`/backups/${encodeURIComponent(name)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useSaveBackupSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: BackupSettingsView) => api.put<BackupsStatus>('/backups/settings', settings),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
}

/** The authenticated download address (the session cookie goes along with a plain link). */
export function backupDownloadUrl(name: string): string {
  return `/api/v1/backups/${encodeURIComponent(name)}/download`;
}
