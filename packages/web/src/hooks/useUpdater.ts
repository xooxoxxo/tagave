/**
 * The opt-in updater (Settings › Updates). The updater container holds the
 * run, so the page only polls: every two seconds while a run is under way
 * (and while the app is unreachable because it is restarting), every
 * minute otherwise. A failed poll keeps the last answer on screen.
 *
 * After a successful update the updater restarts itself on the new version
 * (`selfReplace` in its status). It refuses new runs until the replacement
 * is up, and for a few seconds it does not answer at all; the last answer
 * (with its marker) stays on screen meanwhile, so the page keeps saying
 * "restarting the updater" instead of "the updater does not answer".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SELF_REPLACE_STALE_MS, type UpdateRun, type UpdaterSelfReplace, type UpdaterView } from '@tagave/shared';
import { api } from '../services/api';

export const updaterKey = ['updater'] as const;

/**
 * The view as the page keeps it: `restartUntil` is when to stop waiting for
 * the updater's self-restart, by this browser's clock. It comes from the age
 * the updater reports for its marker (or, from an updater that does not
 * report one, from when this page first saw it); the browser's clock is
 * never compared with the server's `since`.
 */
export type SeenUpdaterView = UpdaterView & { restartUntil?: number };

/** The pending self-restart, unless this page has waited for it long enough. */
export function restartingOn(view: SeenUpdaterView | undefined, now = Date.now()): UpdaterSelfReplace | null {
  const m = view?.updater?.selfReplace ?? null;
  if (!m) return null;
  return view?.restartUntil === undefined || now <= view.restartUntil ? m : null;
}

/**
 * Takes a fresh answer in. While the updater restarts itself it may not
 * answer; the last answer (marked unreachable) stays until the new one does,
 * bounded by `restartUntil`.
 */
export function receiveUpdaterView(prev: SeenUpdaterView | undefined, next: UpdaterView, now = Date.now()): SeenUpdaterView {
  const m = next.updater?.selfReplace ?? null;
  if (next.reachable && m) {
    const seen = prev?.updater?.selfReplace?.runId === m.runId ? prev.restartUntil : undefined;
    const restartUntil = typeof m.ageMs === 'number' ? now + Math.max(0, SELF_REPLACE_STALE_MS - m.ageMs) : seen ?? now + SELF_REPLACE_STALE_MS;
    return { ...next, restartUntil };
  }
  if (next.reachable || !next.installed || !prev?.updater || prev.restartUntil === undefined || !restartingOn(prev, now)) return next;
  return { ...next, updater: prev.updater, restartUntil: prev.restartUntil };
}

export function useUpdater(enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: updaterKey,
    queryFn: async (): Promise<SeenUpdaterView> => receiveUpdaterView(queryClient.getQueryData<SeenUpdaterView>(updaterKey), await api.get<UpdaterView>('/updater')),
    enabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const run = query.state.data?.updater?.run;
      if (run?.status === 'running') return 2000;
      // Restarting itself: poll until it answers on the new version.
      if (restartingOn(query.state.data)) return 2000;
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
      queryClient.setQueryData<SeenUpdaterView>(updaterKey, (prev) =>
        prev?.updater ? { ...prev, updater: { ...prev.updater, run } } : prev);
      void queryClient.invalidateQueries({ queryKey: updaterKey });
    },
  });
}
