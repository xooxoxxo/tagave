/**
 * Settings › Updates run states for stories and tests: an update to 0.9.1
 * under way, stalled, or not; and a whole 0.11.0 → 0.12.0 run second by
 * second (simulatedRun), with the sub-states the updater sends.
 */
import type { UpdateRun, UpdateStall, UpdateStep, UpdateStepId } from '@tagave/shared';

const t0 = Date.parse('2026-10-16T10:00:00Z');
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
/** A fixed "now" for a run: `s` seconds after it started. */
export const nowAt = (s: number) => t0 + s * 1000;

export function updateRun(progress: string, stall: UpdateStall | null = null): UpdateRun {
  return {
    id: 'run-1',
    from: '0.9.0',
    target: '0.9.1',
    status: 'running',
    startedAt: at(0),
    finishedAt: null,
    steps: [
      { id: 'preflight', label: 'Check the install and download the new images', status: 'done', startedAt: at(0), finishedAt: at(95) },
      { id: 'backup', label: 'Check the database before its backup', status: 'done', startedAt: at(95), finishedAt: at(97) },
      { id: 'config', label: 'Switch the configuration to the new version', status: 'done', startedAt: at(97), finishedAt: at(99) },
      { id: 'pull', label: 'Pull the images', status: 'done', startedAt: at(99), finishedAt: at(104) },
      { id: 'restart', label: 'Restart the app, then the workers', status: 'running', startedAt: at(104), finishedAt: null },
      { id: 'verify', label: 'Check every part runs the new version', status: 'pending', startedAt: null, finishedAt: null },
      { id: 'rollback', label: 'Roll back', status: 'pending', startedAt: null, finishedAt: null },
    ],
    log: [
      { at: at(104), level: 'info', message: 'Restart the app, then the workers' },
      { at: at(106), level: 'info', message: 'waiting for the new app (it backs up and updates the database before it answers)' },
      ...(stall ? [{ at: at(230), level: 'warn' as const, message: `no progress for 2 min (${progress}): ${stall.message}. ${stall.advice}` }] : []),
    ],
    reason: null,
    backup: null,
    rollback: null,
    progress: { step: 'restart', message: progress, at: at(110) },
    stall,
  };
}

export const CRASH_LOOP: UpdateStall = {
  cause: 'crash_loop',
  message: 'app keeps stopping (restarted 6 times, last exit code 1): Error: connect ECONNREFUSED 172.18.0.2:5432',
  advice: 'Its last lines are in the log (docker compose logs app). The update rolls back on its own when it runs out of time.',
  service: 'app',
  since: at(110),
};

export const RECOVERING: UpdateStall = {
  cause: 'db_recovering',
  message: 'Postgres is recovering after it was stopped uncleanly',
  advice: 'Wait: on a large database this can take several minutes. Do not restart it.',
  service: 'postgres',
  since: at(110),
};

// -- a whole run, second by second ---------------------------------------------

const LABELS: Record<UpdateStepId, string> = {
  preflight: 'Check the install and download the new images',
  backup: 'Check the database before its backup',
  config: 'Switch the configuration to the new version',
  pull: 'Pull the images',
  restart: 'Restart the app, then the workers',
  verify: 'Check every part runs the new version',
  rollback: 'Roll back',
};

/** When each step starts, and the sub-states it moves through (seconds after the start). */
const TIMELINE: Array<{ step: UpdateStepId; from: number; to: number; states: Array<[number, string]> }> = [
  {
    step: 'preflight', from: 0, to: 40, states: [
      [0, 'checking the install'],
      [3, 'checking disk space'],
      [8, 'measuring the download'],
      [10, 'downloading tagave-app, image 1 of 4 (0 MB of 480 MB)'],
      [18, 'downloading tagave-app, image 1 of 4 (212 MB of 480 MB)'],
      [26, 'downloading tagave-worker, image 2 of 4 (330 MB of 480 MB)'],
      [32, 'downloading tagave-updater, image 3 of 4 (410 MB of 480 MB)'],
      [36, 'downloading postgres, image 4 of 4 (470 MB of 480 MB)'],
    ],
  },
  { step: 'backup', from: 40, to: 44, states: [[40, 'checking the database'], [42, 'checking disk space']] },
  { step: 'config', from: 44, to: 46, states: [[44, 'switching the configuration to 0.12.0'], [45, 'checking the new configuration']] },
  { step: 'pull', from: 46, to: 49, states: [[46, 'downloading the images (0 of 5 done)'], [48, 'downloading the images (5 of 5 done)']] },
  {
    step: 'restart', from: 49, to: 80, states: [
      [49, 'stopping the workers'],
      [51, 'starting the new app'],
      [53, 'waiting for the app to answer'],
      [56, 'backing up the database (64 MB)'],
      [60, 'backing up the database (210 MB)'],
      [64, 'updating the database (0047_track_credits.sql)'],
      [70, 'waiting for the app to answer'],
      [74, 'starting the workers'],
    ],
  },
  { step: 'verify', from: 80, to: 88, states: [[80, 'checking 3 parts run 0.12.0'], [84, '2 of 3 parts run 0.12.0']] },
];
/** When the simulated run succeeds. */
export const SIMULATED_END = 88;

