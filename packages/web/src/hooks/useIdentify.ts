/**
 * Hooks for identify pipeline (XO-309)
 */
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobsListResponse } from '@liner/shared';
import { api } from '../services/api';

export interface IdentifyStatsResponse {
  total: number;
  states: {
    matched: number;
    needsReview: number;
    pending: number;
    unidentified: number;
  };
  identifiedShare: number;
  target: {
    share: number;
    day: number;
    days: number;
    deadline: string;
    daysLeft: number;
    needed: number;
    requiredPerDay: number;
    matched24h: number;
    onTrack: boolean;
  };
  queue: {
    queued: number;
    active: number;
    retry: number;
    failed: number;
  };
  /** scan.parse and cluster.dir jobs still queued or running: files found but not grouped into albums yet (absent on an older API) */
  grouping?: number;
  rate: {
    perMin: number;
    perHour: number;
  };
  etaSeconds: number | null;
  reasons: Record<string, number>;
  /** live matches by provenance: mbid | mb_search | discogs_search | user_mbid | user_discogs | unknown (absent on an older API) */
  sources?: Record<string, number>;
  /** albums whose tags name a MusicBrainz release, and how they fared (absent on an older API) */
  fastPath?: {
    eligible: number;
    viaMbid: number;
    viaOther: number;
    undecided: number;
    pending: number;
  };
  series: Array<{
    day: string;
    matched: number;
    cumulativeShare: number;
  }>;
  sweep: {
    id: string;
    state: string;
    progress: { done: number; total: number; etaS?: number; message?: string };
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
}

export interface TriageItem {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  trackCount: number;
  formats: string[];
  dirPath: string;
  state: string;
  reason: string;
  attempts: number;
  lastIdentifyAt: string | null;
  error: string | null;
  best: {
    title: string;
    year: number | null;
    distance: number;
    source: string;
  } | null;
}

export interface TriageResponse {
  items: TriageItem[];
  total?: number;
  limit: number;
  offset: number;
}

export type { JobView as JobInfo, JobsListResponse as JobsResponse } from '@liner/shared';

/**
 * Identify stats with 30s refetch (G1 metrics, queue depth, rate, ETA, series, sweep status)
 */
export function useIdentifyStats(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['identify-stats', libraryId],
    queryFn: () => api.get<IdentifyStatsResponse>(`/libraries/${libraryId}/identify/stats`),
    enabled: !!libraryId,
    refetchInterval: 30_000,
  });
}

/**
 * Triage items (unidentified albums by reason)
 */
export function useIdentifyTriage(
  libraryId: string | undefined,
  opts?: { reason?: string | undefined; q?: string | undefined; limit?: number | undefined; offset?: number | undefined }
) {
  return useQuery({
    queryKey: ['identify-triage', libraryId, opts],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.reason) params.append('reason', opts.reason);
      if (opts?.q) params.append('q', opts.q);
      if (opts?.limit) params.append('limit', String(opts.limit));
      if (opts?.offset) params.append('offset', String(opts.offset));
      const query = params.toString() ? `?${params.toString()}` : '';
      return api.get<TriageResponse>(`/libraries/${libraryId}/identify/triage${query}`);
    },
    enabled: !!libraryId,
  });
}

/**
 * Retry identification (mutation; invalidates stats, triage, queue, library-stats)
 */
export function useRetryIdentify(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { albumIds?: string[] } | { reason: string }) =>
      api.post(`/libraries/${libraryId}/identify/retry`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['identify-stats', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['identify-triage', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['queue', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['library-stats', libraryId] });
    },
  });
}

/**
 * Kick the sweep top-up now
 */
