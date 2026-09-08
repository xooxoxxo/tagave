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
  data: TagPlan[];
}

export interface TagPlansPreviewResponse {
  items: TagPlanItem[];
  stats: {
    filesTouched: number;
    fieldsModified: number;
    lockedFieldsRespected: number;
    filesSkipped: Array<{
      audioFileId: string;
      reason: 'scan_root_not_writable' | 'audio_file_error';
      message?: string;
    }>;
  };
}

export interface ApplyPlanResponse {
  jobId: string;
}

export interface RevertPlanResponse {
  planId: string;
  jobId: string;
}

/**
 * Get all tag plans for a library (GET /libraries/:libraryId/tag-plans)
 */
export function useTagPlans(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['tag-plans', libraryId],
    queryFn: () => api.get<TagPlansResponse>(`/libraries/${libraryId}/tag-plans`),
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}

/**
 * Get a single tag plan (GET /tag-plans/:planId)
 */
export function useTagPlan(planId: string | undefined) {
  return useQuery({
    queryKey: ['tag-plan', planId],
    queryFn: () => api.get<TagPlan>(`/tag-plans/${planId}`),
    enabled: !!planId,
  });
}

/**
 * Get preview items for a plan (GET /tag-plans/:planId/items)
 */
export function useTagPlanItems(
  planId: string | undefined,
  opts?: { fieldFilter?: string; albumFilter?: string }
) {
  return useQuery({
    queryKey: ['tag-plan-items', planId, opts],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.fieldFilter) params.append('field', opts.fieldFilter);
      if (opts?.albumFilter) params.append('album', opts.albumFilter);
      const query = params.toString() ? `?${params.toString()}` : '';
      return api.get<{ items: TagPlanItem[] }>(`/tag-plans/${planId}/items${query}`);
    },
    enabled: !!planId,
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
 * Preview a tag plan (POST /tag-plans/:planId/preview)
 */
export function usePreviewTagPlan(planId: string | undefined) {
  return useMutation({
    mutationFn: () => api.post<TagPlansPreviewResponse>(`/tag-plans/${planId}/preview`, {}),
  });
}

/**
 * Apply a tag plan (POST /tag-plans/:planId/apply)
 */
export function useApplyTagPlan(planId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ApplyPlanResponse>(`/tag-plans/${planId}/apply`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-plans'] });
      queryClient.invalidateQueries({ queryKey: ['tag-plan', planId] });
    },
  });
}

/**
 * Pause a tag plan job (POST /tag-plans/:planId/pause)
 */
export function usePauseTagPlanJob(planId: string | undefined) {
  return useMutation({
    mutationFn: (jobId: string) =>
      api.post(`/tag-plans/${planId}/pause`, { jobId }),
  });
}

/**
 * Resume a tag plan job (POST /tag-plans/:planId/resume)
 */
export function useResumeTagPlanJob(planId: string | undefined) {
  return useMutation({
    mutationFn: (jobId: string) =>
      api.post(`/tag-plans/${planId}/resume`, { jobId }),
  });
}

/**
 * Cancel a tag plan job (POST /tag-plans/:planId/cancel)
 */
export function useCancelTagPlanJob(planId: string | undefined) {
  return useMutation({
    mutationFn: (jobId: string) =>
      api.post(`/tag-plans/${planId}/cancel`, { jobId }),
  });
}

/**
 * Revert a tag plan (POST /tag-plans/:planId/revert)
 */
export function useRevertTagPlan(planId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RevertPlanResponse>(`/tag-plans/${planId}/revert`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-plans'] });
      queryClient.invalidateQueries({ queryKey: ['tag-plan', planId] });
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
        scanRoots: Array<{ id: string; displayName: string; writable: boolean }>;
      }>(`/libraries/${libraryId}/settings`),
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}
