/**
 * Settings › Modules. The updater holds a module run like an update, so the
 * page polls: every two seconds while one runs (the app restarts during a
 * run that changes its settings, so a failed poll keeps the last answer),
 * every minute otherwise.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModuleRun, ModulesView } from '@tagave/shared';
import { api } from '../services/api';

export const modulesKey = ['modules'] as const;

export function useModules(enabled = true) {
  return useQuery({
    queryKey: modulesKey,
    queryFn: () => api.get<ModulesView>('/modules'),
    enabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      if (query.state.data?.run?.status === 'running') return 2000;
      if (query.state.error && query.state.data?.run) return 2000;
      return 60_000;
    },
  });
}

export function useModuleAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, deleteData, deleteHistory }: { id: string; action: 'enable' | 'disable'; deleteData?: boolean; deleteHistory?: boolean }) =>
      api.post<{ run: ModuleRun }>(`/modules/${id}/${action}`, action === 'disable' ? { deleteData: !!deleteData, ...(deleteData && deleteHistory ? { deleteHistory: true } : {}) } : {}),
    onSuccess: ({ run }) => {
      queryClient.setQueryData<ModulesView>(modulesKey, (prev) => (prev ? {
        ...prev,
        run,
        modules: prev.modules.map((m) => (m.id === run.module ? { ...m, state: run.action === 'enable' ? 'installing' : 'removing' } : m)),
      } : prev));
      void queryClient.invalidateQueries({ queryKey: modulesKey });
    },
  });
}
