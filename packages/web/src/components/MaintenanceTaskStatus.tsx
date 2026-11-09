import type { MaintenanceTaskView } from '@tagave/shared';
import { useMaintenanceAction } from '../hooks/useMaintenance';
import { Button, confirmDialog } from './ui';

const actionLabel = { retry: 'Retry', continue: 'Continue', cancel: 'Cancel', 'restore-original': 'Restore original' };
const stateLabel: Record<MaintenanceTaskView['state'], string> = {
  waiting: 'Waiting', running: 'Running', interrupted: 'Stopped',
  review: 'Needs review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

export function MaintenanceTaskStatus({ libraryId, task, showStage = true }: {
  libraryId: string; task: MaintenanceTaskView; showStage?: boolean;
}) {
  const change = useMaintenanceAction(libraryId);
  const act = async (action: MaintenanceTaskView['actions'][number]) => {
    if (action === 'restore-original' && !await confirmDialog({
      title: 'Restore the original album?',
      message: 'tagave will put back the original files and remove the FLAC copies published by this upgrade.',
      confirmLabel: 'Restore original',
    })) return;
    change.mutate({ id: task.id, action });
  };
  return (
    <div>
      {showStage && <p role="status">
        {task.cancelRequested && task.state === 'running' ? 'Stopping after this file' : task.stage || stateLabel[task.state]}
        {task.progress?.total ? ` · ${task.progress.done} of ${task.progress.total}` : ''}
      </p>}
      {task.error && <p>{task.error}</p>}
      {task.actions.map((action) => (
        <Button key={action} type="button" variant="quiet" size="sm" disabled={change.isPending}
          onClick={() => void act(action)}>{actionLabel[action]}</Button>
      ))}
      {change.isError && <p role="alert">Couldn’t update the task. Try again.</p>}
    </div>
  );
}
