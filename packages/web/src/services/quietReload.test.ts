import { describe, expect, it } from 'vitest';
import { reloadWhenQuiet, sounding, type PlayerWatch } from './quietReload';
import type { PlayerStatus } from '../player/engine';

/** A player whose status the test moves. */
function player(status: PlayerStatus) {
  let s = status;
  const listeners = new Set<() => void>();
  const watch: PlayerWatch = {
    playing: () => sounding(s),
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return { watch, set: (next: PlayerStatus) => { s = next; listeners.forEach((l) => l()); }, listeners };
}

describe('reloading into a new build only when nothing plays', () => {
  it('reloads at once when nothing plays', () => {
    for (const status of ['idle', 'paused', 'error'] as PlayerStatus[]) {
      let reloads = 0;
      reloadWhenQuiet(() => { reloads++; }, player(status).watch);
      expect(reloads, status).toBe(1);
    }
  });

  it('waits through a track, its next track and buffering, then reloads at the pause, once', () => {
    const p = player('playing');
    let reloads = 0;
    reloadWhenQuiet(() => { reloads++; }, p.watch);
    expect(reloads).toBe(0);
    p.set('loading');
    p.set('playing');
    p.set('buffering');
    p.set('playing');
    expect(reloads).toBe(0);
    p.set('paused');
    expect(reloads).toBe(1);
    p.set('idle');
    expect(reloads).toBe(1);
    expect(p.listeners.size).toBe(0);
  });

  it('reloads when the queue ends', () => {
    const p = player('playing');
    let reloads = 0;
    reloadWhenQuiet(() => { reloads++; }, p.watch);
    p.set('idle');
    expect(reloads).toBe(1);
  });

  it('does nothing once cancelled', () => {
    const p = player('playing');
    let reloads = 0;
    const cancel = reloadWhenQuiet(() => { reloads++; }, p.watch);
    cancel();
    p.set('paused');
    expect(reloads).toBe(0);
    expect(p.listeners.size).toBe(0);
  });
});
