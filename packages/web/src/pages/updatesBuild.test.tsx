/**
 * Settings › Updates, Running now: a worker on another build than the app
 * reads Updating while an update runs or has just ended, Older build (the
 * warning) otherwise, and never "lagging".
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdateRun, WorkerVersion } from '@tagave/shared';
import type { SeenUpdaterView } from '../hooks/useUpdater';
import { RunningNow, SETTLE_MS, updatingNow, workerBuild } from './SettingsUpdatesPage';
import { APP_BUILD, WORKER_OLD, WORKER_SAME } from '../stories/updatesFixtures';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const run = (status: UpdateRun['status'], finishedAt: string | null): UpdateRun => ({
  id: 'r1', from: '0.21.0', target: '0.22.0', status, startedAt: '2026-11-04T11:50:00Z', finishedAt, steps: [], log: [], reason: null, backup: null, rollback: null,
});
const view = (r: UpdateRun | null): SeenUpdaterView => ({
  installed: true, reachable: true, error: null,
  updater: { version: '0.22.0', configuredVersion: '0.22.0', role: 'all', services: ['app', 'worker'], run: r },
});
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('updatingNow', () => {
  it('while the updater runs an update', () => {
    expect(updatingNow(view(run('running', null)), null, NOW)).toBe(true);
  });

  it('for two minutes after the run ends, then not', () => {
    expect(updatingNow(view(run('succeeded', ago(30_000))), null, NOW)).toBe(true);
    expect(updatingNow(view(run('succeeded', ago(SETTLE_MS + 1000))), null, NOW)).toBe(false);
  });

  it('for two minutes after this page saw the app come back on a new build (an update by hand)', () => {
    expect(updatingNow(undefined, NOW - 60_000, NOW)).toBe(true);
    expect(updatingNow(undefined, NOW - SETTLE_MS - 1, NOW)).toBe(false);
  });

  it('without an updater and no change seen: not updating', () => {
    expect(updatingNow(undefined, null, NOW)).toBe(false);
    expect(updatingNow(view(null), null, NOW)).toBe(false);
  });
});

describe('Running now: a worker on another build', () => {
  it('the same build, or a build id missing on either side, is no mark', () => {
    expect(workerBuild(WORKER_SAME, APP_BUILD, false)).toBe('same');
    expect(workerBuild({ ...WORKER_OLD, sha: null }, APP_BUILD, false)).toBe('same');
  });

  const table = (workers: WorkerVersion[], updating: boolean) =>
    renderToStaticMarkup(<RunningNow app={APP_BUILD} workers={workers} updating={updating} now={NOW} />);

  it('updating: Updating, in the info tone, no warning row', () => {
    const html = table([WORKER_SAME, WORKER_OLD], true);
    expect(html).toContain('>Updating</span>');
    expect(html).not.toContain('Older build');
    expect(html).not.toMatch(/rowWarn/);
    expect(html).not.toMatch(/lagging/i);
  });

  it('otherwise: Older build in the warning tone, on a warning row', () => {
    const html = table([WORKER_SAME, WORKER_OLD], false);
    expect(html).toMatch(/class="[^"]*attention[^"]*">Older build<\/span>/);
    expect((html.match(/rowWarn/g) ?? []).length).toBe(1);
    expect(html).not.toContain('Updating');
    expect(html).not.toMatch(/lagging/i);
  });
});
