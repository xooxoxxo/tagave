/**
 * A folder copied to a new place with fresh mtimes, then the original
 * deleted: Tier 1 sees nothing, the new rows are held, and once parsed Tier 2
 * pairs them by size + duration + core tags. Old ids win.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkRoot } from './walk.js';
import { writeFlac } from '../testkit/flac.js';
import { scanParseJob } from '../jobs/scanParse.js';
import { placeHolds, releaseReadyHolds, releaseExpiredHolds, releaseParsedHolds } from './clusterHold.js';
import { RECONCILE_LOCK_PREFIX } from './reconcile.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Tier 2 (db)', () => {
  let ctx: WorkerContext; let sql: any; let rootPath: string;
  const sent: Array<{ name: string; data: any }> = [];
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const root = () => ({ id: rootId, libraryId, path: rootPath });
  const files = async () => sql`select id, rel_path, status, reconcile_hold_at from audio_files where library_id = ${libraryId} order by rel_path`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async (name: string, data: any) => { sent.push({ name, data }); return randomUUID(); } } as any, logger: pino({ level: 'silent' }) };
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-t2-'));
    await mkdir(path.join(rootPath, 'Old'));
    for (const n of [1, 2]) await writeFlac(path.join(rootPath, 'Old', `${n}.flac`), { title: `Song ${n}`, artist: 'Artist', album: 'Album One', track: n, seconds: 30 + n });
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`t2-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'T2', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, ${rootPath}, 't2', 'ok')`;
    const first = await walkRoot(ctx, root(), { mode: 'full' });
    await scanParseJob(ctx, { audioFileIds: first.changedIds });
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('pairs a copy with reset mtimes after parsing, keeping the old ids', async () => {
    const oldIds = (await files()).map((f: any) => f.id).sort();
    await mkdir(path.join(rootPath, 'New'));
    const later = Date.now() / 1000 + 500;
    for (const n of [1, 2]) {
      await copyFile(path.join(rootPath, 'Old', `${n}.flac`), path.join(rootPath, 'New', `${n}.flac`));
      await utimes(path.join(rootPath, 'New', `${n}.flac`), later, later);
    }
    await rm(path.join(rootPath, 'Old'), { recursive: true });
    const w = await walkRoot(ctx, root(), { mode: 'full' });
    expect(w).toMatchObject({ merged: 0, missing: 2, held: 2 });
    sent.length = 0;
    await scanParseJob(ctx, { audioFileIds: w.changedIds });
    const now = await files();
    expect(now.map((f: any) => f.id).sort()).toEqual(oldIds);
    expect(now.every((f: any) => f.status === 'present' && f.rel_path.startsWith('New/') && f.reconcile_hold_at === null)).toBe(true);
    const dirs = sent.filter((s) => s.name === 'cluster.dir').map((s) => s.data.dirPath).sort();
    expect(dirs).toEqual(['New', 'Old']);
  });
});

/**
 * Tier 2 never waits for the library lock (scan.parse and scan.sweep hold a
 * pooled connection): busy before the cap, the folder stays held and the
 * sweep tries again; busy at the cap, the hold goes and the rows stay
 * unpaired, so cluster.dir builds them as new.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('Tier 2 on release (db)', () => {
  let ctx: WorkerContext; let sql: any;
  const sent: Array<{ name: string; data: any }> = [];
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();
  const file = async (relPath: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await sql`insert into audio_files ${sql({ id, library_id: libraryId, scan_root_id: rootId, rel_path: relPath, size_bytes: 500, status: 'present', ...over })}`;
    return id;
  };
  const parsedTwin = { duration_ms: 31_000, core_tags_digest: 'd1', tags_read_at: new Date().toISOString() };
  /** A missing Old/1 and a parsed, held New/1 that Tier 2 pairs. */
  const copied = async (newOver: Record<string, unknown> = {}) => {
    const old = await file('Old/1.flac', { status: 'missing', last_seen_at: dayAgo(), duration_ms: 31_000, core_tags_digest: 'd1' });
    const fresh = await file('New/1.flac', { ...parsedTwin, ...newOver });
    expect(await placeHolds(ctx, [fresh])).toEqual([fresh]);
    return { old, fresh };
  };
  const exists = async (id: string) => (await sql`select 1 from audio_files where id = ${id}`).length === 1;
  const holdOf = async (id: string) => (await sql`select reconcile_hold_at from audio_files where id = ${id}`)[0]?.reconcile_hold_at;
  const clustered = () => sent.filter((s) => s.name === 'cluster.dir').map((s) => s.data.dirPath).sort();
  /** Holds the library lock from another session, as a full scan's finish step would. */
  const holdLock = async () => {
    const conn = await sql.reserve();
    await conn`select pg_advisory_lock(hashtextextended(${RECONCILE_LOCK_PREFIX + libraryId}, 0))`;
    return async () => {
      await conn`select pg_advisory_unlock(hashtextextended(${RECONCILE_LOCK_PREFIX + libraryId}, 0))`;
      conn.release();
    };
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async (name: string, data: any) => { sent.push({ name, data }); return randomUUID(); } } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`t2r-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'T2R', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-t2r', 't2r')`;
  });
  beforeEach(async () => { sent.length = 0; await sql`delete from audio_files where library_id = ${libraryId}`; });

  afterAll(async () => {
    await sql`delete from audio_files where library_id = ${libraryId}`;
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('pairs on release and returns the old folder for clustering', async () => {
    const { old, fresh } = await copied();
    const out = await releaseReadyHolds(ctx, [{ libraryId, scanRootId: rootId, dirPath: 'New' }]);
    expect(out.map((d) => d.dirPath).sort()).toEqual(['New', 'Old']);
    expect(out.every((d) => d.libraryId === libraryId)).toBe(true);
    expect(await exists(fresh)).toBe(false);
    expect((await sql`select rel_path, status from audio_files where id = ${old}`)[0]).toEqual({ rel_path: 'New/1.flac', status: 'present' });
  });

  it('never pairs on a null core tag digest', async () => {
    await file('Old/1.flac', { status: 'missing', last_seen_at: dayAgo(), duration_ms: 31_000 });
    const fresh = await file('New/1.flac', { ...parsedTwin, core_tags_digest: null });
    await placeHolds(ctx, [fresh]);
    const out = await releaseReadyHolds(ctx, [{ libraryId, scanRootId: rootId, dirPath: 'New' }]);
    expect(out.map((d) => d.dirPath)).toEqual(['New']);
    expect(await exists(fresh)).toBe(true);
    expect(await holdOf(fresh)).toBeNull();
  });

  it('busy library lock: the parsed folder stays held, then the sweep pairs it', async () => {
    const { old, fresh } = await copied();
    const unlock = await holdLock();
    try {
      expect(await releaseReadyHolds(ctx, [{ libraryId, scanRootId: rootId, dirPath: 'New' }])).toEqual([]);
      expect(await holdOf(fresh)).not.toBeNull();
      expect(await exists(fresh)).toBe(true);
      expect(await releaseParsedHolds(ctx)).toBe(0);   // still busy: still held
      expect(await holdOf(fresh)).not.toBeNull();
    } finally {
      await unlock();
    }
    expect(await releaseParsedHolds(ctx)).toBe(2);
    expect(await exists(fresh)).toBe(false);
    expect(await exists(old)).toBe(true);
    expect(clustered()).toEqual(['New', 'Old']);
  });

  it('busy library lock at the cap: the hold is released and the rows stay unpaired', async () => {
    const { old, fresh } = await copied();
    await sql`update audio_files set reconcile_hold_at = now() - interval '61 minutes' where id = ${fresh}`;
    const unlock = await holdLock();
    try {
      expect(await releaseExpiredHolds(ctx)).toBe(1);
    } finally {
      await unlock();
    }
    expect(await holdOf(fresh)).toBeNull();
    expect(await exists(fresh)).toBe(true);
    expect((await sql`select status from audio_files where id = ${old}`)[0].status).toBe('missing');
    expect(clustered()).toEqual(['New']);
  });

  it('a merge whose bytes changed sends the old row to scan.parse', async () => {
    await copied();
    // An unparsed new row in the same folder, paired by audio hash with a missing row of other size.
    const old2 = await file('Old/2.flac', { status: 'missing', last_seen_at: dayAgo(), size_bytes: 600, audio_hash: 'h2' });
    await file('New/2.flac', { size_bytes: 650, audio_hash: 'h2' });
    await releaseReadyHolds(ctx, [{ libraryId, scanRootId: rootId, dirPath: 'New' }]);
    expect((await sql`select rel_path from audio_files where id = ${old2}`)[0].rel_path).toBe('New/2.flac');
    expect(sent.filter((s) => s.name === 'scan.parse')).toEqual([{ name: 'scan.parse', data: { audioFileIds: [old2] } }]);
  });
});
