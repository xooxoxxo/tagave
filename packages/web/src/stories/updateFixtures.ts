/** Settings › Updates run states for stories and tests: an update to 0.9.1 under way, stalled, or not. */
import type { UpdateRun, UpdateStall } from '@tagave/shared';

const t0 = Date.parse('2026-10-16T10:00:00Z');
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

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
