/**
 * The folder watch against a real database (vault "tagave - Offline Library
 * Spec", "The folder watch"): fake port, probe, mount table and clock. The
 * shared test database may hold enabled roots other suites left behind, so
 * each check looks only at this suite's roots, probes and sends.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { files, libraries, makeDb, recordReach, rootsToWatch, scanRoots, users } from '@tagave/db';
import type { WorkerContext } from '../context.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileGate, setFileGate } from '../fileGate.js';
import { gateProbe } from './probe.js';
import type { ProbeOutcome } from './reach.js';
import { FolderWatch, folderWatch, startFolderWatch } from './watch.js';

const FAKE = fileURLToPath(new URL('../../testkit/fakeHelper.mjs', import.meta.url));

/** This process's fake helpers still running. */
function fakeHelperPids(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'fakeHelper.mjs'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const TAG = `offlinetest-${randomBytes(3).toString('hex')}`;
const ENV = { TAGAVE_MUSIC_NAME: 'music' };
const PATH_A = `/mnt/music/${TAG}`;
const REAL_A = `/mnt/.host/music/${TAG}`;
const PATH_B = `/mnt/music/${TAG}-b`;
const REAL_B = `/mnt/.host/music/${TAG}-b`;

function mountLine(mountPoint: string, fstype: string, source: string): string {
  return `36 25 0:52 / ${mountPoint} rw,relatime shared:1 - ${fstype} ${source} rw,hard\n`;
}
const BASE_INFO = mountLine('/', 'overlay', 'overlay') + mountLine('/mnt/.host', 'ext4', '/dev/sda1');
const NFS_INFO = BASE_INFO + mountLine('/mnt/.host/music', 'nfs4', '192.0.2.10:/export/music');
const LOCAL_INFO = BASE_INFO + mountLine(REAL_A, 'ext4', '/dev/sdb1') + mountLine(REAL_B, 'ext4', '/dev/sdc1');

const T0 = new Date('2026-11-24T10:00:00Z');
const T1 = new Date('2026-11-24T14:00:00Z');
const T2 = new Date('2026-11-24T14:00:30Z');
const T3 = new Date('2026-11-24T14:01:00Z');
const T4 = new Date('2026-11-24T14:01:30Z');

const LISTING: ProbeOutcome = { kind: 'listing', empty: false, knownFound: 1, knownAsked: 1, isMountPoint: false, wasMountPoint: false };
/** The root lists, but none of the files the library knows are there. */
const NONE_KNOWN = (empty: boolean): ProbeOutcome => ({ kind: 'listing', empty, knownFound: 0, knownAsked: 1, isMountPoint: false, wasMountPoint: false });
const flush = () => new Promise((resolve) => setTimeout(resolve, 200));

describe.skipIf(!process.env.TEST_DATABASE_URL)('folder watch (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const send = vi.fn(async (..._args: unknown[]) => 'job-id');
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const rootB = randomUUID();
  let now = T1;
  const clock = () => now;

  const reach = async (id: string) =>
    (await db.select({ reach: scanRoots.reach, reach_reason: scanRoots.reachReason, reach_since: scanRoots.reachSince, reach_checked_at: scanRoots.reachCheckedAt })
      .from(scanRoots).where(eq(scanRoots.id, id)))[0] as { reach: string; reach_reason: string | null; reach_since: Date | null; reach_checked_at: Date | null };
  /** This suite's calls of a probe spy, by the real path probed. */
  const probesOf = (spy: { mock: { calls: unknown[][] } }, real = REAL_A) => spy.mock.calls.filter((c) => c[1] === real);
  const sendsFor = (id: string) => send.mock.calls.filter((c) => (c[1] as { scanRootId?: string })?.scanRootId === id);
  const setReach = (id: string, r: string, reason: string | null, since: Date | null) =>
    client`update scan_roots set reach = ${r}, reach_reason = ${reason}, reach_since = ${since?.toISOString() ?? null}::timestamptz, reach_checked_at = null where id = ${id}`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: userId, email: `fw-${userId}@example.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'FolderWatch', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: PATH_A, displayName: 'Robin music', writable: false });
    await db.insert(files).values({ handler: 'audio', id: randomUUID(), libraryId, scanRootId: rootId, relPath: 'Jazz/1.flac', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
  });

  beforeEach(async () => {
    send.mockClear();
    now = T1;
    await setReach(rootId, 'online', null, T0);
    await db.delete(scanRoots).where(eq(scanRoots.id, rootB));
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades roots and files
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('a silent share makes the root offline after two ticks, and its path is never probed', async () => {
    const probeSpy = vi.fn(async (): Promise<ProbeOutcome> => LISTING);
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => NFS_INFO, port: async () => false, probe: probeSpy, now: clock });
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'offline', reason: 'server_silent' });
    expect((await reach(rootId)).reach).toBe('online'); // was online from the fixture
    expect((await reach(rootId)).reach_checked_at).not.toBeNull();
    now = T2;
    await w.tick();
    expect(await reach(rootId)).toMatchObject({ reach: 'offline', reach_reason: 'server_silent', reach_since: T2 });
    expect(probesOf(probeSpy)).toHaveLength(0);
  });

  it('keeps its since time across ticks and restarts, and keeps the reason true', async () => {
    const silent = { ctx, env: ENV, readMountinfo: async () => NFS_INFO, port: async () => false, probe: vi.fn(async () => LISTING), now: clock };
    const w = new FolderWatch(silent);
    await w.tick();
    now = T2;
    await w.tick();
    now = T3;
    await w.tick();
    expect(await reach(rootId)).toMatchObject({ reach: 'offline', reach_since: T2 });
    now = T4;
    await new FolderWatch(silent).tick();
    expect(await reach(rootId)).toMatchObject({ reach: 'offline', reach_reason: 'server_silent', reach_since: T2 });
    expect((await rootsToWatch(client)).find((r) => r.id === rootId)).toMatchObject({ reach: 'offline', reachSince: T2, known: ['Jazz/1.flac'] });
    // the server answers again but the folder does not: still offline, since unchanged, the reason follows
    await new FolderWatch({ ...silent, port: async () => true, probe: vi.fn(async (): Promise<ProbeOutcome> => ({ kind: 'deadline' })) }).tick();
    expect(await reach(rootId)).toMatchObject({ reach: 'offline', reach_reason: 'timeout', reach_since: T2 });
  });

  it('a probe that meets a closed gate (shutdown) records no reading for that root', async () => {
    const closed = vi.fn(async (): Promise<ProbeOutcome> => { throw Object.assign(new Error('The file gate is closed'), { code: 'EGATECLOSED' }); });
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, probe: closed, now: clock });
    expect((await w.tick()).has(rootId)).toBe(false);
    expect(probesOf(closed)).toHaveLength(1);
    expect(await reach(rootId)).toMatchObject({ reach: 'online', reach_reason: null, reach_checked_at: null });
  });

  it('coming back queues one scan: quick after offline, full after not connected', async () => {
    const back = { ctx, env: ENV, readMountinfo: async () => NFS_INFO, port: async () => true, probe: vi.fn(async () => LISTING), now: clock };
    await setReach(rootId, 'offline', 'server_silent', T0);
    const w = new FolderWatch(back);
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    expect(await reach(rootId)).toMatchObject({ reach: 'online', reach_reason: null, reach_since: T1 });
    expect(sendsFor(rootId)).toEqual([['scan.root', { scanRootId: rootId, mode: 'quick' }, { singletonKey: `scan:${rootId}` }]]);
    await w.tick(); // still online: nothing more
    expect(sendsFor(rootId)).toHaveLength(1);

    send.mockClear();
    await setReach(rootId, 'unmounted', 'not_mounted', T0);
    await new FolderWatch(back).tick();
    expect(sendsFor(rootId)).toEqual([['scan.root', { scanRootId: rootId, mode: 'full' }, { singletonKey: `scan:${rootId}` }]]);

    send.mockClear();
    await setReach(rootId, 'unknown', null, null);
    await new FolderWatch(back).tick(); // a first reading is not a return
    expect(await reach(rootId)).toMatchObject({ reach: 'online', reach_since: T1 });
    expect(sendsFor(rootId)).toHaveLength(0);
  });

  it('never runs two probes of one root at once', async () => {
    const never = () => new Promise<ProbeOutcome>(() => {});
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, probe: vi.fn(never) });
    void w.tick(); void w.tick(); await flush();
    w.suspect(rootId); await flush();
    expect(probesOf(w['deps'].probe as any)).toHaveLength(1);
  });

  it('a hung probe does not hold up another root or the next tick', async () => {
    await db.insert(scanRoots).values({ id: rootB, libraryId, path: PATH_B, displayName: 'Robin B', writable: false });
    const probe = vi.fn((_id: string, dir: string) => (dir === REAL_A ? new Promise<ProbeOutcome>(() => {}) : Promise.resolve(LISTING)));
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, probe, now: clock }, { everyMs: 50 });
    w.start();
    await flush(); await flush();
    w.stop();
    expect(probesOf(probe, REAL_A)).toHaveLength(1);
    expect(probesOf(probe, REAL_B).length).toBeGreaterThanOrEqual(3);
    expect(await reach(rootB)).toMatchObject({ reach: 'online', reach_since: T1 });
  });

  it('a root that is not on a share is probed and read online', async () => {
    await setReach(rootId, 'unknown', null, null);
    const port = vi.fn(async () => true);
    const probe = vi.fn(async (): Promise<ProbeOutcome> => LISTING);
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, port, probe, now: clock });
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    expect(probesOf(probe)).toEqual([[rootId, REAL_A, ['Jazz/1.flac']]]);
    expect(port).not.toHaveBeenCalled();
    expect(await reach(rootId)).toMatchObject({ reach: 'online', reach_reason: null, reach_since: T1 });
  });

  it('a mount point seen once and then gone reads as not connected', async () => {
    let info = LOCAL_INFO;
    let seen: ProbeOutcome = LISTING;
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => info, probe: vi.fn(async () => seen), now: clock });
    await w.tick();
    info = BASE_INFO; // the folder's own mount is gone: the folder underneath has none of the known files
    seen = NONE_KNOWN(false);
    now = T2;
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'unmounted', reason: 'not_mounted' });
    now = T3;
    await w.tick();
    expect(await reach(rootId)).toMatchObject({ reach: 'unmounted', reach_reason: 'not_mounted', reach_since: T3 });
  });

  it('with no mount table (not Linux), a root is probed as a local folder', async () => {
    const probe = vi.fn(async (): Promise<ProbeOutcome> => LISTING);
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => { throw new Error('ENOENT'); }, probe, now: clock });
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    expect(probesOf(probe)).toHaveLength(1);
  });

  it('a mount table it cannot read is no lost mount point: the rule waits for the next table', async () => {
    let info: string | null = LOCAL_INFO;
    let seen: ProbeOutcome = LISTING;
    const readMountinfo = async () => { if (info === null) throw new Error('EACCES'); return info; };
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo, probe: vi.fn(async () => seen), now: clock });
    await w.tick(); // a mount point of its own
    info = null;
    seen = NONE_KNOWN(false);
    now = T2;
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    now = T3;
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    expect(await reach(rootId)).toMatchObject({ reach: 'online', reach_reason: null, reach_since: T0 });
    // the table is back and the mount is not: the mount point seen before still counts
    info = BASE_INFO;
    now = T4;
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'unmounted', reason: 'not_mounted' });
  });

  it('a missing root reads offline, never not connected (no remount for a renamed folder)', async () => {
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, probe: vi.fn(async (): Promise<ProbeOutcome> => ({ kind: 'error', code: 'ENOENT' })), now: clock });
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'offline', reason: 'io_error' });
    now = T2;
    await w.tick();
    expect(await reach(rootId)).toMatchObject({ reach: 'offline', reach_reason: 'io_error', reach_since: T2 });
  });

  it('a root that lists but has none of its sampled files stays online', async () => {
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, probe: vi.fn(async () => NONE_KNOWN(false)), now: clock });
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    now = T2;
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    expect(await reach(rootId)).toMatchObject({ reach: 'online', reach_reason: null, reach_since: T0 });
  });

  it('an empty root with none of its known files is not connected', async () => {
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => BASE_INFO, probe: vi.fn(async () => NONE_KNOWN(true)), now: clock });
    await w.tick();
    now = T2;
    expect((await w.tick()).get(rootId)).toEqual({ reach: 'unmounted', reason: 'empty' });
    expect(await reach(rootId)).toMatchObject({ reach: 'unmounted', reach_reason: 'empty', reach_since: T2 });
  });

  it('skips a full tick while an earlier one still waits for its roots, but never waits on a probe', async () => {
    const waiting: Array<() => void> = [];
    let slow = true;
    const roots = vi.fn(async (sql: Parameters<typeof rootsToWatch>[0]) => {
      if (slow) await new Promise<void>((done) => { waiting.push(done); });
      return rootsToWatch(sql);
    });
    const probe = vi.fn(() => new Promise<ProbeOutcome>(() => {})); // every probe hangs
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, probe, now: clock, roots });
    const first = w.tick();
    expect((await w.tick()).size).toBe(0); // skipped: the first still waits for the database
    expect(roots).toHaveBeenCalledTimes(1);
    w.suspect(rootId); // a check of one root is not skipped
    expect(roots).toHaveBeenCalledTimes(2);
    slow = false;
    for (const done of waiting) done();
    await flush();
    void first;
    // the first tick's probe hangs, yet the next full tick loads its roots again
    void w.tick();
    await flush();
    expect(roots).toHaveBeenCalledTimes(3);
    expect(probesOf(probe)).toHaveLength(1);
  });
  it('a failed write loses no change: the next tick writes it, and queues the scan then', async () => {
    await setReach(rootId, 'offline', 'server_silent', T0);
    let fail = 1;
    const record = vi.fn(async (...args: Parameters<typeof recordReach>) => {
      if (args[1] === rootId && fail-- > 0) throw new Error('database unavailable');
      return recordReach(...args);
    });
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => NFS_INFO, port: async () => true, probe: vi.fn(async () => LISTING), now: clock, record });
    expect((await w.tick()).has(rootId)).toBe(false); // the check failed
    expect(await reach(rootId)).toMatchObject({ reach: 'offline', reach_since: T0 });
    expect(sendsFor(rootId)).toHaveLength(0);
    now = T2;
    await w.tick();
    expect(await reach(rootId)).toMatchObject({ reach: 'online', reach_reason: null, reach_since: T2 });
    expect(sendsFor(rootId)).toEqual([['scan.root', { scanRootId: rootId, mode: 'quick' }, { singletonKey: `scan:${rootId}` }]]);
  });

  it('probes through the gate past its stuck cap: a deadline reads offline, the next answer online', async () => {
    // The gate's own rule (fileGate.test.ts): while the root's last probe helper is stuck, a probe reads a deadline and forks nothing.
    // kill: a no-op, so the helper given up on stays, as one stuck in the kernel does, until the test kills it
    const gate = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 1_500, helpers: 2, stuckMax: 1 }, kill: () => undefined });
    let dead = true;
    const probe = vi.fn((id: string, dir: string, known: string[]) => gateProbe(gate, id, dir === REAL_A && dead ? 'stuck' : 'ok', known.map(() => 'ok')));
    const w = new FolderWatch({ ctx, env: ENV, readMountinfo: async () => LOCAL_INFO, probe, now: clock });
    try {
      expect((await w.tick()).get(rootId)).toEqual({ reach: 'offline', reason: 'timeout' });
      expect(gate.refuses(rootId)).toBe(true); // at the cap: the gate takes no other work for the root
      dead = false;
      // the kernel lets the stuck helper go
      for (const pid of fakeHelperPids()) process.kill(Number(pid), 'SIGKILL');
      await flush();
      now = T2;
      expect((await w.tick()).get(rootId)).toEqual({ reach: 'online', reason: null });
    } finally {
      await gate.close();
    }
  });

  it('a gate deadline in a job tells the running watch, for that root; a stopped watch hears nothing', async () => {
    const gate = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 1_500, helpers: 2, stuckMax: 4 } });
    setFileGate(gate);
    try {
      const w = startFolderWatch(ctx, { roots: async () => [] });
      const heard = vi.spyOn(w, 'suspect').mockImplementation(() => undefined);
      // a job's file call on a dead share, through the process's gate
      await expect(gate.run(rootId, { op: 'stat', path: 'hang' })).rejects.toMatchObject({ scanRootId: rootId, reason: 'timeout' });
      expect(heard).toHaveBeenCalledWith(rootId);
      expect(heard).toHaveBeenCalledTimes(1);
      w.stop();
      expect(folderWatch()).toBeNull();
      await expect(gate.run(rootId, { op: 'stat', path: 'eio' })).rejects.toMatchObject({ reason: 'io_error' });
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      setFileGate(null);
      await gate.close();
    }
  });
});
