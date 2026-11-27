import { PAUSED_OFFLINE_STAGE, type MaintenanceTaskView } from '@tagave/shared';
import { useMaintenanceAction } from '../hooks/useMaintenance';
import { PAUSED_OFFLINE_HELP } from '../utils/offlinePaused';
import { Button, HelpToggle, confirmDialog } from './ui';
import styles from './MaintenanceTaskStatus.module.css';

const actionLabel = { retry: 'Retry', continue: 'Continue', cancel: 'Cancel', 'restore-original': 'Restore original' };
const stateLabel: Record<MaintenanceTaskView['state'], string> = {
  waiting: 'Waiting', running: 'Running', interrupted: 'Stopped',
  review: 'Needs review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};
type Action = MaintenanceTaskView['actions'][number];

/**
 * A task's line and its actions. Paused while its music folder is offline:
 * the line says so with its help behind "?", and Continue stays off while
 * the folder is still away (waitsForFolder; the API refuses it too).
 */
export function MaintenanceTaskStatusView({ task, showStage = true, pending, failed, onAction }: {
  task: MaintenanceTaskView; showStage?: boolean; pending: boolean; failed: boolean; onAction: (action: Action) => void;
}) {
  const line = `${task.cancelRequested && task.state === 'running' ? 'Stopping after this file' : task.stage || stateLabel[task.state]}${task.progress?.total ? ` · ${task.progress.done} of ${task.progress.total}` : ''}`;
  const paused = task.stage === PAUSED_OFFLINE_STAGE;
  return (
    <div>
      {showStage && (paused
        ? <div className={styles.stage} role="status"><span>{line}</span><HelpToggle label={PAUSED_OFFLINE_STAGE}>{PAUSED_OFFLINE_HELP}</HelpToggle></div>
        : <p role="status">{line}</p>)}
      {task.error && task.error !== task.stage && <p>{task.error}</p>}
      {task.actions.map((action) => (
        <Button key={action} type="button" variant="quiet" size="sm" disabled={pending || (action === 'continue' && !!task.waitsForFolder)}
          onClick={() => onAction(action)}>{actionLabel[action]}</Button>
      ))}
      {failed && <p role="alert">Couldn’t update the task. Try again.</p>}
    </div>
  );
}

export function MaintenanceTaskStatus({ libraryId, task, showStage = true }: {
  libraryId: string; task: MaintenanceTaskView; showStage?: boolean;
}) {
  const change = useMaintenanceAction(libraryId);
  const act = async (action: Action) => {
    if (action === 'restore-original' && !await confirmDialog({
      title: 'Restore the original album?',
      message: 'tagave will put back the original files and remove the FLAC copies published by this upgrade.',
      confirmLabel: 'Restore original',
    })) return;
    change.mutate({ id: task.id, action });
  };
  return <MaintenanceTaskStatusView task={task} showStage={showStage} pending={change.isPending} failed={change.isError} onAction={(a) => void act(a)} />;
}
