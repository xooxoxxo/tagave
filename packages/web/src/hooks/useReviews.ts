/**
 * Reviews and listening hooks (spec REV-1..3). Everything is keyed by the
 * release group; mutations invalidate the bundle, the album grid (badges and
 * sorts) and the dashboard counters.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Clipping, CreateClipping, CreateListen, Listen, OwnReview, PutOwnReview, ReviewRevision, ReviewsBundle,
} from '@liner/shared';
import { api } from '../services/api';

const reviewsKey = (rgId: string | null | undefined) => ['reviews', rgId ?? ''] as const;
const base = (libraryId: string | undefined, rgId: string | null | undefined) =>
  `/libraries/${libraryId}/release-groups/${rgId}`;

/** Polls every 3 s while the first external fetch is in flight, for at most ~2 min. */
export function useReviews(libraryId: string | undefined, rgId: string | null | undefined) {
  return useQuery({
    queryKey: reviewsKey(rgId),
    queryFn: () => api.get<ReviewsBundle>(`${base(libraryId, rgId)}/reviews`),
    enabled: !!libraryId && !!rgId,
    refetchInterval: (query) => {
      const data = query.state.data as ReviewsBundle | undefined;
      if (!data?.gathering) return false;
      return query.state.dataUpdateCount > 40 ? false : 3000;
    },
  });
}

function useInvalidateReviews(rgId: string | null | undefined) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: reviewsKey(rgId) });
    queryClient.invalidateQueries({ queryKey: ['albums'] });
    queryClient.invalidateQueries({ queryKey: ['library-stats'] });
  };
}

export function useSaveReview(libraryId: string | undefined, rgId: string | null | undefined) {
  const invalidate = useInvalidateReviews(rgId);
  return useMutation({
    mutationFn: (body: PutOwnReview) => api.put<OwnReview>(`${base(libraryId, rgId)}/review`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteReview(libraryId: string | undefined, rgId: string | null | undefined) {
  const invalidate = useInvalidateReviews(rgId);
  return useMutation({
    mutationFn: () => api.delete<{ ok: boolean }>(`${base(libraryId, rgId)}/review`),
    onSuccess: invalidate,
  });
}

export function useReviewRevisions(libraryId: string | undefined, rgId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...reviewsKey(rgId), 'revisions'],
    queryFn: () => api.get<{ items: ReviewRevision[] }>(`${base(libraryId, rgId)}/review/revisions`).then((r) => r.items),
    enabled: enabled && !!libraryId && !!rgId,
  });
}

export function useAddListen(libraryId: string | undefined, rgId: string | null | undefined) {
  const invalidate = useInvalidateReviews(rgId);
  return useMutation({
    mutationFn: (body: CreateListen) => api.post<Listen>(`${base(libraryId, rgId)}/listens`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteListen(rgId: string | null | undefined) {
  const invalidate = useInvalidateReviews(rgId);
  return useMutation({
    mutationFn: (listenId: string) => api.delete<{ ok: boolean }>(`/listens/${listenId}`),
    onSuccess: invalidate,
  });
}

export function useAddClipping(libraryId: string | undefined, rgId: string | null | undefined) {
  const invalidate = useInvalidateReviews(rgId);
  return useMutation({
    mutationFn: (body: CreateClipping) => api.post<Clipping>(`${base(libraryId, rgId)}/clippings`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteClipping(rgId: string | null | undefined) {
  const invalidate = useInvalidateReviews(rgId);
  return useMutation({
    mutationFn: (clippingId: string) => api.delete<{ ok: boolean }>(`/clippings/${clippingId}`),
    onSuccess: invalidate,
  });
}

export function useRefreshReviews(libraryId: string | undefined, rgId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`${base(libraryId, rgId)}/reviews/refresh`),
    onSuccess: () => setTimeout(() => queryClient.invalidateQueries({ queryKey: reviewsKey(rgId) }), 8000),
  });
}