export function useKickSweep(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/identify/sweep`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['identify-stats', libraryId] });
    },
  });
}

/**
 * Background activity (GET /jobs, refetch 15 s): plain-words job views plus
 * a summary. Tasks that need the owner always come back in full (`attention`);
 * the rest is the first `limit` entries. Routine checks are left out unless
 * asked for; `job` makes sure a deep-linked job is in the list.
 */
export function useJobs(
  libraryId: string | undefined,
  opts: { includeRoutine?: boolean; job?: string | undefined; limit?: number } = {},
) {
  const limit = opts.limit ?? 100;
  const params = new URLSearchParams({ limit: String(limit), offset: '0' });
  if (opts.includeRoutine) params.set('include', 'routine');
  if (opts.job) params.set('job', opts.job);
  return useQuery({
    queryKey: ['jobs', libraryId, !!opts.includeRoutine, opts.job ?? null, limit],
    queryFn: () => api.get<JobsListResponse>(`/libraries/${libraryId}/jobs?${params.toString()}`),
    enabled: !!libraryId,
    // keep the list on screen while "Show more" or the routine toggle loads
    placeholderData: (prev) => prev,
    refetchInterval: 15_000,
  });
}

interface QueueChangedEvent {
  type: string;
  libraryId: string;
  localAlbumId: string;
  state: string;
}

interface JobProgressEvent {
  type: string;
  jobRunId: string;
  libraryId: string;
  jobType: string;
  state: string;
  progress: { done: number; total: number; etaS?: number; message?: string };
}

/**
 * Mount SSE listener for job events and queue changes.
 * Opens ONE EventSource per libraryId, debounces invalidations by 1.5 s.
 * Mount once in Layout via useCurrentLibrary guard.
 */
export function useJobEvents(libraryId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!libraryId) return;

    const eventSource = new EventSource(`/api/v1/libraries/${libraryId}/jobs/stream`, {
      withCredentials: true,
    });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const invalidate = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['identify-stats', libraryId] });
        queryClient.invalidateQueries({ queryKey: ['identify-triage', libraryId] });
        queryClient.invalidateQueries({ queryKey: ['identify-requests', libraryId] });
        queryClient.invalidateQueries({ queryKey: ['queue', libraryId] });
        queryClient.invalidateQueries({ queryKey: ['jobs', libraryId] });
        queryClient.invalidateQueries({ queryKey: ['library-stats', libraryId] });
      }, 1500);
    };

    eventSource.addEventListener('queue.changed', (e) => {
      try {
        const event: QueueChangedEvent = JSON.parse(e.data);
        if (event.libraryId === libraryId) {
          // the album page shows its pending request; refresh just that album
          if (event.localAlbumId) queryClient.invalidateQueries({ queryKey: ['album', event.localAlbumId] });
          invalidate();
        }
      } catch {
        // ignore parse errors
      }
    });

    eventSource.addEventListener('job.progress', (e) => {
      try {
        const event: JobProgressEvent = JSON.parse(e.data);
        if (event.libraryId === libraryId) {
          invalidate();
        }
      } catch {
        // ignore parse errors
      }
    });

    eventSource.addEventListener('job.completed', (e) => {
      try {
        const event: JobProgressEvent = JSON.parse(e.data);
        if (event.libraryId === libraryId) {
          invalidate();
        }
      } catch {
        // ignore parse errors
      }
    });

    eventSource.addEventListener('job.failed', (e) => {
      try {
        const event: JobProgressEvent = JSON.parse(e.data);
        if (event.libraryId === libraryId) {
          invalidate();
        }
      } catch {
        // ignore parse errors
      }
    });

    return () => {
      eventSource.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [libraryId, queryClient]);
}

/** One live identify.album job for an album (manual pin, re-identify, or the sweep's own). */
export interface PendingIdentify {
  id: string;
  state: 'created' | 'retry' | 'active';
  kind: 'mbid' | 'discogs' | 'reidentify' | 'sweep';
  pinned: string | null;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  jobsAhead: number;
}

export interface PendingIdentifyRequest extends PendingIdentify {
  album: { id: string; title: string | null; artist: string | null; state: string };
}

/** Owner-initiated identification requests still waiting (GET /identify/requests, 15 s refetch + SSE). */
export function useIdentifyRequests(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['identify-requests', libraryId],
    queryFn: () => api.get<{ items: PendingIdentifyRequest[] }>(`/libraries/${libraryId}/identify/requests`),
    enabled: !!libraryId,
    refetchInterval: 15_000,
  });
}

/** Cancel the queued request of one album; invalidates the album, the requests list and the stats. */
export function useCancelIdentifyRequest(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (albumId: string) => api.post(`/libraries/${libraryId}/identify/requests/${albumId}/cancel`, {}),
    onSuccess: (_data, albumId) => {
      queryClient.invalidateQueries({ queryKey: ['identify-requests', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['identify-stats', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['album', albumId] });
    },
  });
}

/** Start a failed or interrupted job's work again (POST /jobs/:id/retry). */
export function useRetryJob(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      api.post<{ queued: boolean; jobId: string | null }>(`/libraries/${libraryId}/jobs/${jobId}/retry`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['identify-stats', libraryId] });
    },
  });
}
