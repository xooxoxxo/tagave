/**
 * Library care › Moved (owner): the songs moved to another album (0080) and
 * the way back. Undo puts each file back at its old path with its old tags,
 * as the album page's Undo does in its first five seconds.
 */
import { Link } from '@tanstack/react-router';
import type { MoveListItem } from '@tagave/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentLibrary } from '../hooks';
import { invalidateAfterMove, useMoves, useUndoMove } from '../hooks/useAlbumMove';
import { Button, EmptyState, showToast } from '../components/ui';
import styles from './DeletingPage.module.css';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** What the move was (0081): an album put where the naming rules say, or a dropped album imported. */
const KIND: Partial<Record<MoveListItem['kind'], string>> = { organize: 'Organized', import: 'Imported' };

const STATE: Partial<Record<MoveListItem['state'], string>> = { moving: 'Moving…', undoing: 'Undoing…', undone: 'Undone' };

export function MovedPanel() {
  const { libraryId } = useCurrentLibrary();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useMoves(libraryId);
  const undo = useUndoMove(libraryId);

  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  if (isError || !data) {
    return <p role="alert" className={styles.error}>Couldn’t load. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Try again</Button></p>;
  }
  if (data.items.length === 0) return <EmptyState title="Nothing moved" />;
  return (
    <div className={styles.container}>
      <section aria-labelledby="moved-list">
        <div className={styles.head}>
          <h2 id="moved-list" className={styles.heading}>Moved <span className={styles.count}>{data.items.filter((m) => m.state === 'done').length}</span></h2>
        </div>
        <ul className={styles.list}>
          {data.items.map((m) => (
            <li key={m.id} className={styles.row} data-move={m.id}>
              <div className={styles.body}>
                <p className={styles.title}>
                  {m.targetAlbumId && m.state === 'done'
                    ? <Link to="/albums/$albumId" params={{ albumId: m.targetAlbumId }} className={styles.album}>{m.title}</Link>
                    : <span className={styles.album}>{m.title}</span>}
                </p>
                <p className={styles.meta}>
                  {KIND[m.kind] && <span>{KIND[m.kind]}</span>}
                  {m.artist && <span>{m.artist}</span>}
                  <span>{m.files === 1 ? '1 song' : `${m.files} songs`}</span>
                  {m.finishedAt && <span>{shortDate(m.finishedAt)}</span>}
                  {STATE[m.state] && <span className={styles.live}>{STATE[m.state]}</span>}
                  {m.error && <span className={styles.error}>{m.error}</span>}
                </p>
                {m.fromDir !== null && m.toDir && <p className={styles.meta}><span>{m.fromDir || '/'} → {m.toDir}</span></p>}
              </div>
              <div className={styles.actions}>
                {m.undoable && m.state === 'done' && (
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={undo.isPending}
                    onClick={() => undo.mutate(m.id, {
                      onSuccess: () => { setTimeout(() => void invalidateAfterMove(qc, libraryId), 4000); },
                      onError: () => showToast({ message: 'Not undone. Try again.', tone: 'danger' }),
                    })}
                  >
                    Undo
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
