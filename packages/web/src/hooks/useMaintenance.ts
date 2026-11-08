import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MaintenanceTaskView } from '@tagave/shared';
import { api } from '../services/api';

const key = (libraryId: string | undefined) => ['maintenance-tasks', libraryId] as const;

export const maintenanceLive = (task: MaintenanceTaskView) => task.state === 'waiting' || task.state === 'running';

export function useMaintenanceTasks(libraryId: string | undefined) {
  return useQuery({
    queryKey: key(libraryId),
    queryFn: () => api.get<{ tasks: MaintenanceTaskView[] }>(`/libraries/${libraryId}/maintenance-tasks`),
    enabled: !!libraryId,
    // A heartbeat change can make a recovery action available even if no job ran.
    refetchInterval: (query) => query.state.data?.tasks.some((task) => maintenanceLive(task) || !task.workerAvailable) ? 2500 : 15_000,
  });
}

export function useMaintenanceAction(libraryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: MaintenanceTaskView['actions'][number] }) =>
      api.post<MaintenanceTaskView>(`/libraries/${libraryId}/maintenance-tasks/${id}/${action}`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(libraryId) });
      for (const k of ['album', 'album-split', 'tag-plan', 'deletions', 'flac-upgrade']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}
