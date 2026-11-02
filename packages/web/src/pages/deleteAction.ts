/**
 * The one delete item of every ⋮ (tracks, the album page, album cards, each
 * copy under Duplicates), in the library's mode: "Mark for deletion" or "Move
 * to trash", never both (vault "tagave - Deleting Songs and Albums").
 *
 * Same shape as removing a physical copy (collectionRemoval.ts, rr62): the
 * song or album goes from the page at once, a toast offers Undo for five
 * seconds, and only then is the request sent. No confirm dialog: Undo, and
 * later Unmark or Restore, are the ways back.
 */
import { useMemo } from 'react';
import type { DeleteMode } from '@tagave/shared';
import { showToast } from '../components/ui';
import { useCommitDeletion, useDeleteMode } from '../hooks/useDeletions';
import { scheduleRemoval, undoRemoval, useHiddenRemovals, UNDO_MS } from './collectionRemoval';

export const deleteLabel = (mode: DeleteMode): string => (mode === 'trash' ? 'Move to trash' : 'Mark for deletion');
export const deletedNote = (mode: DeleteMode): string => (mode === 'trash' ? 'Moved to trash' : 'Marked for deletion');

/** Keys in the shared hide-while-waiting store (collectionRemoval.ts keeps record ids; these are prefixed). */
export const trackKey = (id: string) => `delete:track:${id}`;
export const albumKey = (id: string) => `delete:album:${id}`;

export interface DeleteAction {
  mode: DeleteMode;
  label: string;
  tracks: (ids: string[], title: string) => void;
  album: (id: string, title: string) => void;
}

/** The owner's delete item; null for everyone else (and until the mode is known). */
export function useDeleteAction(libraryId: string | undefined): DeleteAction | null {
  const mode = useDeleteMode(libraryId);
  const commit = useCommitDeletion(libraryId);
  if (!mode || !libraryId) return null;
  const run = (key: string, body: { trackIds?: string[]; albumIds?: string[] }, title: string) => {
    scheduleRemoval(
      key,
      (opts) => commit(body, opts),
      () => showToast({ message: `${title} · Not deleted. Try again.`, tone: 'danger', durationMs: 10000 }),
    );
    showToast({ message: `${title} · ${deletedNote(mode.mode)}`, action: { label: 'Undo', onClick: () => void undoRemoval(key) }, durationMs: UNDO_MS });
  };
  return {
    mode: mode.mode,
    label: deleteLabel(mode.mode),
    tracks: (ids, title) => run(ids.length === 1 ? trackKey(ids[0]!) : `delete:tracks:${ids.join(',')}`, { trackIds: ids }, title),
    album: (id, title) => run(albumKey(id), { albumIds: [id] }, title),
  };
}

/** Songs and albums waiting out their Undo (or being sent): pages leave them out. */
export function useHiddenDeletions(): { track: (id: string) => boolean; album: (id: string) => boolean } {
  const hidden = useHiddenRemovals();
  return useMemo(() => ({ track: (id: string) => hidden.has(trackKey(id)), album: (id: string) => hidden.has(albumKey(id)) }), [hidden]);
}
