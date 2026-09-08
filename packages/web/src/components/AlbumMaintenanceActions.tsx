/**
 * Folder-level actions for the album page: rescan the album's directory,
 * split a mixed (lossless + lossy) album into two, merge a split-off album
 * back. Files are never deleted or moved from here.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMergeSplitAlbum, useRescanAlbumFolder, useSplitAlbumByFormat } from '../hooks/useAlbumMaintenance';
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
    if (!window.confirm(`Move the ${other} files into their own album? Nothing on disk changes; you can merge them back any time.`)) return;
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
    if (!window.confirm('Merge this album back into the one it was split from?')) return;
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
        <button
          type="button"
          className={styles.btn}
          onClick={onRescan}
          disabled={busy || dirs === 0}
          title={dirs === 0 ? 'This album has no folder on disk' : 'Re-read this folder: new files added, removed files dropped, tags refreshed'}
        >
          {rescan.isPending ? 'Rescanning…' : 'Rescan folder'}
        </button>

        {album.splitFrom ? (
          <button type="button" className={styles.btn} onClick={onMerge} disabled={busy} title="Return these files to the album they were split from">
            {merge.isPending ? 'Merging…' : 'Merge back'}
          </button>
        ) : album.mixed ? (
          <span className={styles.splitGroup}>
            <button type="button" className={styles.btn} onClick={() => onSplit('lossless')} disabled={busy} title="Keep the lossless files here; the lossy copies get their own album">
              {split.isPending ? 'Splitting…' : 'Split off lossy copies'}
            </button>
            <button type="button" className={styles.btnQuiet} onClick={() => onSplit('lossy')} disabled={busy} title="Keep the lossy files here; the lossless copies get their own album">
              …or split off lossless
            </button>
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
