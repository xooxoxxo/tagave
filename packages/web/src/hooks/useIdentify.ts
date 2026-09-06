/**
 * Hooks for identify pipeline (XO-309)
 */
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

export interface JobInfo {
  id: string;
  type: string;
  state: string;
  progress: { done: number; total: number; etaS?: number; message?: string };
  startedAt: string | undefined;
  finishedAt: string | undefined;
  error: string | null;
  createdAt: string;
}

export interface JobsResponse {
  data: JobInfo[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

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
 * Jobs list (GET /jobs, limit 50, refetch 15 s)
 */
export function useJobs(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['jobs', libraryId],
    queryFn: () => api.get<JobsResponse>(`/libraries/${libraryId}/jobs?limit=50&offset=0`),
    enabled: !!libraryId,
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
        queryClient.invalidateQueries({ queryKey: ['queue', libraryId] });
        queryClient.invalidateQueries({ queryKey: ['jobs', libraryId] });
        queryClient.invalidateQueries({ queryKey: ['library-stats', libraryId] });
      }, 1500);
    };

    eventSource.addEventListener('queue.changed', (e) => {
      try {
        const event: QueueChangedEvent = JSON.parse(e.data);
        if (event.libraryId === libraryId) {
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
