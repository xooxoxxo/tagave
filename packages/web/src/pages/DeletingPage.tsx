/**
 * Library care › Deleting (owner): what was deleted from tagave and how to
 * finish or undo it (vault "tagave - Deleting Songs and Albums").
 *
 *   Marked  the files are untouched: Unmark, or the command that deletes
 *           exactly those files on the computer that holds the music.
 *   Trash   in each music folder's .tagave-trash: Restore, Empty trash;
 *           deleted for real after 30 days.
 */
import { Link } from '@tanstack/react-router';
import type { DeletionGroup } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useDeletingView, useEmptyTrash, useRestore, useUnmark } from '../hooks/useDeletions';
import { Button, EmptyState, confirmDialog, showToast } from '../components/ui';
import { MaintenanceTaskStatus } from '../components/MaintenanceTaskStatus';
import styles from './DeletingPage.module.css';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "12 songs", "Album", "1 song" beside the title. */
export function groupWhat(g: DeletionGroup): string {
  if (g.wholeAlbum) return 'Album';
  return g.fileIds.length === 1 ? '1 song' : `${g.fileIds.length} songs`;
}

const STATE: Partial<Record<DeletionGroup['state'], string>> = { moving: 'Moving…', restoring: 'Restoring…' };

function Row({ g, action, selected = false }: { g: DeletionGroup; action: React.ReactNode; selected?: boolean }) {
  return (
    <li className={styles.row} data-purge-selected={selected || undefined}>
      <div className={styles.body}>
        <p className={styles.title}>
          {g.trackTitle && <span>{g.trackTitle} · </span>}
          <span className={styles.album}>{g.title}</span>
        </p>
        <p className={styles.meta}>
          {g.artist && <span>{g.artist}</span>}
          <span>{groupWhat(g)}</span>
          <span>{shortDate(g.createdAt)}</span>
          {selected && <span className={styles.live}>Selected for Empty Trash</span>}
          {STATE[g.state] && <span className={styles.live}>{STATE[g.state]}</span>}
          {g.error && <span className={styles.error}>{g.error}</span>}
        </p>
      </div>
      <div className={styles.actions}>{action}</div>
    </li>
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ message: 'Copied' });
  } catch {
    showToast({ message: 'Not copied. Select the command and copy it.', tone: 'danger' });
  }
}

export function DeletingPanel() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading, isError, refetch } = useDeletingView(libraryId);
  const unmark = useUnmark(libraryId);
  const restore = useRestore(libraryId);
  const empty = useEmptyTrash(libraryId);

  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  if (isError || !data) {
    return <p role="alert" className={styles.error}>Couldn’t load. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Try again</Button></p>;
  }
  const task = data.emptyTask?.task;
  if (data.marked.length === 0 && data.trash.length === 0 && !task) {
    return <EmptyState title="Nothing deleted" action={<Link to="/settings/$section" params={{ section: 'deleting' }} className={styles.link}>{data.mode === 'trash' ? 'Deleting: Trash' : 'Deleting: Mark'}</Link>} />;
  }
  const taskOpen = !!task && task.state !== 'done' && task.state !== 'cancelled';
  const selection = data.emptyFileIds ?? [];
  const selected = new Set(data.emptyTask?.fileIds);
  const emptyTrash = async () => {
    const fileIds = [...selection];
    if (!fileIds.length || taskOpen) return;
    const confirmed = await confirmDialog({
      title: 'Empty Trash?', message: `Permanently delete ${fileIds.length} ${fileIds.length === 1 ? 'file' : 'files'} from Trash?`,
      confirmLabel: 'Empty Trash', tone: 'danger',
    });
    if (confirmed) empty.mutate(fileIds, { onError: () => void refetch() });
  };
  return (
    <div className={styles.container}>
      {data.marked.length > 0 && (
        <section aria-labelledby="deleting-marked">
          <div className={styles.head}>
            <h2 id="deleting-marked" className={styles.heading}>Marked <span className={styles.count}>{data.marked.reduce((n, g) => n + g.fileIds.length, 0)}</span></h2>
          </div>
          {data.command && (
            <div className={styles.command}>
              <pre className={styles.code} data-testid="delete-command"><code>{data.command}</code></pre>
              <Button variant="secondary" size="sm" onClick={() => void copy(data.command!)}>Copy</Button>
            </div>
          )}
          <ul className={styles.list}>
            {data.marked.map((g) => (
              <Row key={g.key} g={g} action={<Button variant="quiet" size="sm" disabled={unmark.isPending} onClick={() => unmark.mutate(g.fileIds)}>Unmark</Button>} />
            ))}
          </ul>
        </section>
      )}
      {(data.trash.length > 0 || task) && (
        <section aria-labelledby="deleting-trash">
          <div className={styles.head}>
            <h2 id="deleting-trash" className={styles.heading}>Trash <span className={styles.count}>{data.trash.reduce((n, g) => n + g.fileIds.length, 0)}</span></h2>
            <span className={styles.muted}>{data.trashDays} days</span>
            <Button variant="quiet-danger" size="sm" loading={empty.isPending} disabled={taskOpen || !selection.length} onClick={() => void emptyTrash()} className={styles.headAction}>Empty Trash</Button>
          </div>
          {task && libraryId && <MaintenanceTaskStatus task={task} libraryId={libraryId} />}
          {empty.isError && <p role="alert" className={styles.error}>{(empty.error as { detail?: string }).detail ?? 'Couldn’t start Empty Trash.'}</p>}
          <ul className={styles.list}>
            {data.trash.map((g) => {
              const reserved = g.fileIds.some((id) => selected.has(id));
              return <Row key={g.key} g={g} selected={reserved} action={(
                <Button variant="quiet" size="sm" disabled={reserved || g.state !== 'trashed' || restore.isPending} onClick={() => restore.mutate(g.fileIds)}>Restore</Button>
              )} />;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
