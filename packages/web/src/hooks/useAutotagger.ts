/**
 * The autotagger module (api › routes/autotagger.ts): Settings › Modules ›
 * Autotagger, and Library care › Autotagger (runs, spot checks, accepting a
 * band). Editors read runs, bands and spot checks and give verdicts; the
 * owner (system.manage) starts, resumes and cancels runs, trains the local
 * model, sees the payload and accepts a band.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcceptPreview, AgreementView, AutotaggerConfigPatch, AutotaggerLibraryView, AutotaggerModuleView, BandId, BandRow, DeciderPrice, LocalModelsView,
  PayloadPreview, RunView, SpotCheckItem, StartRun,
} from '@tagave/shared';
import { api } from '../services/api';
import { facetsKey } from './useFacets';
import { batchesKey } from './useBatches';

export const autotaggerModuleKey = ['autotagger-module'] as const;
export const autotaggerKey = (libraryId: string | undefined) => ['autotagger', libraryId] as const;
const lib = (libraryId: string | undefined) => `/libraries/${libraryId}/autotagger`;

/** A run still deciding: polled while it is. */
export const runIsActive = (run: Pick<RunView, 'state'> | null | undefined) => run?.state === 'queued' || run?.state === 'running';

/* ---------- the module (GET /settings/autotagger): its Modules row, run stats, prices ---------- */

export function useAutotaggerModule(enabled = true) {
  return useQuery({ queryKey: autotaggerModuleKey, queryFn: () => api.get<AutotaggerModuleView>('/settings/autotagger'), enabled, retry: false });
}

function useAfterModule() {
  const client = useQueryClient();
  return (view: AutotaggerModuleView) => {
    client.setQueryData(autotaggerModuleKey, view);
    void client.invalidateQueries({ queryKey: facetsKey });
    void client.invalidateQueries({ queryKey: ['autotagger'] });
  };
}

export function useSetAutotaggerModule() {
  const after = useAfterModule();
  return useMutation({ mutationFn: (enabled: boolean) => api.put<AutotaggerModuleView>('/settings/autotagger', { enabled }), onSuccess: after });
}

export function useRemoveAutotaggerData() {
  const after = useAfterModule();
  return useMutation({ mutationFn: () => api.post<AutotaggerModuleView>('/settings/autotagger/remove-data'), onSuccess: after });
}

export function useSetDeciderPrice() {
  const after = useAfterModule();
  return useMutation({ mutationFn: (price: DeciderPrice) => api.put<AutotaggerModuleView>('/settings/autotagger/prices', price), onSuccess: after });
}

export function useDeleteDeciderPrice() {
  const after = useAfterModule();
  return useMutation({ mutationFn: (model: string) => api.delete<AutotaggerModuleView>(`/settings/autotagger/prices/${encodeURIComponent(model)}`), onSuccess: after });
}

/* ---------- one library's settings ---------- */

export function useAutotaggerLibrary(libraryId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'settings'],
    queryFn: () => api.get<AutotaggerLibraryView>(lib(libraryId)),
    enabled: !!libraryId && enabled,
    retry: false,
  });
}

function useSetLibraryView(libraryId: string | undefined) {
  const client = useQueryClient();
  return (view: AutotaggerLibraryView) => client.setQueryData([...autotaggerKey(libraryId), 'settings'], view);
}

export function usePatchAutotaggerConfig(libraryId: string | undefined) {
  const set = useSetLibraryView(libraryId);
  return useMutation({ mutationFn: (patch: AutotaggerConfigPatch) => api.patch<AutotaggerLibraryView>(`${lib(libraryId)}/config`, patch), onSuccess: set });
}

/** The TypeSafe key, or null to forget it (fresh step-up). */
export function useSetAutotaggerKey(libraryId: string | undefined) {
  const set = useSetLibraryView(libraryId);
  return useMutation({ mutationFn: (key: string | null) => api.put<AutotaggerLibraryView>(`${lib(libraryId)}/key`, { key }), onSuccess: set });
}

export function usePayloadPreview(libraryId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'preview'],
    queryFn: () => api.get<PayloadPreview>(`${lib(libraryId)}/preview`),
    enabled: !!libraryId && enabled,
    retry: false,
  });
}

export function useMarkPayloadSeen(libraryId: string | undefined) {
  const set = useSetLibraryView(libraryId);
  return useMutation({ mutationFn: () => api.post<AutotaggerLibraryView>(`${lib(libraryId)}/preview/seen`), onSuccess: set });
}

