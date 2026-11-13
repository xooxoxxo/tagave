import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FlacUpgradeView, MaintenanceTaskView } from '@tagave/shared';
import { api } from '../services/api';

export function useFlacUpgrade(libraryId: string | undefined, albumId: string, owner: boolean) {
  const qc = useQueryClient();
  const key = ['flac-upgrade', libraryId, albumId];
  const route = `/libraries/${libraryId}/albums/${albumId}/flac-upgrade`;
  const view = useQuery({
    queryKey: key,
    queryFn: () => api.get<FlacUpgradeView>(route),
    enabled: !!libraryId && !!albumId && owner,
    refetchInterval: (query) => {
      const task = query.state.data?.task;
      if (!task || task.state === 'done' || task.state === 'cancelled') return false;
      return task.workerAvailable && task.state === 'running' ? 2500 : 8000;
    },
  });
  const request = useMutation({
    mutationFn: () => api.post<MaintenanceTaskView>(route, {}),
    onSuccess: (task) => {
      qc.setQueryData<FlacUpgradeView>(key, { eligible: false, task });
      void qc.invalidateQueries({ queryKey: ['maintenance-tasks', libraryId] });
    },
  });
  return { view, request };
}
