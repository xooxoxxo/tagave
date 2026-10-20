/**
 * Reload into a new build only when nothing plays: now, or at the next
 * pause, stop, error or end of the queue; never in the middle of a track (a
 * reload drops the queue, and the browser would not start it again without
 * a tap). Used after an update by the owner's tab (InAppUpdate) and by every
 * tab that saw the app go down (UpdateDownScreen).
 */
import { usePlayerStore, type PlayerStatus } from '../player/engine';

/** The player is making sound, or about to: loading and buffering count. */
export const sounding = (status: PlayerStatus) => status === 'playing' || status === 'loading' || status === 'buffering';

export interface PlayerWatch {
  playing: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

export const playerWatch: PlayerWatch = {
  playing: () => sounding(usePlayerStore.getState().status),
  subscribe: (listener) => usePlayerStore.subscribe(listener),
};

/** Reload once nothing plays. Returns a cancel. */
export function reloadWhenQuiet(reload: () => void = () => globalThis.location.reload(), watch: PlayerWatch = playerWatch): () => void {
  if (!watch.playing()) {
    reload();
    return () => undefined;
  }
  let done = false;
  let off: () => void = () => undefined;
  off = watch.subscribe(() => {
    if (done || watch.playing()) return;
    done = true;
    off();
    reload();
  });
  return () => { done = true; off(); };
}
