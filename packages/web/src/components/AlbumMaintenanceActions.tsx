/**
 * Folder-level actions for the album page: rescan the album's directory,
 * split a mixed (lossless + lossy) album into two, merge a split-off album
 * back. Files are never deleted or moved from here.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMergeSplitAlbum, useRescanAlbumFolder, useSplitAlbumByFormat } from '../hooks/useAlbumMaintenance';
import { Button, confirmDialog } from './ui';
import styles from './AlbumMaintenanceActions.module.css';

export interface MaintenanceAlbum {
  id: string;
  /** lossless and lossy files side by side */
  mixed?: boolean | null;
  /** id of the album this one was split off from */
  splitFrom?: string | null;
  dirPaths?: string[] | null;
}

export function AlbumMaintenanceActions({ libraryId, album }: { libraryId: string; album: MaintenanceAlbum }) {
  const navigate = useNavigate();
  const rescan = useRescanAlbumFolder(libraryId);
  const split = useSplitAlbumByFormat(libraryId);
  const merge = useMergeSplitAlbum(libraryId);
  const [note, setNote] = useState<string | null>(null);

  const dirs = album.dirPaths?.length ?? 0;
  const busy = rescan.isPending || split.isPending || merge.isPending;

  const onRescan = async () => {
    setNote(null);
    try {
      const r = await rescan.mutateAsync(album.id);
      setNote(`Rescanning ${r.queued.length} folder${r.queued.length === 1 ? '' : 's'} — the page updates as files are re-read.`);
    } catch (err) {
      setNote(errorText(err, 'Rescan failed'));
    }
  };

  const onSplit = async (keep: 'lossless' | 'lossy') => {
    const other = keep === 'lossless' ? 'lossy' : 'lossless';
    if (!(await confirmDialog({ title: `Move the ${other} files into their own album?`, message: 'Nothing on disk changes. You can merge them back any time.', confirmLabel: 'Split' }))) return;
    setNote(null);
    try {
      const r = await split.mutateAsync({ albumId: album.id, keep });
      setNote(`Moved ${r.moved} file${r.moved === 1 ? '' : 's'} to a new album; ${r.kept} stay here.`);
      void navigate({ to: '/albums/$albumId', params: { albumId: r.newAlbumId } });
    } catch (err) {
      setNote(errorText(err, 'Split failed'));
    }
  };

  const onMerge = async () => {
    if (!(await confirmDialog({ title: 'Merge this album back?', message: 'Its files rejoin the album they were split from. Nothing on disk changes.', confirmLabel: 'Merge back' }))) return;
    setNote(null);
    try {
      const r = await merge.mutateAsync(album.id);
      void navigate({ to: '/albums/$albumId', params: { albumId: r.originalAlbumId } });
    } catch (err) {
      setNote(errorText(err, 'Merge failed'));
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={onRescan}
          disabled={busy || dirs === 0}
          title={dirs === 0 ? 'This album has no folder on disk' : 'Re-read this folder: new files added, removed files dropped, tags refreshed'}
        >
          {rescan.isPending ? 'Rescanning…' : 'Rescan folder'}
        </Button>

        {album.splitFrom ? (
          <Button variant="secondary" size="sm" type="button" onClick={onMerge} disabled={busy} title="Return these files to the album they were split from">
            {merge.isPending ? 'Merging…' : 'Merge back'}
          </Button>
        ) : album.mixed ? (
          <span className={styles.splitGroup}>
            <Button variant="secondary" size="sm" type="button" onClick={() => onSplit('lossless')} disabled={busy} title="Keep the lossless files here; the lossy copies get their own album">
              {split.isPending ? 'Splitting…' : 'Split off lossy copies'}
            </Button>
            <Button variant="quiet" size="sm" type="button" onClick={() => onSplit('lossy')} disabled={busy} title="Keep the lossy files here; the lossless copies get their own album">
              …or split off lossless
            </Button>
          </span>
        ) : null}
      </div>
      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { detail?: string; message?: string } | null;
  return e?.detail ?? e?.message ?? fallback;
}
