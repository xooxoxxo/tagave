/**
 * Work cut off by an offline music folder (vault "tagave - Offline Library
 * Spec" §7, "Split, move"): the worker writes PAUSED_OFFLINE_STAGE as a
 * task's stage or a move's error, and the web shows it with this help behind "?".
 */
import { PAUSED_OFFLINE_STAGE } from '@tagave/shared';

export const PAUSED_OFFLINE_HELP = 'Press Continue when the folder is back.';

/** The album page's toast after a move: "2 songs · Moved", or paused when the folder went offline mid-move. */
export function movedToast(moved: number, error: string | null | undefined): string {
  if (error === PAUSED_OFFLINE_STAGE) return PAUSED_OFFLINE_STAGE;
  return `${moved === 1 ? '1 song' : `${moved} songs`} · Moved`;
}
