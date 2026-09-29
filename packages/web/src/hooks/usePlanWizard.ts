/**
 * Hook for tag plan wizard state management (XO-358)
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  TagPlan,
  TagPlanPreviewJob,
  TagPolicies,
  TagPlanItem,
  CreateTagPlan,
  TagPlanResults,
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
/** Item counts by status, from GET /tag-plans/:id — drives the apply progress bar. */
export interface PlanProgress {
  pending: number;
  applying: number;
  applied: number;
  failed: number;
  skipped: number;
  reverted: number;
  total: number;
}

export type TagPlanDetail = TagPlan & { progress?: PlanProgress; previewJob?: TagPlanPreviewJob };

export function useTagPlan(
  libraryId: string | undefined,
  planId: string | undefined,
  opts?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['tag-plan', libraryId, planId],
    queryFn: () => api.get<TagPlanDetail>(`/libraries/${libraryId}/tag-plans/${planId}`),
    enabled: !!libraryId && !!planId,
    refetchInterval: opts?.refetchInterval ?? false,
  });
}

/**
 * A plan the worker is about to create (the revert of an applied plan):
 * polls until it exists, then returns it. A 404 is "not yet", not an error.
 */
export function usePlanAppears(libraryId: string | undefined, planId: string | null) {
  return useQuery({
    queryKey: ['tag-plan-appears', libraryId, planId],
    queryFn: async () => {
      try {
        return await api.get<TagPlanDetail>(`/libraries/${libraryId}/tag-plans/${planId}`);
      } catch {
        return null;
      }
    },
    enabled: !!libraryId && !!planId,
    retry: false,
    refetchInterval: (q) => (q.state.data ? false : 1500),
  });
}

export interface TagPlanItemsPage {
  items: TagPlanItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Preview items for a plan, one page at a time
 * (GET /libraries/:libraryId/tag-plans/:planId/items?field=&album=&limit=&offset=)
 */
export function useTagPlanItems(
  libraryId: string | undefined,
  planId: string | undefined,
  opts?: { fieldFilter?: string; albumFilter?: string; statusFilter?: string; limit?: number; offset?: number; enabled?: boolean; refetchInterval?: number | false }
) {
  return useQuery({
    queryKey: ['tag-plan-items', libraryId, planId, opts?.fieldFilter ?? '', opts?.albumFilter ?? '', opts?.statusFilter ?? '', opts?.limit ?? 100, opts?.offset ?? 0],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.fieldFilter) params.append('field', opts.fieldFilter);
      if (opts?.albumFilter) params.append('album', opts.albumFilter);
      if (opts?.statusFilter) params.append('status', opts.statusFilter);
      params.append('limit', String(opts?.limit ?? 100));
      params.append('offset', String(opts?.offset ?? 0));
      return api.get<TagPlanItemsPage>(`/libraries/${libraryId}/tag-plans/${planId}/items?${params.toString()}`);
    },
    enabled: !!libraryId && !!planId && (opts?.enabled ?? true),
    refetchInterval: opts?.refetchInterval ?? false,
    placeholderData: (prev) => prev,
  });
}

/** Aggregated changes: files per (field, reason), and files per write status. */
export interface TagPlanSummary {
  fields: Array<{ field: string; reason: string; files: number }>;
  statuses: Record<string, number>;
}

export function useTagPlanSummary(
  libraryId: string | undefined,
  planId: string | undefined,
  opts?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['tag-plan-summary', libraryId, planId],
    queryFn: () => api.get<TagPlanSummary>(`/libraries/${libraryId}/tag-plans/${planId}/summary`),
    enabled: !!libraryId && !!planId && (opts?.enabled ?? true),
    refetchInterval: opts?.refetchInterval ?? false,
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
  const queryClient = useQueryClient();
  return useMutation(previewTagPlanOptions(queryClient, libraryId, planId));
}

/**
 * Options behind usePreviewTagPlan. A re-preview moves a previewed plan back
 * to draft and drops its items on the server, so the cached plan, its items
 * and its summary are stale the moment the 202 arrives: refetch them rather
 * than keep showing the old diff with Apply enabled.
 */
