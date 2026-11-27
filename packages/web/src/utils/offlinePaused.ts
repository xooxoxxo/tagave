/**
 * Work cut off by an offline music folder (vault "tagave - Offline Library
 * Spec" §7, "Split, move"): the worker writes PAUSED_OFFLINE_STAGE as a
 * task's stage or a move's error. A paused split (a task) shows it with this
 * help behind "?"; a paused move shows the line alone, in the quiet tone: a
 * move offers only Undo, so "Press Continue" would point at no button.
 */
import { PAUSED_OFFLINE_STAGE, type AlbumMoveView } from '@tagave/shared';

export const PAUSED_OFFLINE_HELP = 'Press Continue when the folder is back.';

/** The album page's toast after a move: "2 songs · Moved", or paused when the folder went offline mid-move. */
export function movedToast(moved: number, error: string | null | undefined): string {
  if (error === PAUSED_OFFLINE_STAGE) return PAUSED_OFFLINE_STAGE;
  return `${moved === 1 ? '1 song' : `${moved} songs`} · Moved`;
}

/**
 * The album page's toast when an Undo ends: "Undone"; an undo the offline
 * folder cut off, quietly (as Moved shows it); any other end, in danger.
 */
export function undoneToast(v: Pick<AlbumMoveView, 'state' | 'error'> | null): { message: string; tone?: 'danger' } {
  if (v?.state === 'undone') return { message: 'Undone' };
  if (v?.error === PAUSED_OFFLINE_STAGE) return { message: PAUSED_OFFLINE_STAGE };
  return { message: v?.error ?? 'Not undone', tone: 'danger' };
}
