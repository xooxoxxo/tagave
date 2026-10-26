/**
 * A new file whose size equals a missing file's holds its folder's
 * clustering until it is parsed (or failed to parse), so Tier 2 can pair it
 * before cluster.dir builds a new album; never longer than an hour.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { PgBoss } from 'pg-boss';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { placeHolds, scopeHoldState, releaseReadyHolds, releaseExpiredHolds } from './clusterHold.js';
import { clusterDirJob } from '../jobs/clusterDir.js';
import { scanParseJob } from '../jobs/scanParse.js';
import { clusterSingletonKey } from './helpers.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('cluster holds (db)', () => {
  let ctx: WorkerContext; let sql: any;
  const sent: Array<{ name: string; data: any }> = [];
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const file = async (relPath: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    // The shared client binds neither Date nor JSON objects: times go in as ISO text, tags as jsonb text.
    const { tags_raw: tags, ...cols } = over;
    await sql`insert into audio_files ${sql({ id, library_id: libraryId, scan_root_id: rootId, rel_path: relPath, size_bytes: 500, status: 'present', ...cols })}`;
    if (tags !== undefined) await sql`update audio_files set tags_raw = ${JSON.stringify(tags)}::text::jsonb where id = ${id}`;
    return id;
  };
  const holdOf = async (id: string) => (await sql`select reconcile_hold_at from audio_files where id = ${id}`)[0].reconcile_hold_at;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async (name: string, data: any) => { sent.push({ name, data }); return randomUUID(); } } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`ch-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'CH', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-ch', 'ch')`;
  });
  beforeEach(async () => { sent.length = 0; await sql`delete from audio_files where library_id = ${libraryId}`; });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('holds only rows with a size-equal missing file seen before them', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    const twin = await file('New/1.flac');
    const other = await file('New/2.flac', { size_bytes: 501 });
    expect(await placeHolds(ctx, [twin, other])).toEqual([twin]);
    expect(await scopeHoldState(ctx, [twin, other])).toBe('held');
  });

  it('cluster.dir leaves a held folder alone', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    const twin = await file('New/1.flac', { tags_raw: { common: { album: 'A', artist: 'X', title: 't' } } });
    await placeHolds(ctx, [twin]);
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'New' });
    expect(await sql`select 1 from local_tracks where audio_file_id = ${twin}`).toHaveLength(0);
  });

  it('is released once every held row of the folder is parsed or failed', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    await file('Old/2.flac', { status: 'missing', size_bytes: 600, last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    const a = await file('New/1.flac');
    const b = await file('New/2.flac', { size_bytes: 600 });
    await placeHolds(ctx, [a, b]);
    await sql`update audio_files set tags_read_at = now() where id = ${a}`;
    await releaseReadyHolds(ctx, [{ libraryId, scanRootId: rootId, dirPath: 'New' }]);
    expect(await holdOf(a)).not.toBeNull();                            // b not parsed yet
    await sql`update audio_files set status = 'error', parse_error = 'bad' where id = ${b}`;
    await releaseReadyHolds(ctx, [{ libraryId, scanRootId: rootId, dirPath: 'New' }]);
    expect(await holdOf(a)).toBeNull();
    expect(await holdOf(b)).toBeNull();
  });

  it('scan.parse releases a folder whose held file cannot be reached (F8) and clusters it', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    const twin = await file('New/1.flac');
    await placeHolds(ctx, [twin]);
    await scanParseJob(ctx, { audioFileIds: [twin] });   // the root path does not exist
    expect(await holdOf(twin)).toBeNull();
    expect(sent).toEqual([expect.objectContaining({ name: 'cluster.dir', data: { libraryId, scanRootId: rootId, dirPath: 'New' } })]);
  });

  it('a hold older than an hour no longer stops cluster.dir, and the sweep releases it', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    const twin = await file('New/1.flac', { tags_raw: { common: { album: 'A', artist: 'X', title: 't' } } });
    await placeHolds(ctx, [twin]);
    await sql`update audio_files set reconcile_hold_at = now() - interval '61 minutes' where id = ${twin}`;
    expect(await scopeHoldState(ctx, [twin])).toBe('expired');
    expect(await releaseExpiredHolds(ctx, { libraryId })).toBe(1);
    expect(await holdOf(twin)).toBeNull();
    expect(sent).toEqual([expect.objectContaining({ name: 'cluster.dir', data: { libraryId, scanRootId: rootId, dirPath: 'New' } })]);
  });
});

/**
 * Against a real pg-boss: a cluster.dir that returned early on the hold and
 * completed inside the 30 s throttle slot must not swallow the release's send
 * (the folder would never be clustered).
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('cluster holds with a real pg-boss (db)', () => {
  let ctx: WorkerContext; let sql: any; let boss: PgBoss;
  const schema = `pgboss_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const file = async (relPath: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await sql`insert into audio_files ${sql({ id, library_id: libraryId, scan_root_id: rootId, rel_path: relPath, size_bytes: 700, status: 'present', ...over })}`;
    return id;
  };
  const key = clusterSingletonKey(rootId, 'New');
  /** The early return: a cluster.dir sent the way scan.dir and scan.parse send it, fetched and completed. */
  const earlyReturn = async () => {
    const id = await boss.send('cluster.dir', { libraryId, scanRootId: rootId, dirPath: 'New' }, { singletonKey: key, singletonSeconds: 30 });
    expect(id).toBeTruthy();
    const [job] = await boss.fetch('cluster.dir');
    expect(job?.id).toBe(id);
    await boss.complete('cluster.dir', id!);
  };
  const queued = async () => (await boss.findJobs('cluster.dir', { key, queued: true })).length;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    boss = new PgBoss({ connectionString: process.env.TEST_DATABASE_URL!, schema, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    await boss.start();
    await boss.createQueue('cluster.dir', { policy: 'stately' });   // production policy (index.ts QUEUE_POLICIES)
    ctx = { db: made.db, sql: made.client, boss, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`chb-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'CHB', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-chb', 'chb')`;
  }, 30_000);
  beforeEach(async () => {
    await sql`delete from audio_files where library_id = ${libraryId}`;
    await sql.unsafe(`delete from ${schema}.job where name = 'cluster.dir'`);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end({ timeout: 5 });
  }, 30_000);

  it('scan.parse queues cluster.dir for a released folder after an early return in the same throttle slot', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    const twin = await file('New/1.flac');
    await placeHolds(ctx, [twin]);
    await earlyReturn();
    await scanParseJob(ctx, { audioFileIds: [twin] });   // unreachable → errored → released
    expect((await sql`select reconcile_hold_at from audio_files where id = ${twin}`)[0].reconcile_hold_at).toBeNull();
    expect(await queued()).toBe(1);
  }, 30_000);

  it('the sweep queues cluster.dir for a folder released at the cap after an early return in the same slot', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: new Date(Date.now() - 86_400_000).toISOString() });
    const twin = await file('New/1.flac');
    await placeHolds(ctx, [twin]);
    await sql`update audio_files set reconcile_hold_at = now() - interval '61 minutes' where id = ${twin}`;
    await earlyReturn();
    expect(await releaseExpiredHolds(ctx, { libraryId })).toBe(1);
    expect(await queued()).toBe(1);
  }, 30_000);
});