export function previewTagPlanOptions(
  queryClient: Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>,
  libraryId: string | undefined,
  planId: string | undefined,
) {
  return {
    mutationFn: () => api.post<JobResponse>(`/libraries/${libraryId}/tag-plans/${planId}/preview`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
      void queryClient.invalidateQueries({ queryKey: ['tag-plan', libraryId, planId] });
      void queryClient.invalidateQueries({ queryKey: ['tag-plan-items', libraryId, planId] });
      void queryClient.invalidateQueries({ queryKey: ['tag-plan-summary', libraryId, planId] });
    },
  };
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
export interface RevertPlanResponse {
  jobId: string | null;
  /** the plan the worker builds from the journal; open it once it exists */
  revertPlanId: string | null;
  message: string;
}

export function useRevertTagPlan(libraryId: string | undefined, planId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RevertPlanResponse>(`/libraries/${libraryId}/tag-plans/${planId}/revert`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['tag-plan', libraryId, planId] });
    },
  });
}

/**
 * Delete a tag plan (DELETE /libraries/:libraryId/tag-plans/:planId)
 */
export function useDeleteTagPlan(libraryId: string | undefined, planId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete(`/libraries/${libraryId}/tag-plans/${planId}`),
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
      }>(`/libraries/${libraryId}/settings`),
    enabled: !!libraryId,
    staleTime: 1000 * 60, // 1 minute
  });
}

/** How many open plans the wizard lists; the rest are counted, not shown. */
export const OPEN_PLANS_LIMIT = 200;

/**
 * Plans an album can still be added to: not applied yet and scoped to a list
 * of albums (GET /tag-plans?acceptsAlbums=true), newest first.
 */
export function useOpenTagPlans(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['tag-plans', libraryId, 'accepts-albums'],
    queryFn: () =>
      api.get<TagPlansResponse>(`/libraries/${libraryId}/tag-plans?acceptsAlbums=true&limit=${OPEN_PLANS_LIMIT}`),
    enabled: !!libraryId,
  });
}

export interface AddToTagPlanResponse {
  planId: string;
  added: number;
  albumCount: number;
  status: string;
  previewQueued: boolean;
}

/** The plan page's once-per-plan auto-preview guard (see PlanPage). */
export const previewGuardKey = (planId: string) => `tagave:previewed:${planId}`;

/**
 * Add albums to a plan that has not been applied yet
 * (POST /libraries/:libraryId/tag-plans/:planId/add-items). The server puts
 * the plan back to draft and queues a fresh preview; clearing the plan page's
 * guard lets that page follow the new preview instead of showing the old one.
 */
export function useAddToTagPlan(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, albumIds }: { planId: string; albumIds: string[] }) =>
      api.post<AddToTagPlanResponse>(`/libraries/${libraryId}/tag-plans/${planId}/add-items`, {
        scope: { type: 'albumIds', albumIds },
      }),
    onSuccess: (_data, { planId }) => {
      try { sessionStorage.removeItem(previewGuardKey(planId)); } catch { /* storage blocked: nothing to clear */ }
      void queryClient.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
      void queryClient.invalidateQueries({ queryKey: ['tag-plan', libraryId, planId] });
      void queryClient.invalidateQueries({ queryKey: ['tag-plan-items', libraryId, planId] });
      void queryClient.invalidateQueries({ queryKey: ['tag-plan-summary', libraryId, planId] });
    },
  });
}

/**
 * Rename a plan (PATCH /libraries/:libraryId/tag-plans/:planId). The server
 * trims the name and refuses a blank one; a name set here is never
 * rewritten automatically afterwards.
 */
export function useRenameTagPlan(libraryId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, name }: { planId: string; name: string }) =>
      api.patch<{ id: string; name: string; nameByUser: boolean }>(`/libraries/${libraryId}/tag-plans/${planId}`, { name }),
    onSuccess: (data, { planId }) => {
      queryClient.setQueryData<TagPlanDetail | undefined>(['tag-plan', libraryId, planId], (prev) =>
        prev ? { ...prev, name: data.name, nameByUser: true } : prev);
      void queryClient.invalidateQueries({ queryKey: ['tag-plans', libraryId] });
    },
  });
}

/**
 * What an applied plan left behind: the albums that hold its files now
 * (GET /tag-plans/:planId/results). Polls while the worker is still
 * re-clustering the plan's folders.
 */
export function useTagPlanResults(
  libraryId: string | undefined,
  planId: string | undefined,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['tag-plan-results', libraryId, planId],
    queryFn: () => api.get<TagPlanResults>(`/libraries/${libraryId}/tag-plans/${planId}/results`),
    enabled: !!libraryId && !!planId && (opts?.enabled ?? true),
    refetchInterval: (q) => (q.state.data?.updating ? 2500 : false),
  });
}
