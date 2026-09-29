/**
 * Folder-level actions for the album page's Manage menu: rescan the album's
 * directory, split a mixed (lossless + lossy) album into two, merge a
 * split-off album back. Files are never deleted or moved from here.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMergeSplitAlbum, useRescanAlbumFolder, useSplitAlbumByFormat } from '../hooks/useAlbumMaintenance';
import { confirmDialog } from './ui';

export interface MaintenanceAlbum {
  id: string;
  /** lossless and lossy files side by side */
  mixed?: boolean | null;
  /** id of the album this one was split off from */
  splitFrom?: string | null;
  dirPaths?: string[] | null;
}

export interface AlbumFolderActions {
  /** the album has a folder on disk to rescan */
  canRescan: boolean;
  canSplit: boolean;
  canMergeBack: boolean;
  busy: boolean;
  rescan: () => Promise<void>;
  split: (keep: 'lossless' | 'lossy') => Promise<void>;
  mergeBack: () => Promise<void>;
  /** what the last action did, or why it failed */
  note: string | null;
}

export function useAlbumFolderActions(libraryId: string | undefined, album: MaintenanceAlbum | undefined): AlbumFolderActions {
  const navigate = useNavigate();
  const rescanM = useRescanAlbumFolder(libraryId ?? '');
  const splitM = useSplitAlbumByFormat(libraryId ?? '');
  const mergeM = useMergeSplitAlbum(libraryId ?? '');
  const [note, setNote] = useState<string | null>(null);
  const dirs = album?.dirPaths?.length ?? 0;
  const busy = rescanM.isPending || splitM.isPending || mergeM.isPending;

  const rescan = async () => {
    if (!album) return;
    setNote(null);
    try {
      const r = await rescanM.mutateAsync(album.id);
      setNote(`Rescanning ${r.queued.length} folder${r.queued.length === 1 ? '' : 's'} — the page updates as files are re-read.`);
    } catch (err) {
      setNote(errorText(err, 'Rescan failed'));
    }
  };

  const split = async (keep: 'lossless' | 'lossy') => {
    if (!album) return;
    const other = keep === 'lossless' ? 'lossy' : 'lossless';
    if (!(await confirmDialog({ title: `Move the ${other} files into their own album?`, message: 'Nothing on disk changes. You can merge them back any time.', confirmLabel: 'Split' }))) return;
    setNote(null);
    try {
      const r = await splitM.mutateAsync({ albumId: album.id, keep });
      setNote(`Moved ${r.moved} file${r.moved === 1 ? '' : 's'} to a new album; ${r.kept} stay here.`);
      void navigate({ to: '/albums/$albumId', params: { albumId: r.newAlbumId } });
    } catch (err) {
      setNote(errorText(err, 'Split failed'));
    }
  };

  const mergeBack = async () => {
    if (!album) return;
    if (!(await confirmDialog({ title: 'Merge this album back?', message: 'Its files rejoin the album they were split from. Nothing on disk changes.', confirmLabel: 'Merge back' }))) return;
    setNote(null);
    try {
      const r = await mergeM.mutateAsync(album.id);
      void navigate({ to: '/albums/$albumId', params: { albumId: r.originalAlbumId } });
    } catch (err) {
      setNote(errorText(err, 'Merge failed'));
    }
  };

  return {
    canRescan: dirs > 0,
    canSplit: !album?.splitFrom && !!album?.mixed,
    canMergeBack: !!album?.splitFrom,
    busy,
    rescan,
    split,
    mergeBack,
    note,
  };
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { detail?: string; message?: string } | null;
  return e?.detail ?? e?.message ?? fallback;
}
