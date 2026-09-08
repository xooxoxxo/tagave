/**
 * Hook for tag plan wizard state management (XO-358)
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  TagPlan,
  TagPlanScope,
  TagPolicies,
  TagPlanItem,
  CreateTagPlan,
} from '@liner/shared';
import { api } from '../services/api';

export interface TagPlansResponse {
  items: TagPlan[];
  limit: number;
  offset: number;
  total: number;
}

export interface JobResponse {
  jobId: string;
  singletonKey: string;
  message: string;
}

export interface ApplyPlanResponse {
  jobId: string;
}

/**
 * Get all tag plans for a library (GET /libraries/:libraryId/tag-plans)
 */
export function useTagPlans(libraryId: string | undefined, opts?: { limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ['tag-plans', libraryId, opts?.limit, opts?.offset],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.limit) params.append('limit', opts.limit.toString());
      if (opts?.offset) params.append('offset', opts.offset.toString());
      const query = params.toString() ? `?${params.toString()}` : '';
      return api.get<TagPlansResponse>(`/libraries/${libraryId}/tag-plans${query}`);
    },
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}

/**
 * Get a single tag plan (GET /libraries/:libraryId/tag-plans/:planId)
 */
export function useTagPlan(libraryId: string | undefined, planId: string | undefined) {
  return useQuery({
    queryKey: ['tag-plan', libraryId, planId],
    queryFn: () => api.get<TagPlan>(`/libraries/${libraryId}/tag-plans/${planId}`),
    enabled: !!libraryId && !!planId,
  });
}

/**
 * Get preview items for a plan (GET /libraries/:libraryId/tag-plans/:planId/items)
 */
export function useTagPlanItems(
  libraryId: string | undefined,
  planId: string | undefined,
  opts?: { fieldFilter?: string; albumFilter?: string }
) {
  return useQuery({
    queryKey: ['tag-plan-items', libraryId, planId, opts],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.fieldFilter) params.append('field', opts.fieldFilter);
      if (opts?.albumFilter) params.append('album', opts.albumFilter);
      const query = params.toString() ? `?${params.toString()}` : '';
      return api.get<{ items: TagPlanItem[] }>(`/libraries/${libraryId}/tag-plans/${planId}/items${query}`);
    },
    enabled: !!libraryId && !!planId,
  });
}

/**
 * Create a draft tag plan (POST /libraries/:libraryId/tag-plans)
 */
export function useCreateTagPlan(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTagPlan) =>
      api.post<TagPlan>(`/libraries/${libraryId}/tag-plans`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
    },
  });
}

/**
 * Preview a tag plan (POST /libraries/:libraryId/tag-plans/:planId/preview)
 * Returns 202 with jobId, singletonKey, and message
 */
export function usePreviewTagPlan(libraryId: string | undefined, planId: string | undefined) {
  return useMutation({
    mutationFn: () => api.post<JobResponse>(`/libraries/${libraryId}/tag-plans/${planId}/preview`, {}),
  });
}

/**
 * Apply a tag plan (POST /libraries/:libraryId/tag-plans/:planId/apply)
 * Returns 202 with jobId, singletonKey, and message
 */
export function useApplyTagPlan(libraryId: string | undefined, planId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<JobResponse>(`/libraries/${libraryId}/tag-plans/${planId}/apply`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['tag-plan', libraryId, planId] });
    },
  });
}

/**
 * Pause a tag plan (POST /libraries/:libraryId/tag-plans/:planId/pause)
 */
export function usePauseTagPlan(libraryId: string | undefined, planId: string | undefined) {
  return useMutation({
    mutationFn: () =>
      api.post(`/libraries/${libraryId}/tag-plans/${planId}/pause`, {}),
  });
}

/**
 * Resume a tag plan (POST /libraries/:libraryId/tag-plans/:planId/resume)
 * Returns 202 with jobId, singletonKey, and message
 */
export function useResumeTagPlan(libraryId: string | undefined, planId: string | undefined) {
  return useMutation({
    mutationFn: () =>
      api.post<JobResponse>(`/libraries/${libraryId}/tag-plans/${planId}/resume`, {}),
  });
}

/**
 * Cancel a tag plan (POST /libraries/:libraryId/tag-plans/:planId/cancel)
 */
export function useCancelTagPlan(libraryId: string | undefined, planId: string | undefined) {
  return useMutation({
    mutationFn: () =>
      api.post(`/libraries/${libraryId}/tag-plans/${planId}/cancel`, {}),
  });
}

/**
 * Revert a tag plan (POST /libraries/:libraryId/tag-plans/:planId/revert)
 * Returns 202 with jobId, singletonKey, and message
 */
export function useRevertTagPlan(libraryId: string | undefined, planId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<JobResponse>(`/libraries/${libraryId}/tag-plans/${planId}/revert`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['tag-plan', libraryId, planId] });
    },
  });
}

/**
 * Check if tag writes are enabled (GET /libraries/:libraryId/settings)
 */
export function useLibrarySettings(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['library-settings', libraryId],
    queryFn: () =>
      api.get<{
        tagWritesEnabled: boolean;
        tagPolicy?: TagPolicies;
        scanRoots: Array<{ id: string; displayName: string; writable: boolean }>;
      }>(`/libraries/${libraryId}/settings`),
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}
