/**
 * Settings › Updates while the updater restarts itself on the new version:
 * the note shows and the Start button stays disabled until it is back.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReleaseNote, UpdateRun, UpdaterSelfReplace, UpdaterView } from '@tagave/shared';
import { InAppUpdate, RunView, restartConflictError } from './InAppUpdate';
import { CRASH_LOOP, RECOVERING, updateRun } from '../stories/updateFixtures';

const release = { version: '0.9.0', tag: 'v0.9.0' } as ReleaseNote;
const view = (selfReplace: UpdaterSelfReplace | null, version = '0.7.0'): UpdaterView => ({
  installed: true,
  reachable: true,
  error: null,
  updater: { version, configuredVersion: '0.8.0', role: 'all', services: ['app'], run: null, selfReplace },
});

function render(v: UpdaterView): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <InAppUpdate view={v} disconnected={false} current="0.8.0" releases={[release]} confirmed />
    </QueryClientProvider>,
  );
}

const startButton = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*Update to 0\.9\.0(?:(?!<\/button>).)*<\/button>/s.exec(html)?.[0] ?? '';

describe('InAppUpdate while the updater restarts itself', () => {
  it('says so and keeps Start disabled', () => {
    const html = render(view({ expectedVersion: '0.8.0', fromVersion: '0.7.0', runId: 'r1', since: new Date().toISOString() }));
    expect(html).toContain('Restarting the updater on 0.8.0');
    expect(startButton(html)).toMatch(/disabled/);
  });

  it('enables Start again once the updater reports the new version without a marker', () => {
    const html = render(view(null, '0.8.0'));
    expect(html).not.toContain('Restarting the updater');
    expect(startButton(html)).not.toBe('');
    expect(startButton(html)).not.toMatch(/disabled/);
  });
});

describe('restartConflictError (after the "Updater restarting" 409)', () => {
  const m: UpdaterSelfReplace = { expectedVersion: '0.8.0', fromVersion: '0.7.0', runId: 'r1', since: new Date().toISOString() };

  it('stays quiet when the fresh status carries the marker: the note says it', () => {
    expect(restartConflictError(view(m), 'the updater is restarting itself on version 0.8.0; try again in a minute')).toBeNull();
  });

  it('shows the 409 message when the marker was cleared meanwhile, or the updater does not report one', () => {
    expect(restartConflictError(view(null, '0.8.0'), 'the updater is restarting itself on version 0.8.0; try again in a minute'))
      .toBe('The updater is restarting itself on version 0.8.0; try again in a minute.');
    expect(restartConflictError(undefined, undefined)).toBe('The update could not be started.');
  });
});

describe('the run view: sub-state and stalls', () => {
  const html = (run: UpdateRun) =>
    renderToStaticMarkup(<RunView run={run} disconnected={false} reloading={false} restart={null} onDismiss={() => undefined} />);

  it('shows what the running step does', () => {
    const out = html(updateRun('waiting for the app: updating the database (0046_cover_thumbs.sql)'));
    expect(out).toContain('Restart the app, then the workers…');
    expect(out).toContain('Waiting for the app: updating the database (0046_cover_thumbs.sql).');
    expect(out).not.toContain('No progress');
  });

  it('says why a stalled step does not move, and what to do', () => {
    const out = html(updateRun('waiting for the app: it keeps restarting (last exit code 1)', CRASH_LOOP));
    expect(out).toMatch(/No progress since \d\d:\d\d/);
    expect(out).toContain('App keeps stopping (restarted 6 times, last exit code 1): Error: connect ECONNREFUSED');
    expect(out).toContain('What to do:</span> Its last lines are in the log');
    expect(out).toMatch(/tone-warn[^"]*">\s*<div><p[^>]*>No progress/);
    // patience only: the calm tone
    expect(html(updateRun('waiting for the app: database recovering', RECOVERING))).toMatch(/tone-info[^"]*">\s*<div><p[^>]*>No progress/);
  });

  it('shows neither once the run has ended', () => {
    const out = html({ ...updateRun('x', CRASH_LOOP), status: 'rolled_back', finishedAt: new Date().toISOString(), reason: 'the app did not answer healthy on 0.9.1' });
    expect(out).not.toContain('No progress');
    expect(out).not.toContain('>X.<');
  });
});
