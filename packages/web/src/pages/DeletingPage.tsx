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
import styles from './DeletingPage.module.css';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "12 songs", "Album", "1 song" beside the title. */
export function groupWhat(g: DeletionGroup): string {
  if (g.wholeAlbum) return 'Album';
  return g.fileIds.length === 1 ? '1 song' : `${g.fileIds.length} songs`;
}

const STATE: Partial<Record<DeletionGroup['state'], string>> = { moving: 'Moving…', restoring: 'Restoring…' };

function Row({ g, action }: { g: DeletionGroup; action: React.ReactNode }) {
  return (
    <li className={styles.row}>
      <div className={styles.body}>
        <p className={styles.title}>
          {g.trackTitle && <span>{g.trackTitle} · </span>}
          <span className={styles.album}>{g.title}</span>
        </p>
        <p className={styles.meta}>
          {g.artist && <span>{g.artist}</span>}
          <span>{groupWhat(g)}</span>
          <span>{shortDate(g.createdAt)}</span>
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
  if (data.marked.length === 0 && data.trash.length === 0) {
    return <EmptyState title="Nothing deleted" action={<Link to="/settings/$section" params={{ section: 'deleting' }} className={styles.link}>{data.mode === 'trash' ? 'Deleting: Trash' : 'Deleting: Mark'}</Link>} />;
  }
  const emptyTrash = async () => {
    if (await confirmDialog({ title: 'Empty trash?', message: `${data.trash.reduce((n, g) => n + g.fileIds.length, 0)} files`, confirmLabel: 'Empty trash', tone: 'danger' })) empty.mutate();
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
      {data.trash.length > 0 && (
        <section aria-labelledby="deleting-trash">
          <div className={styles.head}>
            <h2 id="deleting-trash" className={styles.heading}>Trash <span className={styles.count}>{data.trash.reduce((n, g) => n + g.fileIds.length, 0)}</span></h2>
            <span className={styles.muted}>{data.trashDays} days</span>
            <Button variant="quiet-danger" size="sm" loading={empty.isPending} onClick={() => void emptyTrash()} className={styles.headAction}>Empty trash</Button>
          </div>
          <ul className={styles.list}>
            {data.trash.map((g) => (
              <Row key={g.key} g={g} action={(
                <Button variant="quiet" size="sm" disabled={g.state !== 'trashed' || restore.isPending} onClick={() => restore.mutate(g.fileIds)}>Restore</Button>
              )} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
