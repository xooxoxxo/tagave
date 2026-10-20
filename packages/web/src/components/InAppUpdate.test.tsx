/**
 * Settings › Updates while the updater restarts itself on the new version:
 * the note shows and the Start button stays disabled until it is back.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReleaseNote, UpdateRun, UpdaterSelfReplace, UpdaterView } from '@tagave/shared';
import { InAppUpdate, RunView, restartConflictError, showRun } from './InAppUpdate';
import { CRASH_LOOP, RECOVERING, SIMULATED_END, didNotStartRun, nowAt, rolledBackRun, simulatedRun, stalledRun, updateRun } from '../stories/updateFixtures';

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
  const html = (run: UpdateRun, now = nowAt(240)) =>
    renderToStaticMarkup(<RunView run={run} now={now} disconnected={false} reloading={false} restart={null} onDismiss={() => undefined} />);
  /** The card above the log (the log repeats every line the updater wrote). */
  const card = (out: string) => out.slice(0, out.indexOf('<details'));
  const items = (out: string) => [...out.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]!);

  it('shows what the running step does, once, and never its label twice', () => {
    const out = html(updateRun('waiting for the app: updating the database (0046_cover_thumbs.sql)'));
    expect(out).toContain('Waiting for the app: updating the database (0046_cover_thumbs.sql)');
    expect(card(out).split('Restart the app, then the workers').length - 1).toBe(1);
    expect(out).not.toContain('Restart the app, then the workers…');
    expect(out).not.toContain('Stuck');
  });

  it('hides the line when an older updater sends the step label as the sub-state', () => {
    const out = html({ ...updateRun('restart the app, then the workers') });
    expect(card(out).split(/restart the app, then the workers/i).length - 1).toBe(1);
  });

  it('lists only the steps that have started: done, then the running one, nothing after', () => {
    const at18 = items(html(simulatedRun(18), nowAt(18)));
    expect(at18).toHaveLength(1);
    expect(at18[0]).toContain('Check the install and download the new images');
    expect(at18[0]).toContain('Downloading tagave-app, image 1 of 4 (212 MB of 480 MB)');
    expect(at18[0]).toContain('0:18');
    const at60 = items(html(simulatedRun(60), nowAt(60)));
    expect(at60.map((li) => /visually-hidden">(\w+)</.exec(li)?.[1])).toEqual(['done', 'done', 'done', 'done', 'running']);
    expect(at60[4]).toContain('Backing up the database (210 MB)');
    // only the running step has a line under it
    expect(at60.filter((li) => li.includes('stepNote'))).toHaveLength(1);
  });

  it('says how long a stalled step has been stuck and why, with what to do', () => {
    const out = html(stalledRun(), nowAt(240));
    expect(out).toContain('Stuck 3 min: App keeps stopping (restarted 6 times, last exit code 1): Error: connect ECONNREFUSED');
    expect(out).toContain('Its last lines are in the log');
    expect(out).toMatch(/note-warn/);
    expect(out).not.toContain('Waiting for the app: it keeps restarting');
    // patience only: the calm tone
    expect(html(updateRun('waiting for the app: database recovering', RECOVERING), nowAt(300))).toMatch(/note-live[^"]*"><span[^>]*>Stuck 3 min: Postgres is recovering/);
  });

  it('keeps every done step on success, without a line under any', () => {
    const out = html(simulatedRun(SIMULATED_END), nowAt(SIMULATED_END));
    expect(out).toContain('Updated to 0.12.0');
    const li = items(out);
    expect(li).toHaveLength(6);
    expect(li.every((x) => x.includes('✓'))).toBe(true);
    expect(out).not.toContain('stepNote');
  });

  it('puts the reason under the step that failed, not in the head too, and shows no step that never ran', () => {
    const out = html(rolledBackRun(), nowAt(400));
    const li = items(out);
    expect(li.map((x) => /visually-hidden">(\w+)</.exec(x)?.[1])).toEqual(['done', 'done', 'done', 'done', 'failed', 'done']);
    expect(li[4]).toContain('The app did not answer healthy on 0.12.0: the app does not answer');
    expect(card(out).split('did not answer healthy').length - 1).toBe(1);
    expect(out).toContain('The database was not changed.');
    const refused = html(didNotStartRun(), nowAt(6));
    expect(items(refused)).toHaveLength(1);
    expect(refused).toContain('Not enough free disk space');
  });

  it('shows no stall once the run has ended', () => {
    const out = html({ ...updateRun('x', CRASH_LOOP), status: 'rolled_back', finishedAt: new Date().toISOString(), reason: 'the app did not answer healthy on 0.9.1' });
    expect(out).not.toContain('Stuck');
    expect(out).not.toContain('>X<');
  });
});

describe('a finished run on the card', () => {
  const finished = (status: UpdateRun['status']): UpdateRun => ({ ...updateRun('x'), status, target: '0.8.0', finishedAt: new Date().toISOString(), progress: null, reason: status === 'succeeded' ? null : 'the app did not answer healthy' });
  const withRun = (run: UpdateRun, runSettled: boolean): UpdaterView => ({ ...view(null, '0.8.0'), updater: { ...view(null, '0.8.0').updater!, run }, runSettled });

  it('goes away on its own once the api calls it settled, and the newer release is offered', () => {
    const html = render(withRun(finished('succeeded'), true));
    expect(html).not.toContain('Updated to 0.8.0');
    expect(html).not.toContain('>Done<');
    expect(startButton(html)).not.toBe('');
  });

  it('stays, with Done, when the success is not settled (the app does not run it yet)', () => {
    const html = render(withRun(finished('succeeded'), false));
    expect(html).toContain('Updated to 0.8.0');
    expect(html).toContain('>Done<');
  });

  it('keeps every run that needs attention until Done', () => {
    for (const status of ['failed', 'rolled_back', 'rollback_failed', 'interrupted'] as const) {
      const html = render(withRun(finished(status), true));
      expect(html, status).toContain('>Done<');
      expect(html, status).not.toContain('Updated to');
    }
  });

  it('shows a settled success only in the tab that watched it finish, and never a dismissed run', () => {
    const ok = finished('succeeded');
    expect(showRun(ok, true, null, null)).toBe(false);
    expect(showRun(ok, true, null, ok.id)).toBe(true);
    expect(showRun(ok, false, null, null)).toBe(true);
    expect(showRun(ok, false, ok.id, null)).toBe(false);
    expect(showRun(finished('rolled_back'), true, null, null)).toBe(true);
    // an older dismissal does not hide a newer run
    expect(showRun({ ...finished('failed'), id: 'run-2' }, false, 'run-1', null)).toBe(true);
  });
});
