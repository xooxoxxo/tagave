import type { BuildInfoView, WorkerVersion } from '@tagave/shared';

/** Settings › Updates, Running now: the app and two workers, one still on the build before. */
export const APP_BUILD: BuildInfoView = { version: '0.22.0', sha: '7344fde96e70555f7245ddcc14e227a67a9ef926', builtAt: '2026-11-04T10:12:00Z', source: 'env' };

export const WORKER_SAME: WorkerVersion = {
  workerId: 'worker-files', version: '0.22.0', sha: APP_BUILD.sha, builtAt: APP_BUILD.builtAt,
  queues: ['*'], host: 'files', lastSeenAt: '2026-11-04T11:59:40Z', loopLagMs: 4,
};

export const WORKER_OLD: WorkerVersion = {
  workerId: 'worker-nas', version: '0.21.0', sha: '64cdc489a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5', builtAt: '2026-10-30T08:40:00Z',
  queues: ['scan.root', 'scan.dir', 'tags.apply'], host: 'nas', lastSeenAt: '2026-11-04T11:59:52Z', loopLagMs: 7,
};
