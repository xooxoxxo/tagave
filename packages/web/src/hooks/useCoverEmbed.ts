import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MaintenanceTaskView } from '@tagave/shared';
import { api } from '../services/api';
import { invalidateAlbumCare } from './useGaps';
import { maintenanceLive } from './useMaintenance';

type EmbedView = { task: MaintenanceTaskView | null };

export function useCoverEmbed(libraryId: string | undefined, albumId: string, enabled: boolean) {
  const qc = useQueryClient();
  const key = ['embed-cover', libraryId, albumId] as const;
  const path = `/libraries/${libraryId}/albums/${albumId}/embed-cover`;
  const view = useQuery({
    queryKey: key,
    queryFn: () => api.get<EmbedView>(path),
    enabled: enabled && !!libraryId && !!albumId,
    refetchInterval: ({ state }) => {
      const task = state.data?.task;
      return task && (maintenanceLive(task) || !task.workerAvailable) ? 2500 : false;
    },
  });
  const start = useMutation({
    mutationFn: () => api.post<EmbedView>(path, {}),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
  const task = view.data?.task;
  useEffect(() => {
    if (task?.state === 'done') void invalidateAlbumCare(qc);
  }, [task?.state, task?.id, qc]);
  return { view, start };
}
