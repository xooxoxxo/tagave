/**
 * The park rule (vault "tagave - Offline Library Spec", section 4 "Job queue
 * behaviour: wait, never fail"): work that meets an offline music folder
 * waits in parked_jobs and comes back on its own when the watch reads the
 * folder online again. A real pg-boss on a database of its own; the file
 * gate's fake helper `hang` path stands in for a file on a dead share.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import postgres from 'postgres';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dispatchMaintenanceTask, maintenanceSender, makeDb, parkJob, reconcileMaintenanceTasks, releaseParked, rootReach,
  runMigrations, saveMaintenanceTask, undispatchedMaintenanceTasks,
} from '@tagave/db';
import type { WorkerContext } from './context.js';
import { FileGate, fileGate } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';
import { FolderWatch, onlineAgain } from './folderWatch/watch.js';
import type { ProbeOutcome } from './folderWatch/reach.js';
import { runMaintenance } from './maintenance.js';
import { PARKED_OUTPUT, WAITING_STAGE, parkable, requireOnline } from './parking.js';
import { prepareWorkerQueues } from './queueSetup.js';

const FAKE = fileURLToPath(new URL('../testkit/fakeHelper.mjs', import.meta.url));
const adminUrl = process.env.TEST_DATABASE_URL;
const LISTING: ProbeOutcome = { kind: 'listing', empty: false, knownFound: 1, knownAsked: 1, isMountPoint: false, wasMountPoint: false };

describe.skipIf(!adminUrl)('parking (db, pg-boss)', () => {
  let admin: postgres.Sql;
  let dbName = '';
  let sql: postgres.Sql;
  let boss: PgBoss;
  let ctx: WorkerContext;
  let gate: FileGate;
  let libraryId = '';
  let rootId = '';

  const parkedRows = async (root: string) =>
    sql<{ queue: string; singleton_key: string | null; reason: string }[]>`
      select queue, singleton_key, reason from parked_jobs where scan_root_id = ${root} order by parked_at, id`.then((rows) => rows.map((r) => ({ ...r })));
  const jobs = async (name: string, key: string) =>
    sql<{ id: string; state: string; data: Record<string, unknown> }[]>`
      select id, state, data from pgboss.job where name = ${name} and singleton_key = ${key} order by created_on`;
  const task = async (id: string) =>
    (await sql<{ state: string; stage: string; attempt_id: string; dispatched_at: Date | null; dispatch_after: string; checkpoint: Record<string, unknown> | null }[]>`
      select state, stage, attempt_id, dispatched_at, dispatch_after::text as dispatch_after, checkpoint from maintenance_tasks where id = ${id}`)[0]!;
  const setReach = (root: string, reach: string, reason: string | null) =>
    sql`update scan_roots set reach = ${reach}, reach_reason = ${reason} where id = ${root}`;

  /** A maintenance task on `queue`, dispatched as the app dispatches it. */
  async function dispatched(queue: string, kind: string, input: Record<string, unknown>): Promise<{ id: string; work: { taskId: string; attemptId: string } }> {
    const t = await saveMaintenanceTask(sql, { libraryId, kind: kind as never, scope: randomUUID(), queue, input: input as never, stage: 'queued' });
    await dispatchMaintenanceTask(sql, maintenanceSender(boss), t.id);
    const row = await task(t.id);
    expect(row.dispatched_at).not.toBeNull();
    return { id: t.id, work: { taskId: t.id, attemptId: row.attempt_id } };
  }

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    dbName = `tagave_park_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await admin.unsafe(`create database ${dbName}`);
    const u = new URL(adminUrl!);
    u.pathname = `/${dbName}`;
    await runMigrations(u.toString(), { log: () => undefined });
    const made = await makeDb(u.toString());
    sql = made.client;
    boss = new PgBoss({ connectionString: u.toString(), supervise: false, schedule: false });
    boss.on('error', () => undefined);
    await boss.start();
    await prepareWorkerQueues(boss, sql);
    ctx = { db: made.db, sql, boss, logger: pino({ level: 'silent' }) };
    gate = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 1_500, helpers: 1, stuckMax: 4 } });
    const [user] = await sql`insert into users (email, password_hash) values ('robin@example.com', 'x') returning id::text as id`;
    const [lib] = await sql`insert into libraries (name, owner_user_id, settings) values ('Music', ${user!.id}, '{}') returning id::text as id`;
    libraryId = lib!.id as string;
  }, 60_000);

  beforeEach(async () => {
    const [root] = await sql`insert into scan_roots (library_id, path, display_name, writable)
      values (${libraryId}, ${`/mnt/music/${randomUUID()}`}, 'Robin music', false) returning id::text as id`;
    rootId = root!.id as string;
  });

  afterAll(async () => {
    await gate?.close();
    await boss?.stop({ graceful: false }).catch(() => undefined);
    await sql?.end({ timeout: 5 });
    if (dbName) await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it('a handler that meets an offline folder parks its job and completes it', async () => {
    // the share hangs: the gate gives up at its deadline and throws FolderOfflineError(rootId, 'timeout')
    const h = parkable<{ scanRootId: string }>(ctx, 'scan.root', (d) => d.scanRootId, (d) => `scan:${d.scanRootId}`,
      async ({ data }) => gate.run(data.scanRootId, { op: 'stat', path: 'hang' }));
    expect(await h({ id: 'j1', data: { scanRootId: rootId } })).toEqual(PARKED_OUTPUT);
    expect(PARKED_OUTPUT).toEqual({ parked: true });
    expect(await parkedRows(rootId)).toEqual([{ queue: 'scan.root', singleton_key: `scan:${rootId}`, reason: 'timeout' }]);
  });

  it('a job whose root cannot be found runs as today', async () => {
    const h = parkable<{ scanRootId?: string }>(ctx, 'scan.sweep', () => null, () => null,
      async () => { throw new FolderOfflineError(rootId, 'timeout'); });
    await expect(h({ id: 'j0', data: {} })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(await parkedRows(rootId)).toEqual([]);
    // other errors are never parked
    const other = parkable<{ scanRootId: string }>(ctx, 'scan.root', (d) => d.scanRootId, () => null, async () => { throw new Error('bad tag'); });
    await expect(other({ id: 'j0b', data: { scanRootId: rootId } })).rejects.toThrow('bad tag');
    expect(await parkedRows(rootId)).toEqual([]);
  });

  it('parks once per singleton key', async () => {
    const h = parkable<{ scanRootId: string }>(ctx, 'scan.root', (d) => d.scanRootId, (d) => `scan:${d.scanRootId}`,
      async () => { throw new FolderOfflineError(rootId, 'server_silent'); });
    await h({ id: 'j2', data: { scanRootId: rootId } });
    await h({ id: 'j3', data: { scanRootId: rootId } });
    expect(await parkedRows(rootId)).toEqual([{ queue: 'scan.root', singleton_key: `scan:${rootId}`, reason: 'server_silent' }]);
    // no singleton key: each job is its own row
    await parkJob(sql, { scanRootId: rootId, queue: 'scan.parse', data: { audioFileIds: ['a'] }, singletonKey: null, reason: 'io_error' });
    await parkJob(sql, { scanRootId: rootId, queue: 'scan.parse', data: { audioFileIds: ['b'] }, singletonKey: null, reason: 'io_error' });
    expect((await parkedRows(rootId)).filter((r) => r.queue === 'scan.parse')).toHaveLength(2);
  });

  it('the return re-sends in one transaction and deletes the rows', async () => {
    const key = `fingerprint:${randomUUID()}`;
    await parkJob(sql, { scanRootId: rootId, queue: 'fingerprint.album', data: { localAlbumId: key }, singletonKey: key, reason: 'timeout' });
    await parkJob(sql, { scanRootId: rootId, queue: 'scan.parse', data: { audioFileIds: ['x'] }, singletonKey: null, reason: 'timeout' });

    // a send that throws leaves the rows: the transaction rolls back, the first send included
    let calls = 0;
    const failing = async (tx: postgres.TransactionSql, queue: string, data: object, singletonKey: string | null) => {
      calls += 1;
      if (calls === 2) throw new Error('send refused');
      await boss.send(queue, data, { ...(singletonKey ? { singletonKey } : {}), db: { executeSql: async (q: string, v?: unknown[]) => ({ rows: await tx.unsafe(q, v as never[]) }) } } as never);
    };
    await expect(releaseParked(sql, rootId, failing)).rejects.toThrow('send refused');
    expect(await parkedRows(rootId)).toHaveLength(2);
    expect(await jobs('fingerprint.album', key)).toEqual([]);

    const ok = async (tx: postgres.TransactionSql, queue: string, data: object, singletonKey: string | null) => {
      await boss.send(queue, data, { ...(singletonKey ? { singletonKey } : {}), db: { executeSql: async (q: string, v?: unknown[]) => ({ rows: await tx.unsafe(q, v as never[]) }) } } as never);
    };
    expect(await releaseParked(sql, rootId, ok)).toBe(2);
    expect(await parkedRows(rootId)).toEqual([]);
    expect(await jobs('fingerprint.album', key)).toMatchObject([{ state: 'created', data: { localAlbumId: key } }]);
    const parse = await sql`select 1 from pgboss.job where name = 'scan.parse' and data->'audioFileIds' ? 'x'`;
    expect(parse).toHaveLength(1);
  });

  it('the return and the park send one scan between them', async () => {
    const h = parkable<{ scanRootId: string; mode: string }>(ctx, 'scan.root', (d) => d.scanRootId, (d) => `scan:${d.scanRootId}`,
      async () => { throw new FolderOfflineError(rootId, 'timeout'); });
    await h({ id: 'j4', data: { scanRootId: rootId, mode: 'full' } });
    await setReach(rootId, 'offline', 'timeout');
    await onlineAgain(ctx)(rootId, 'offline');
    const scans = await jobs('scan.root', `scan:${rootId}`);
    expect(scans).toHaveLength(1);
    // the parked scan asked for full: the return's one scan is full though the folder was only offline
    expect(scans[0]).toMatchObject({ state: 'created', data: { scanRootId: rootId, mode: 'full' } });
    expect(await parkedRows(rootId)).toEqual([]);
    // nothing parked: the return still queues its own scan (quick after offline, full after not connected)
    await sql`delete from pgboss.job where name = 'scan.root' and singleton_key = ${`scan:${rootId}`}`;
    await onlineAgain(ctx)(rootId, 'unmounted');
    expect(await jobs('scan.root', `scan:${rootId}`)).toMatchObject([{ state: 'created', data: { scanRootId: rootId, mode: 'full' } }]);
  });

  it('after not connected the return sends one full scan, never the parked scans', async () => {
    await parkJob(sql, { scanRootId: rootId, queue: 'scan.root', data: { scanRootId: rootId, mode: 'quick' }, singletonKey: `scan:${rootId}`, reason: 'not_mounted' });
    await parkJob(sql, { scanRootId: rootId, queue: 'scan.dir', data: { scanRootId: rootId, dirPath: 'Jazz' }, singletonKey: `scan:${rootId}`, reason: 'not_mounted' });
    await onlineAgain(ctx)(rootId, 'unmounted');
    expect(await jobs('scan.root', `scan:${rootId}`)).toMatchObject([{ state: 'created', data: { scanRootId: rootId, mode: 'full' } }]);
    expect(await sql`select 1 from pgboss.job where name = 'scan.dir' and data->>'scanRootId' = ${rootId}`).toEqual([]);
    expect(await parkedRows(rootId)).toEqual([]);
  });

  /** A watch that reads this suite's root online (no mount table: a local folder). */
  const onlineWatch = (probe: () => Promise<ProbeOutcome> = async () => LISTING) =>
    new FolderWatch({ ctx, env: { TAGAVE_MUSIC_NAME: 'music' }, readMountinfo: async () => { throw new Error('no procfs'); }, probe });

  it('a row parked while the watch reads online goes again at the next online reading, with no scan of its own', async () => {
    await setReach(rootId, 'online', null);
    const key = `fingerprint:${randomUUID()}`;
    await parkJob(sql, { scanRootId: rootId, queue: 'fingerprint.album', data: { localAlbumId: key }, singletonKey: key, reason: 'timeout' });
    await onlineWatch().tick(rootId);
    expect(await parkedRows(rootId)).toEqual([]);
    expect(await jobs('fingerprint.album', key)).toMatchObject([{ state: 'created' }]);
    expect(await jobs('scan.root', `scan:${rootId}`)).toEqual([]);
  });

  it('a row parked after the reading started stays for the next one', async () => {
    await setReach(rootId, 'online', null);
    const key = `fingerprint:${randomUUID()}`;
    const parkDuring = async (): Promise<ProbeOutcome> => {
      await parkJob(sql, { scanRootId: rootId, queue: 'fingerprint.album', data: { localAlbumId: key }, singletonKey: key, reason: 'timeout' });
      return LISTING;
    };
    await onlineWatch(parkDuring).tick(rootId);
    expect(await parkedRows(rootId)).toHaveLength(1);
    expect(await jobs('fingerprint.album', key)).toEqual([]);
    await onlineWatch().tick(rootId);
    expect(await parkedRows(rootId)).toEqual([]);
  });

  it('a root whose gate is at its stuck cap reads online: the gate takes its work again', async () => {
    await setReach(rootId, 'online', null);
    for (let i = 0; i < 4; i++) fileGate().markStuck(rootId); // TAGAVE_FILE_HELPERS_STUCK_MAX default 4
    expect(fileGate().refuses(rootId)).toBe(true);
    await onlineWatch().tick(rootId);
    expect(fileGate().refuses(rootId)).toBe(false);
  });

  it('a maintenance task parks as waiting and is not reconciled to interrupted', async () => {
    const { id, work } = await dispatched('tags.apply', 'split', { planId: randomUUID() });
    const before = await task(id);
    await runMaintenance(ctx, work, async () => { throw new FolderOfflineError(rootId, 'timeout'); });
    expect(await task(id)).toMatchObject({ state: 'waiting', stage: WAITING_STAGE, dispatched_at: null, dispatch_after: 'infinity' });
    expect(WAITING_STAGE).toBe('Waiting for the music folder');
    expect((await task(id)).attempt_id).not.toBe(before.attempt_id);
    expect(await sql`select queue, data, singleton_key, reason from parked_jobs where scan_root_id = ${rootId}`)
      .toEqual([{ queue: 'maintenance', data: { taskId: id }, singleton_key: `maintenance:${id}`, reason: 'timeout' }]);

    // the attempt's job completes (it was neither failed nor retried); the task stays waiting
    await boss.complete('tags.apply', before.attempt_id);
    await reconcileMaintenanceTasks(sql);
    expect((await task(id)).state).toBe('waiting');
    expect(await undispatchedMaintenanceTasks(sql)).not.toContain(id); // held while offline

    // the release alone makes it dispatchable again (the app's loop would send it) …
    await releaseParked(sql, rootId, async () => { throw new Error('no plain job here'); });
    expect(await undispatchedMaintenanceTasks(sql)).toContain(id);
    expect(await parkedRows(rootId)).toEqual([]);
  });

  it('the return dispatches a parked maintenance task once', async () => {
    const { id, work } = await dispatched('art.fetch', 'cover', { localAlbumId: randomUUID() });
    await runMaintenance(ctx, work, async () => { throw new FolderOfflineError(rootId, 'server_silent'); });
    await setReach(rootId, 'offline', 'server_silent');
    await onlineAgain(ctx)(rootId, 'offline');
    const after = await task(id);
    expect(after).toMatchObject({ state: 'waiting' });
    expect(after.dispatched_at).not.toBeNull();
    expect(await undispatchedMaintenanceTasks(sql)).not.toContain(id);
    const sent = await sql`select state from pgboss.job where name = 'art.fetch' and id = ${after.attempt_id}`;
    expect(sent).toEqual([{ state: 'created' }]);
    // a second dispatch (the app's loop) finds nothing to send
    await dispatchMaintenanceTask(sql, maintenanceSender(boss), id);
    expect(await sql`select 1 from pgboss.job where name = 'art.fetch' and data->'maintenance'->>'taskId' = ${id}`).toHaveLength(2); // the first attempt's and this one
  });

  it('splits, moves, upgrades and trash actions pause for the owner instead of parking', async () => {
    const { id, work } = await dispatched('files.split', 'split', { splitId: randomUUID(), action: 'split' });
    await runMaintenance(ctx, work, async (claim) => {
      await claim.update({ checkpoint: { phase: 'cut', done: 2 } });
      throw new FolderOfflineError(rootId, 'timeout');
    });
    expect(await task(id)).toMatchObject({
      state: 'interrupted', stage: 'Paused while the music folder is offline',
      checkpoint: { phase: 'cut', done: 2, offlineRootId: rootId },
    });
    expect(await parkedRows(rootId)).toEqual([]);
    await setReach(rootId, 'offline', 'timeout');
    await onlineAgain(ctx)(rootId, 'offline');
    expect((await task(id)).state).toBe('interrupted'); // no auto-resume (Decision 2)

    const trash = await dispatched('files.trash', 'empty-trash', { action: 'empty' });
    await runMaintenance(ctx, trash.work, async () => { throw new FolderOfflineError(rootId, 'io_error'); });
    expect(await task(trash.id)).toMatchObject({ state: 'interrupted', checkpoint: { offlineRootId: rootId } });
  });

  it('a root removed while jobs are parked takes its rows with it', async () => {
    await parkJob(sql, { scanRootId: rootId, queue: 'scan.root', data: { scanRootId: rootId }, singletonKey: `scan:${rootId}`, reason: 'timeout' });
    const { id, work } = await dispatched('files.embedCover', 'embed-cover', { albumId: randomUUID(), fileIds: [] });
    await runMaintenance(ctx, work, async () => { throw new FolderOfflineError(rootId, 'timeout'); });
    expect(await parkedRows(rootId)).toHaveLength(2);
    await reconcileMaintenanceTasks(sql);
    expect((await task(id)).state).toBe('waiting'); // still parked: its row is there

    await sql`delete from scan_roots where id = ${rootId}`;
    expect(await parkedRows(rootId)).toEqual([]);
    // the parked task would wait for ever: the reconcile hands it to the owner
    await reconcileMaintenanceTasks(sql);
    const [after] = await sql`select state, stage, error from maintenance_tasks where id = ${id}`;
    expect(after).toEqual({ state: 'interrupted', stage: WAITING_STAGE, error: 'The music folder for this task was removed.' });
  });

  it('requireOnline parks at once, without waiting for a deadline', async () => {
    expect(await rootReach(sql, rootId)).toEqual({ reach: 'unknown', reason: null });
    await requireOnline(ctx, rootId); // unknown (no reading yet): runs
    await setReach(rootId, 'online', null);
    await requireOnline(ctx, rootId);
    await setReach(rootId, 'offline', 'server_silent');
    const t0 = performance.now();
    const err = await requireOnline(ctx, rootId).catch((e: unknown) => e);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(err).toBeInstanceOf(FolderOfflineError);
    expect(err).toMatchObject({ scanRootId: rootId, reason: 'server_silent' });
    await setReach(rootId, 'unmounted', null);
    await expect(requireOnline(ctx, rootId)).rejects.toMatchObject({ reason: 'not_mounted' });

    // through parkable: a park, no handler body run
    let ran = false;
    const h = parkable<{ scanRootId: string }>(ctx, 'scan.dir', (d) => d.scanRootId, (d) => `scan:${d.scanRootId}`, async ({ data }) => {
      await requireOnline(ctx, data.scanRootId);
      ran = true;
    });
    expect(await h({ id: 'j5', data: { scanRootId: rootId } })).toEqual({ parked: true });
    expect(ran).toBe(false);
    expect(await parkedRows(rootId)).toEqual([{ queue: 'scan.dir', singleton_key: `scan:${rootId}`, reason: 'not_mounted' }]);
  });
});
