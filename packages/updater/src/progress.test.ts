import { describe, expect, it } from 'vitest';
import {
  PullProgress,
  appPhase,
  ComposePullProgress,
  MAX_PARTIAL_LINE,
  diagnoseStall,
  lastErrorLine,
  parseInspect,
  parseSize,
  postgresRecovering,
  stallNeedsAction,
  waitingFor,
  type ContainerState,
  type Observation,
  type Readings,
} from './progress.js';

const MB = 1e6;
const L = (hex: string, size: number) => ({ digest: `sha256:${hex.padEnd(64, '0')}`, size });

describe('download progress', () => {
  it('reads docker sizes', () => {
    expect(parseSize('12.3MB')).toBe(12_300_000);
    expect(parseSize('512kB')).toBe(512_000);
    expect(parseSize('1.1GB')).toBe(1_100_000_000);
    expect(parseSize('lots')).toBeNull();
  });

  it('counts finished layers against the sizes the registry gave, over every image', () => {
    const p = new PullProgress();
    p.beginImage(1, 2, [L('aaaaaaaaaaaa', 300 * MB), L('bbbbbbbbbbbb', 100 * MB)]);
    expect(p.summary()).toBe('downloading image 1 of 2 (0 MB of 381 MB)');
    expect(p.feed('ref@sha256:x: Pulling from xooxoxxo/tagave-app\naaaaaaaaaaaa: Pulling fs layer\nbbbbbbbbbbbb: Already exists\n')).toBe(true);
    expect(p.summary()).toBe('downloading image 1 of 2 (0 MB of 286 MB)');
    p.feed('aaaaaaaaaaaa: Download complete\n');
    expect(p.summary()).toBe('downloading image 1 of 2 (286 MB of 286 MB)');
    // the second image shares a layer with the first: counted once
    p.beginImage(2, 2, [L('aaaaaaaaaaaa', 300 * MB), L('cccccccccccc', 900 * MB)]);
    p.feed('cccccccccccc: Downloading [=====>    ] 450MB/900MB\r');
    p.feed('\n');
    expect(p.summary()).toBe('downloading image 2 of 2 (715 MB of 1.1 GB)');
    expect(p.feed('cccccccccccc: Pull complete\n')).toBe(true);
    expect(p.summary()).toBe('downloading image 2 of 2 (1.1 GB of 1.1 GB)');
  });

  it('counts layers when the registry gave no sizes, and keeps a split line', () => {
    const p = new PullProgress();
    p.beginImage(3, 4, null);
    p.feed('aaaaaaaaaaaa: Pulling fs layer\nbbbbbbbbbbbb: Pulling fs layer\naaaaaaaaaaaa: Pull comp');
    expect(p.summary()).toBe('downloading image 3 of 4 (0 of 2 layers)');
    p.feed('lete\n');
    expect(p.summary()).toBe('downloading image 3 of 4 (1 of 2 layers)');
  });

  it('counts the services compose has pulled', () => {
    const c = new ComposePullProgress(4);
    expect(c.feed(' app Pulling \n app Pul')).toBe(false);
    expect(c.feed('led \n ✔ worker-files Pulled\n app Pulled\n')).toBe(true);
    expect(c.summary()).toBe('downloading the images (2 of 4 done)');
  });

  it('keeps no more than a bounded partial line, however much comes without a newline', () => {
    const p = new PullProgress();
    p.beginImage(1, 1, null);
    for (let i = 0; i < 1000; i++) p.feed('x'.repeat(10_000));
    expect((p as unknown as { rest: string }).rest.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE);
    const c = new ComposePullProgress(1);
    for (let i = 0; i < 1000; i++) c.feed('y'.repeat(10_000));
    expect((c as unknown as { rest: string }).rest.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE);
  });
});

const state = (over: Partial<ContainerState> = {}): ContainerState => ({
  status: 'running',
  restarting: false,
  oomKilled: false,
  exitCode: 0,
  error: '',
  health: null,
  healthLog: null,
  restarts: 0,
  ...over,
});
const obs = (service: string, over: Partial<ContainerState> | null = {}, logs = '', restartsBefore = 0): Observation => ({
  service,
  state: over === null ? null : state(over),
  logs,
  restartsBefore,
});
const readings = (observations: Observation[], dockerFreeBytes: number | null = 50e9, commandOutput?: string): Readings => ({
  observations,
  dockerFreeBytes,
  ...(commandOutput !== undefined ? { commandOutput } : {}),
});
const stall = (r: Readings, downloading = false) => diagnoseStall(r, { progress: 'waiting for the app', stalledMs: 120_000, since: '2026-10-16T10:00:00.000Z', downloading });

