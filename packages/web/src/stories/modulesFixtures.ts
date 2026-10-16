/** Settings › Modules states for stories and tests: the player and a second module. */
import type { ModuleRun, ModuleStatus, ModulesView } from '@tagave/shared';

export const PLAYER: ModuleStatus = {
  id: 'player',
  name: 'Player',
  purpose: 'Plays your albums in tagave and serves phone apps, with a bundled Navidrome.',
  state: 'off',
  estimate: { memoryMb: 512, diskMb: 260 },
  keepsOnRemoval: "Navidrome's database (its plays, stars and users) in the player-data volume",
  roles: ['all'],
  downloadBytes: null,
  available: true,
  reason: null,
  lastError: null,
};

export const DUMMY: ModuleStatus = {
  id: 'dummy',
  name: 'Dummy',
  purpose: 'A test module that runs one idle container.',
  state: 'on',
  estimate: { memoryMb: 16, diskMb: 10 },
  keepsOnRemoval: 'its dummy-data volume',
  roles: ['all', 'app'],
  downloadBytes: null,
  available: true,
  reason: null,
  lastError: null,
};

export const BASE_VIEW: ModulesView = { mode: 'updater', error: null, version: '0.9.2', verified: true, problem: null, modules: [PLAYER, DUMMY], run: null, role: 'all' };

const t0 = Date.parse('2026-10-16T10:00:00Z');
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

export function playerRun(status: ModuleRun['status'], reason: string | null = null): ModuleRun {
  const done = status !== 'running';
  const steps: ModuleRun['steps'] = [
    { id: 'preflight', label: 'Check the release signature, the disk and download the images', status: 'done', startedAt: at(0), finishedAt: at(14) },
    { id: 'config', label: 'Add its settings to the configuration', status: 'done', startedAt: at(14), finishedAt: at(15) },
    { id: 'start', label: 'Start it', status: done ? 'done' : 'running', startedAt: at(15), finishedAt: done ? at(41) : null },
    { id: 'verify', label: 'Check it runs and reports healthy', status: status === 'succeeded' ? 'done' : status === 'running' ? 'pending' : 'failed', startedAt: done ? at(41) : null, finishedAt: done ? at(161) : null },
    { id: 'rollback', label: 'Roll back', status: status === 'rolled_back' ? 'done' : status === 'running' ? 'pending' : 'skipped', startedAt: status === 'rolled_back' ? at(161) : null, finishedAt: status === 'rolled_back' ? at(190) : null },
  ];
  return {
    id: `run-${status}`,
    kind: 'module',
    module: 'player',
    moduleName: 'Player',
    action: 'enable',
    deleteData: false,
    version: '0.9.2',
    status,
    startedAt: at(0),
    finishedAt: done ? at(status === 'rolled_back' ? 190 : 161) : null,
    steps,
    log: [
      { at: at(0), level: 'info', message: 'Check the release signature, the disk and download the images' },
      { at: at(1), level: 'info', message: 'player from the signed catalogue of 0.9.2 (key 3f0c9a1e5b7d2c44); images for linux/arm64' },
      { at: at(13), level: 'info', message: '$ docker pull deluan/navidrome:0.64.0@sha256:4e1c…' },
      { at: at(20), level: 'info', message: 'waiting: the app does not answer' },
      ...(reason ? [{ at: at(161), level: 'error' as const, message: reason }] : []),
    ],
    reason,
  };
}
