/**
 * The album page's compilation helper. When other albums carry the same
 * title and fit together with this one (no track number twice), it offers
 * to treat them as one album: nothing moves on disk, rescans keep the merge,
 * and it can be split back. A merged album says so and offers the undo.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, confirmDialog } from './ui';
import { useMergeAlbums, useUnmergeAlbum } from '../hooks/useCompilations';
import styles from './CompilationPanel.module.css';

export interface MergeCandidateView {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  trackCount: number | null;
  state: string;
  dirPaths: string[];
}

export function CompilationPanel({
  libraryId,
  album,
  onEditTags,
}: {
  libraryId: string;
  album: { id: string; title: string | null; merged?: boolean; mergeCandidates?: MergeCandidateView[]; trackCount: number | null };
  onEditTags: () => void;
}) {
  const merge = useMergeAlbums(libraryId);
  const unmerge = useUnmergeAlbum(libraryId);
  const [note, setNote] = useState<string | null>(null);
  const candidates = album.mergeCandidates ?? [];
  const tracksElsewhere = candidates.reduce((n, c) => n + (c.trackCount ?? 0), 0);

  if (!album.merged && candidates.length === 0) return null;

  const onMerge = async () => {
    setNote(null);
    try {
      const r = await merge.mutateAsync({ albumIds: [album.id, ...candidates.map((c) => c.id)], targetId: album.id });
      setNote(`${r.files} tracks are now one album.${r.identifyQueued ? ' Identification is queued with every track in view.' : ''}`);
    } catch (e) {
      setNote((e as { detail?: string })?.detail ?? 'The albums could not be merged.');
    }
  };
  const onUnmerge = async () => {
    if (!(await confirmDialog({ title: 'Split this album back?', message: 'It goes back to the albums it was made from. Nothing on disk changes.', confirmLabel: 'Split back' }))) return;
    setNote(null);
    try {
      const r = await unmerge.mutateAsync(album.id);
      setNote(`Splitting back: ${r.folders} folder${r.folders === 1 ? '' : 's'} regroup in a few seconds.`);
    } catch (e) {
      setNote((e as { detail?: string })?.detail ?? 'The album could not be split back.');
    }
  };

  return (
    <section className={styles.panel} aria-label="Compilation">
      {album.merged ? (
        <>
          <p className={styles.text}>
            <strong>Made from several albums.</strong>{' '}
            These tracks were treated as one album; the files stay where they are.
          </p>
          <div className={styles.actions}>
            <Button variant="primary" size="sm" onClick={onEditTags}>Set album values</Button>
            <Button variant="ghost" size="sm" onClick={() => void onUnmerge()} loading={unmerge.isPending}>Split back</Button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.text}>
            <strong>
              {candidates.length === 1 ? 'One more album is' : `${candidates.length} more albums are`} called “{album.title}”
            </strong>{' '}
            with {tracksElsewhere} more track{tracksElsewhere === 1 ? '' : 's'} that fit this one. They look like pieces of the same
            release. Treat them as one album, then set the album artist and title for all tracks at once.
          </p>
          <details className={styles.list}>
            <summary>Show them</summary>
            <ul>
              {candidates.map((c) => (
                <li key={c.id}>
                  <Link to="/albums/$albumId" params={{ albumId: c.id }}>{c.artist ?? 'Unknown artist'}</Link>
                  <span className={styles.meta}> · {c.trackCount ?? 0} track{c.trackCount === 1 ? '' : 's'} · {c.dirPaths[0] ?? ''}</span>
                </li>
              ))}
            </ul>
          </details>
          <div className={styles.actions}>
            <Button variant="primary" size="sm" onClick={() => void onMerge()} loading={merge.isPending}>
              Treat as one album
            </Button>
            <Button variant="ghost" size="sm" onClick={onEditTags}>Set album values instead</Button>
          </div>
        </>
      )}
      {note && <p className={styles.note} role="status">{note}</p>}
    </section>
  );
}
