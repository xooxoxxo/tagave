import { describe, expect, it } from 'vitest';
import { SELF_REPLACE_STALE_MS, type UpdaterSelfReplace, type UpdaterView } from '@tagave/shared';
import { receiveUpdaterView, restartingOn } from './useUpdater';

// The browser's clock; the server's `since` is deliberately a day off.
const NOW = Date.parse('2026-10-16T10:00:00Z');
const marker = (ageMs?: number, runId = 'r1'): UpdaterSelfReplace => ({
  expectedVersion: '0.8.0',
  fromVersion: '0.7.0',
  runId,
  since: '2026-10-15T10:00:00Z',
  ...(ageMs === undefined ? {} : { ageMs }),
});
const view = (selfReplace: UpdaterSelfReplace | null, version = '0.7.0'): UpdaterView => ({
  installed: true,
  reachable: true,
  error: null,
  updater: { version, configuredVersion: '0.8.0', role: 'all', services: ['app'], run: null, selfReplace },
});
const unreachable: UpdaterView = { installed: true, reachable: false, error: 'the updater does not answer', updater: null };

describe('restartingOn', () => {
  it('ages the marker by the age the updater reports, never by comparing clocks', () => {
    const seen = receiveUpdaterView(undefined, view(marker(60_000)), NOW);
    expect(seen.restartUntil).toBe(NOW + SELF_REPLACE_STALE_MS - 60_000);
    expect(restartingOn(seen, NOW)?.expectedVersion).toBe('0.8.0');
    expect(restartingOn(seen, NOW + SELF_REPLACE_STALE_MS - 60_000 + 1)).toBeNull();
  });

  it('without a reported age, waits from the first time this page saw the marker', () => {
    const first = receiveUpdaterView(undefined, view(marker()), NOW);
    expect(first.restartUntil).toBe(NOW + SELF_REPLACE_STALE_MS);
    const again = receiveUpdaterView(first, view(marker()), NOW + 30_000);
    expect(again.restartUntil).toBe(NOW + SELF_REPLACE_STALE_MS);
    // a marker of another run starts its own wait
    expect(receiveUpdaterView(first, view(marker(undefined, 'r2')), NOW + 30_000).restartUntil).toBe(NOW + 30_000 + SELF_REPLACE_STALE_MS);
  });

  it('is null without a marker or from an older updater', () => {
    expect(restartingOn(view(null), NOW)).toBeNull();
    const { selfReplace: _gone, ...older } = view(null).updater!;
    expect(restartingOn({ ...view(null), updater: older }, NOW)).toBeNull();
    expect(restartingOn(undefined, NOW)).toBeNull();
  });
});

describe('receiveUpdaterView', () => {
  it('keeps the last answer, marked unreachable, while the restarting updater does not answer', () => {
    const seen = receiveUpdaterView(undefined, view(marker(0)), NOW);
    const kept = receiveUpdaterView(seen, unreachable, NOW + 5000);
    expect(kept.reachable).toBe(false);
    expect(kept.error).toBe('the updater does not answer');
    expect(restartingOn(kept, NOW + 5000)?.expectedVersion).toBe('0.8.0');
    expect(kept.restartUntil).toBe(seen.restartUntil);
  });

  it('stops carrying once the wait is over', () => {
    const seen = receiveUpdaterView(undefined, view(marker(SELF_REPLACE_STALE_MS - 1000)), NOW);
    expect(receiveUpdaterView(seen, unreachable, NOW + 2000)).toBe(unreachable);
  });

  it('takes the new answer once the updater is back on the new version', () => {
    const seen = receiveUpdaterView(undefined, view(marker(0)), NOW);
    const back = view(null, '0.8.0');
    expect(receiveUpdaterView(seen, back, NOW + 5000)).toBe(back);
    expect(restartingOn(back, NOW)).toBeNull();
  });

  it('does not hide an updater that is simply down', () => {
    expect(receiveUpdaterView(view(null), unreachable, NOW)).toBe(unreachable);
    expect(receiveUpdaterView(undefined, unreachable, NOW)).toBe(unreachable);
  });
});
