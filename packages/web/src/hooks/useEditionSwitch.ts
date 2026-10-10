/**
 * "Use this edition" on the album page's Editions tab (and a pick from a
 * release-group outcome). Switching edition is a manual identification
 * request: the POST queues an identify job on the worker and answers 202 with
 * the request as it now stands; the worker decides later.
 *
 * The page used to clear its "Queuing…" state the moment the POST answered,
 * before the album was read again: for a moment every button was live again
 * and the old edition still marked as the copy. And when the job ended only
 * the album was read again, never the editions list, so the "This copy" mark
 * stayed on the old edition until the next click refreshed everything.
 *
 * Now nothing on screen moves before the server says so:
 *   1. the clicked row's button spins and every other row's button is off,
 *      from the click until the album and the editions have both been read
 *      again (the mutation stays pending through those refetches);
 *   2. the request the POST returned is written into the album cache, so the
 *      "switching" state carries straight on while the job is queued/running;
 *   3. when the job ends, the editions are read again and the clicked row
 *      keeps spinning until that read lands, so the copy mark moves once;
 *   4. a second click while any of this is under way does nothing.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient, type MutationOptions, type QueryClient } from '@tanstack/react-query';
import type { IdentifyRequestView } from '@liner/shared';
import { api } from '../services/api';
import type { PendingIdentify } from './useIdentify';

export interface SwitchEditionResponse {
  ok: boolean;
  mbid?: string;
  jobId?: string | null;
  pending?: PendingIdentify | null;
  identifyRequest?: IdentifyRequestView | null;
}

/** the album detail fields this flow reads and writes */
interface AlbumRequestFields {
  pendingIdentify?: PendingIdentify | null;
  identifyRequest?: IdentifyRequestView | null;
}

export const albumQueryKey = (albumId: string) => ['album', albumId] as const;
export const editionsQueryKey = (libraryId: string | undefined, albumId: string) => ['albums', libraryId, 'editions', albumId] as const;

type Post = (path: string, body: unknown) => Promise<SwitchEditionResponse>;

/**
 * The mutation itself, without React: posts, writes the server's answer into
 * the album cache, then waits for the album and the editions to be read again
 * before it settles.
 */
export function switchEditionOptions(
  queryClient: QueryClient,
  libraryId: string | undefined,
  albumId: string,
  post: Post = (path, body) => api.post<SwitchEditionResponse>(path, body),
): MutationOptions<SwitchEditionResponse, unknown, string> {
  return {
    mutationKey: ['switch-edition', albumId],
    mutationFn: (mbid: string) => post(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, { input: mbid }),
    onSuccess: async (res) => {
      // the request as the server now holds it: the page shows "switching"
      // from this, not from a guess made on click
      if (res && (res.pending !== undefined || res.identifyRequest !== undefined)) {
        queryClient.setQueryData<AlbumRequestFields>(albumQueryKey(albumId), (old) => old && ({
          ...old,
          ...(res.pending !== undefined ? { pendingIdentify: res.pending } : {}),
          ...(res.identifyRequest !== undefined ? { identifyRequest: res.identifyRequest } : {}),
        }));
      }
      // the album grid and counts: stale, read again when next shown
      void queryClient.invalidateQueries({ queryKey: ['albums', libraryId], refetchType: 'none' });
      // returned, so the mutation stays pending until both reads are back
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: albumQueryKey(albumId) }),
        queryClient.invalidateQueries({ queryKey: editionsQueryKey(libraryId, albumId) }),
      ]);
    },
  };
}

/** Runs `fn` unless a previous call is still in flight; repeats are dropped, not queued. */
export function singleFlight<A>(fn: (arg: A, done: () => void) => void): (arg: A) => boolean {
  let busy = false;
  return (arg: A) => {
    if (busy) return false;
    busy = true;
    fn(arg, () => { busy = false; });
    return true;
  };
}

export interface EditionSwitch {
  /** start switching to this release; ignored while a switch is under way */
  switchTo: (mbid: string) => void;
  /** the release whose row shows the spinner (request, queued job, or the editions re-read after it) */
  busyMbid: string | null;
  /** a switch is under way: every other row's button is off */
  busy: boolean;
  /** why the last switch failed, shown on its row */
  error: string | null;
  /** the release the failed switch was for */
  errorMbid: string | null;
  /** the raw mutation, for callers that show its state elsewhere */
  isPending: boolean;
}

const errorText = (e: unknown): string | null =>
  e ? ((e as { detail?: string }).detail ?? (e as Error).message ?? 'Switching edition failed') : null;

/**
 * @param request the album's identification request as the page reads it
 *   (live while queued/running/retrying)
 */
export function useEditionSwitch(libraryId: string | undefined, albumId: string, request: { live: boolean; kind: string | null; pinned: string | null }): EditionSwitch {
  const queryClient = useQueryClient();
  const mutation = useMutation(switchEditionOptions(queryClient, libraryId, albumId));

  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;
  // one switch at a time, also across clicks that land before React re-renders
  const flight = useRef<((mbid: string) => boolean) | null>(null);
  flight.current ??= singleFlight<string>((mbid, done) => {
    mutationRef.current.mutate(mbid, { onSettled: done });
  });

  // the job ended: read the editions again, and keep the row spinning until
  // they are back so the copy mark moves in one step
  const liveMbid = request.live && request.kind === 'mbid' ? request.pinned : null;
  const lastLive = useRef<string | null>(liveMbid);
  const [settlingMbid, setSettlingMbid] = useState<string | null>(null);
  useEffect(() => {
    const was = lastLive.current;
    lastLive.current = liveMbid;
    if (!was || liveMbid) return;
    let cancelled = false;
    setSettlingMbid(was);
    void queryClient.invalidateQueries({ queryKey: ['albums', libraryId], refetchType: 'none' });
    void queryClient.invalidateQueries({ queryKey: editionsQueryKey(libraryId, albumId) }).finally(() => { if (!cancelled) setSettlingMbid(null); });
    return () => { cancelled = true; };
  }, [liveMbid, libraryId, albumId, queryClient]);

  const postingMbid = mutation.isPending ? mutation.variables ?? null : null;
  const busyMbid = postingMbid ?? liveMbid ?? settlingMbid;
  return {
    switchTo: (mbid) => { flight.current?.(mbid); },
    busyMbid,
    busy: !!busyMbid || mutation.isPending,
    error: mutation.isError ? errorText(mutation.error) : null,
    errorMbid: mutation.isError ? mutation.variables ?? null : null,
    isPending: mutation.isPending,
  };
}