describe('containers', () => {
  it('reads docker inspect', () => {
    const out = '{"Status":"restarting","Running":false,"Restarting":true,"OOMKilled":false,"ExitCode":1,"Error":"","Health":{"Status":"unhealthy","Log":[{"Output":"curl: (7) refused\\n"}]}}|4\n';
    expect(parseInspect(out)).toEqual({ status: 'restarting', restarting: true, oomKilled: false, exitCode: 1, error: '', health: 'unhealthy', healthLog: 'curl: (7) refused', restarts: 4 });
    expect(parseInspect('Error: No such object')).toBeNull();
  });

  it('tells Postgres recovering from Postgres ready again', () => {
    const rec = 'LOG:  database system was interrupted; last known up at 2026-10-16\nLOG:  redo starts at 0/1A2B';
    expect(postgresRecovering(rec)).toBe(true);
    expect(postgresRecovering(`${rec}\nLOG:  database system is ready to accept connections`)).toBe(false);
  });

  it('says what the app does from its log', () => {
    expect(appPhase('backing up the database to /backups before applying 3 migration(s)...')).toBe('backing up the database before 3 database updates');
    expect(appPhase('backup written /backups/x.pgdump\napplying 0046_cover_thumbs.sql...')).toBe('updating the database (0046_cover_thumbs.sql)');
    expect(appPhase('{"level":30,"msg":"listening"}')).toBeNull();
  });

  it('picks the line worth showing', () => {
    expect(lastErrorLine('starting\nError: connect ECONNREFUSED 10.0.0.2:5432\nretrying')).toBe('Error: connect ECONNREFUSED 10.0.0.2:5432');
    expect(lastErrorLine('a\nb')).toBe('b');
    expect(lastErrorLine('')).toBeNull();
  });

  it('gives the sub-state while waiting for the app', () => {
    expect(waitingFor(readings([obs('app', {}, 'applying 0046_cover_thumbs.sql...'), obs('postgres')]))).toBe('updating the database (0046_cover_thumbs.sql)');
    expect(waitingFor(readings([obs('app'), obs('postgres', {}, 'LOG:  redo starts at 0/1')]))).toBe('database recovering');
    expect(waitingFor(readings([obs('app'), obs('postgres', {}, 'PANIC:  could not write to file "pg_wal/xlogtemp.1": No space left on device')]))).toBe('no space left on device');
    expect(waitingFor(readings([obs('app', { restarts: 3, exitCode: 1 }, '', 1)]))).toBe('it keeps restarting (last exit code 1)');
    expect(waitingFor(readings([obs('app', { status: 'created' })]))).toBe('its container is created');
    expect(waitingFor(readings([obs('app')], 100 * 1024 ** 2))).toBe('no space left on device');
    expect(waitingFor(readings([obs('app')]))).toBeNull();
  });
});

describe('stalls', () => {
  it('finds a full disk first', () => {
    const s = stall(readings([obs('app', { restarts: 5 }, 'x', 0), obs('postgres', {}, 'FATAL:  could not extend file "base/16384/2619": No space left on device')]));
    expect(s.cause).toBe('disk_full');
    expect(s.service).toBe('postgres');
    expect(s.message).toBe('postgres has no space left on its disk');
    expect(s.advice).toMatch(/docker builder prune/);
    expect(stall(readings([], 10 * 1024 ** 2), true).message).toBe("Docker's disk is full (10 MB free)");
    expect(stall(readings([], null, 'write /var/lib/docker/tmp/x: no space left on device'), true).cause).toBe('disk_full');
  });

  it('finds a container killed for memory', () => {
    const s = stall(readings([obs('app', { oomKilled: true, exitCode: 137, status: 'exited' })]));
    expect(s.cause).toBe('oom');
    expect(s.message).toBe('app was stopped for using too much memory');
  });

  it('finds a port that is taken', () => {
    const s = stall(readings([obs('app', { status: 'created', error: 'driver failed programming external connectivity: Bind for 0.0.0.0:3100 failed: port is already allocated' })]));
    expect(s.cause).toBe('port_conflict');
    expect(s.advice).toMatch(/TAGAVE_PORT/);
  });

  it('finds a refused migration', () => {
    const s = stall(readings([obs('app', { restarts: 2 }, 'Not migrating: the backup before migrating failed (pg_dump: error). Nothing was changed.', 0)]));
    expect(s.cause).toBe('migration_refused');
    expect(s.message).toMatch(/^the new app refuses to update the database: the backup before migrating failed/);
  });

  it('finds a crash loop by the restart count rising', () => {
    const s = stall(readings([obs('app', { restarts: 4, exitCode: 1, status: 'restarting', restarting: true }, 'Error: Cannot find module x', 1)]));
    expect(s.cause).toBe('crash_loop');
    expect(s.message).toBe('app keeps stopping (restarted 3 times, last exit code 1): Error: Cannot find module x');
  });

  it('finds a failing health check', () => {
    const s = stall(readings([obs('app', { health: 'unhealthy', healthLog: 'wget: server returned error: HTTP/1.1 503' })]));
    expect(s.cause).toBe('unhealthy');
    expect(s.message).toBe('app fails its health check: wget: server returned error: HTTP/1.1 503');
  });

  it('asks for patience while Postgres recovers, or when nothing is wrong', () => {
    const rec = stall(readings([obs('app'), obs('postgres', {}, 'LOG:  database system was not properly shut down; automatic recovery in progress')]));
    expect(rec.cause).toBe('db_recovering');
    expect(stallNeedsAction(rec.cause)).toBe(false);
    const slow = stall(readings([obs('app', {}, 'applying 0046_cover_thumbs.sql...')]));
    expect(slow).toEqual({
      cause: 'slow',
      message: 'no progress for 2 minutes, and nothing looks wrong: waiting for the app',
      advice: expect.stringMatching(/^Wait/),
      service: null,
      since: '2026-10-16T10:00:00.000Z',
    });
  });

  it('blames the download when a pull does not move', () => {
    const s = stall(readings([]), true);
    expect(s.cause).toBe('download');
    expect(stallNeedsAction(s.cause)).toBe(true);
  });
});
