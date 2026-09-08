import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

export interface FingerprintStats {
  enabled: boolean;
  keySet: boolean;
  albums: {
    unidentified: number;
    remaining: number;
    lookedUp: number;
    withCandidates: number;
    noCandidates: number;
    noFingerprints: number;
    noKey: number;
    badKey: number;
    matchedViaAcoustid: number;
  };
  files: { fingerprinted: number; failed: number };
  queue: { fingerprintWaiting: number; lookupWaiting: number };
  lookups: { cached: number; last24h: number };
  /** set while AcoustID is parked (rejected key, quota); the sweep skips until then */
  provider: { parkedUntil: string; reason: string | null } | null;
}

export function useFingerprintStats(libraryId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['fingerprint-stats', libraryId],
    queryFn: () => api.get<FingerprintStats>(`/libraries/${libraryId}/identify/fingerprint-stats`),
    enabled: !!libraryId && enabled,
    refetchInterval: 15_000,
  });
}

/** Manual "Fingerprint" on an album: jumps the sweep; 409 without an AcoustID key. */
export function useFingerprintAlbum(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (albumId: string) => api.post<{ ok: boolean; queued: boolean }>(`/libraries/${libraryId}/albums/${albumId}/fingerprint`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fingerprint-stats', libraryId] });
    },
  });
}