export function useAgreement(libraryId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'agreement'],
    queryFn: () => api.get<AgreementView>(`${lib(libraryId)}/agreement`),
    enabled: !!libraryId && enabled,
    retry: false,
  });
}

/* ---------- the local decider ---------- */

export function useLocalModels(libraryId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'models'],
    queryFn: () => api.get<LocalModelsView>(`${lib(libraryId)}/models`),
    enabled: !!libraryId && enabled,
    retry: false,
  });
}

export function useTrainLocal(libraryId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ queued: boolean }>(`${lib(libraryId)}/train`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: [...autotaggerKey(libraryId), 'models'] }); },
  });
}

/* ---------- runs ---------- */

export function useRuns(libraryId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'runs'],
    queryFn: () => api.get<{ items: RunView[] }>(`${lib(libraryId)}/runs`),
    enabled: !!libraryId && enabled,
    retry: false,
    // a run deciding: its counts and spend move
    refetchInterval: (q) => (q.state.data?.items.some(runIsActive) ? 3000 : false),
  });
}

function useAfterRun(libraryId: string | undefined) {
  const client = useQueryClient();
  return () => { void client.invalidateQueries({ queryKey: autotaggerKey(libraryId) }); };
}

export function useStartRun(libraryId: string | undefined) {
  const after = useAfterRun(libraryId);
  return useMutation({ mutationFn: (body: StartRun) => api.post<RunView>(`${lib(libraryId)}/runs`, body), onSuccess: after });
}

export function useResumeRun(libraryId: string | undefined) {
  const after = useAfterRun(libraryId);
  return useMutation({ mutationFn: (runId: string) => api.post<RunView>(`${lib(libraryId)}/runs/${runId}/resume`), onSuccess: after });
}

export function useCancelRun(libraryId: string | undefined) {
  const after = useAfterRun(libraryId);
  return useMutation({ mutationFn: (runId: string) => api.post<RunView>(`${lib(libraryId)}/runs/${runId}/cancel`), onSuccess: after });
}

/* ---------- spot checks ---------- */

export function useBands(libraryId: string | undefined, runId: string | null) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'bands', runId],
    queryFn: () => api.get<BandRow[]>(`${lib(libraryId)}/runs/${runId}/bands`),
    enabled: !!libraryId && !!runId,
    retry: false,
  });
}

/** The band's pending checks, in draw order: the first is the one on the card. */
export function useSpotChecks(libraryId: string | undefined, runId: string | null, band: BandId) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'checks', runId, band],
    queryFn: () => api.get<SpotCheckItem[]>(`${lib(libraryId)}/runs/${runId}/spot-checks?band=${band}&verdict=pending&limit=25`),
    enabled: !!libraryId && !!runId,
    retry: false,
  });
}

export function useDrawSpotChecks(libraryId: string | undefined, runId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { band: BandId; count: number }) => api.post<{ drawn: number }>(`${lib(libraryId)}/runs/${runId}/spot-checks/draw`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [...autotaggerKey(libraryId), 'bands', runId] });
      void client.invalidateQueries({ queryKey: [...autotaggerKey(libraryId), 'checks', runId] });
    },
  });
}

export function useSpotCheckVerdict(libraryId: string | undefined, runId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ checkId, verdict }: { checkId: string; band: BandId; verdict: 'correct' | 'wrong' | 'unsure' }) =>
      api.put<void>(`${lib(libraryId)}/spot-checks/${checkId}`, { verdict }),
    onSuccess: (_v, { band }) => {
      void client.invalidateQueries({ queryKey: [...autotaggerKey(libraryId), 'bands', runId] });
      void client.invalidateQueries({ queryKey: [...autotaggerKey(libraryId), 'checks', runId, band] });
    },
  });
}

/* ---------- accepting a band ---------- */

export function useAcceptPreview(libraryId: string | undefined, runId: string | null, band: BandId | null) {
  return useQuery({
    queryKey: [...autotaggerKey(libraryId), 'accept-preview', runId, band],
    queryFn: () => api.get<AcceptPreview>(`${lib(libraryId)}/runs/${runId}/accept-preview?band=${band}`),
    enabled: !!libraryId && !!runId && !!band,
    retry: false,
  });
}

export function useAcceptBand(libraryId: string | undefined, runId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (band: BandId) => api.post<{ batchId: string | null; albums: number }>(`${lib(libraryId)}/runs/${runId}/accept`, { band }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: autotaggerKey(libraryId) });
      void client.invalidateQueries({ queryKey: batchesKey(libraryId) });
    },
  });
}
