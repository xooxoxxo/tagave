/**
 * The opt-in updater (Settings › Updates). The updater container holds the
 * run, so the page only polls: every two seconds while a run is under way
 * (and while the app is unreachable because it is restarting), every
 * minute otherwise. A failed poll keeps the last answer on screen.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateRun, UpdaterView } from '@tagave/shared';
import { api } from '../services/api';

export const updaterKey = ['updater'] as const;

export function useUpdater(enabled = true) {
  return useQuery({
    queryKey: updaterKey,
    queryFn: () => api.get<UpdaterView>('/updater'),
    enabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const run = query.state.data?.updater?.run;
      if (run?.status === 'running') return 2000;
      // The app (or the updater) went away mid-run: keep knocking.
      if (query.state.error && query.state.data?.updater?.run) return 2000;
      return 60_000;
    },
  });
}

export function useStartUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: string) => api.post<{ run: UpdateRun }>('/updater/update', { version }),
    onSuccess: ({ run }) => {
      queryClient.setQueryData<UpdaterView>(updaterKey, (prev) =>
        prev?.updater ? { ...prev, updater: { ...prev.updater, run } } : prev);
      void queryClient.invalidateQueries({ queryKey: updaterKey });
    },
  });
}