/**
 * The 0.11.0 → 0.12.0 run `t` seconds in, as the updater reports it:
 * done steps, the running one with its sub-state, the rest pending; at
 * SIMULATED_END or later, succeeded.
 */
export function simulatedRun(t: number): UpdateRun {
  const steps: UpdateStep[] = (Object.keys(LABELS) as UpdateStepId[]).map((id) => {
    const span = TIMELINE.find((x) => x.step === id);
    const status: UpdateStep['status'] = !span || t < span.from ? 'pending' : t >= span.to ? 'done' : 'running';
    return { id, label: LABELS[id], status, startedAt: span && t >= span.from ? at(span.from) : null, finishedAt: status === 'done' ? at(span!.to) : null };
  });
  const span = TIMELINE.find((x) => t >= x.from && t < x.to);
  const state = span ? [...span.states].reverse().find(([s]) => t >= s) : undefined;
  const ended = t >= SIMULATED_END;
  return {
    id: 'run-sim',
    from: '0.11.0',
    target: '0.12.0',
    status: ended ? 'succeeded' : 'running',
    startedAt: at(0),
    finishedAt: ended ? at(SIMULATED_END) : null,
    steps,
    log: TIMELINE.flatMap((x) => x.states.filter(([s]) => s <= t).map(([s, m]) => ({ at: at(s), level: 'info' as const, message: m }))),
    reason: null,
    backup: ended ? '/backups/tagave-2026-10-16T10-00-56Z-pre-migration.pgdump' : null,
    rollback: null,
    progress: span && state ? { step: span.step, message: state[1], at: at(state[0]) } : null,
    stall: null,
  };
}

/** The same run stuck in restart: the new app keeps stopping, 3 minutes since it last moved. */
export function stalledRun(): UpdateRun {
  const run = simulatedRun(60);
  return {
    ...run,
    progress: { step: 'restart', message: 'waiting for the app: it keeps restarting (last exit code 1)', at: at(60) },
    stall: { ...CRASH_LOOP, since: at(60) },
  };
}

/** The same run rolled back: the new app did not answer, nothing in the database changed. */
export function rolledBackRun(): UpdateRun {
  const run = simulatedRun(70);
  const end = 400;
  return {
    ...run,
    status: 'rolled_back',
    finishedAt: at(end),
    steps: run.steps.map((s) =>
      s.id === 'restart' ? { ...s, status: 'failed', finishedAt: at(350) }
        : s.id === 'verify' ? { ...s, status: 'skipped' }
          : s.id === 'rollback' ? { ...s, status: 'done', startedAt: at(350), finishedAt: at(end) } : s),
    reason: 'the app did not answer healthy on 0.12.0: the app does not answer',
    rollback: { version: '0.11.0', restoredDatabase: false, healthy: true },
    progress: null,
  };
}

/** Preflight refused: not enough disk space; nothing changed. */
export function didNotStartRun(): UpdateRun {
  const run = simulatedRun(5);
  return {
    ...run,
    status: 'failed',
    finishedAt: at(6),
    steps: run.steps.map((s) => (s.id === 'preflight' ? { ...s, status: 'failed', finishedAt: at(6) } : s.id === 'rollback' ? s : { ...s, status: 'skipped' })),
    reason: "not enough free disk space: Docker's data on /var/lib/docker has 2.1 GB free and the update needs 5.6 GB. Free at least 3.5 GB",
    progress: null,
  };
}
