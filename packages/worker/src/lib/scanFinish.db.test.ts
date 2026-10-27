/**
 * The finish step after a walk: rows are marked missing only when they are
 * still where the walk's snapshot saw them and were last seen before the
 * walk began by the database's clock. A worker clock that runs ahead marks
 * nothing that was just seen. dev:ino is stored on every stat.
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkTree } from './walk.js';
import { finishWalk, finishNotes, UNMOUNTED_SKIP } from './scanFinish.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('finishWalk (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let rootPath: string;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  let root: { id: string; libraryId: string; path: string };
  const byPath = async () => new Map<string, any>((await sql`select id, rel_path, status, inode, last_seen_at from files where scan_root_id = ${rootId}`).map((r: any) => [r.rel_path, r]));

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: null as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`fw-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'FW', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-finish-'));
    await mkdir(path.join(rootPath, 'A'));
    await writeFile(path.join(rootPath, 'A', '01.mp3'), 'a1');
    await writeFile(path.join(rootPath, 'A', '02.mp3'), 'a22');
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, ${rootPath}, 'fw', 'ok')`;
    root = { id: rootId, libraryId, path: rootPath };
  });

  afterEach(() => vi.useRealTimers());

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('stores dev:ino and reports inserted rows', async () => {
    const w = await walkTree(ctx, root, { mode: 'full' });
    expect(w.insertedIds).toHaveLength(2);
    const st = await stat(path.join(rootPath, 'A', '01.mp3'), { bigint: true });
    expect((await byPath()).get('A/01.mp3')!.inode).toBe(`${st.dev}:${st.ino}`);
    await finishWalk(ctx, root, w);
  });

  it('a worker clock an hour ahead marks nothing that the walk just saw', async () => {
    // an indexed file the walk will not see, last seen a day ago
    await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, last_seen_at, handler)
              values (${libraryId}, ${rootId}, 'A/ghost.mp3', 9, 1, 'present', now() - interval '1 day', 'audio')`;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
    const w = await walkTree(ctx, root, { mode: 'full' });
    const f = await finishWalk(ctx, root, w);
    vi.useRealTimers();
    expect(f).toMatchObject({ missing: 1, dirsWithMissing: ['A'] });
    const [db] = await sql`select now() as now`;
    const rows = await byPath();
    expect(rows.get('A/ghost.mp3')!.status).toBe('missing');
    for (const p of ['A/01.mp3', 'A/02.mp3']) {
      expect(rows.get(p)!.status).toBe('present');
      // written by the database's clock, not the worker's hour-ahead one
      expect(new Date(rows.get(p)!.last_seen_at).getTime()).toBeLessThanOrEqual(new Date(db.now).getTime());
    }
  });

  it('a removed file is marked missing; its dir is reported', async () => {
    await rm(path.join(rootPath, 'A', '02.mp3'));
    const w = await walkTree(ctx, root, { mode: 'full' });
    expect(w.unseen.map((u) => u.relPath)).toEqual(['A/02.mp3']);
    const f = await finishWalk(ctx, root, w);
    expect(f).toMatchObject({ missing: 1, dirsWithMissing: ['A'] });
    expect((await byPath()).get('A/02.mp3')!.status).toBe('missing');
  });

  it('a row moved elsewhere after the snapshot is never marked missing', async () => {
    await writeFile(path.join(rootPath, 'A', '03.mp3'), 'a333');
    await walkTree(ctx, root, { mode: 'full' }).then((w) => finishWalk(ctx, root, w));
    await rm(path.join(rootPath, 'A', '03.mp3'));
    const w = await walkTree(ctx, root, { mode: 'full' });
    // a concurrent scan.dir re-points the row to another path meanwhile; last_seen_at
    // stays older than walkStart, so only the rel_path snapshot guard protects it
    await sql`update files set rel_path = 'B/03.mp3' where scan_root_id = ${rootId} and rel_path = 'A/03.mp3'`;
    const f = await finishWalk(ctx, root, w);
    expect(f.missing).toBe(0);
    expect((await byPath()).get('B/03.mp3')!.status).toBe('present');
  });

  it('a new file the size of a missing one is held for Tier 2; others are not', async () => {
    // A/02.mp3 (3 bytes) is missing since the test above; a different name and an
    // old mtime keep Tier 1 from pairing the newcomer
    await mkdir(path.join(rootPath, 'C'));
    await writeFile(path.join(rootPath, 'C', 'new.mp3'), 'zzz');
    await writeFile(path.join(rootPath, 'C', 'other.mp3'), 'zzzzzzz');
    const old = new Date('2001-01-01T00:00:00Z');
    await utimes(path.join(rootPath, 'C', 'new.mp3'), old, old);
    const w = await walkTree(ctx, root, { mode: 'full' });
    const f = await finishWalk(ctx, root, w);
    expect(f).toMatchObject({ merged: 0, held: 1 });
    const holds = await sql`select rel_path, reconcile_hold_at is not null as held from files where scan_root_id = ${rootId} and rel_path like 'C/%' order by rel_path`;
    expect(holds.map((r: any) => [r.rel_path, r.held])).toEqual([['C/new.mp3', true], ['C/other.mp3', false]]);
  });

  it('walkStart is the database clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
    const w = await walkTree(ctx, root, { mode: 'full' });
    vi.useRealTimers();
    const [db] = await sql`select now() as now`;
    expect(Math.abs(new Date(db.now).getTime() - w.walkStart.getTime())).toBeLessThan(60_000);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL || process.getuid?.() === 0)('finishWalk guards (db)', () => {
  // chmod 000 does not stop root; CI runs as an ordinary user
  let ctx: WorkerContext; let sql: any; let rootPath: string; let lonePath: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID(); const loneId = randomUUID();
  let root: { id: string; libraryId: string; path: string };
  let lone: { id: string; libraryId: string; path: string };
  const statusOf = async (p: string) => (await sql`select status from files where scan_root_id = ${rootId} and rel_path = ${p}`)[0]?.status;
  const sidecarKept = async (p: string) => (await sql`select 1 from sidecar_files where scan_root_id = ${rootId} and rel_path = ${p}`).length === 1;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: null as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`fg-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'FG', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-guard-'));
    for (const d of ['Ok', 'Locked', 'Many', 'NoExec']) await mkdir(path.join(rootPath, d));
    await writeFile(path.join(rootPath, 'Ok', '1.mp3'), 'x');
    await writeFile(path.join(rootPath, 'Locked', '1.mp3'), 'y');
    await writeFile(path.join(rootPath, 'Locked', 'cover.jpg'), 'img');
    await writeFile(path.join(rootPath, 'NoExec', '1.mp3'), 'z');
    await writeFile(path.join(rootPath, 'NoExec', 'cover.jpg'), 'img');
    await writeFile(path.join(rootPath, 'Many', 'cover.jpg'), 'img');
    for (let i = 0; i < 30; i++) await writeFile(path.join(rootPath, 'Many', `${String(i).padStart(2, '0')}.mp3`), `m${i}`);
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, ${rootPath}, 'fg', 'ok')`;
    root = { id: rootId, libraryId, path: rootPath };
    await walkTree(ctx, root, { mode: 'full' }).then((w) => finishWalk(ctx, root, w));
    // a second root whose only folder becomes unreadable (reads as unmounted)
    lonePath = await mkdtemp(path.join(tmpdir(), 'tagave-guard-lone-'));
    await mkdir(path.join(lonePath, 'Only'));
    await writeFile(path.join(lonePath, 'Only', '1.mp3'), 'o');
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${loneId}, ${libraryId}, ${lonePath}, 'fg-lone', 'ok')`;
    lone = { id: loneId, libraryId, path: lonePath };
    await walkTree(ctx, lone, { mode: 'full' }).then((w) => finishWalk(ctx, lone, w));
  });

  afterAll(async () => {
    const { chmod } = await import('node:fs/promises');
    for (const d of [path.join(rootPath, 'Locked'), path.join(rootPath, 'NoExec'), path.join(lonePath, 'Only')]) {
      await chmod(d, 0o755).catch(() => undefined);
    }
    await sql`delete from scan_roots where id in (${rootId}, ${loneId})`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
    await rm(lonePath, { recursive: true, force: true });
  });

  it('files under an unreadable folder are not marked missing; the folder is reported; reconcile still runs', async () => {
    const { chmod } = await import('node:fs/promises');
    await chmod(path.join(rootPath, 'Locked'), 0o000);
    const w = await walkTree(ctx, root, { mode: 'full' });
    const f = await finishWalk(ctx, root, w);
    expect(f.failedDirs).toEqual(['Locked']);
    expect(f.missing).toBe(0);
    expect(f.reconcileSkipped).toBeNull();
    expect(await statusOf('Locked/1.mp3')).toBe('present');
    // its cover sidecar (and through the 0052 cascade, its image) stays
    expect(await sidecarKept('Locked/cover.jpg')).toBe(true);
    await chmod(path.join(rootPath, 'Locked'), 0o755);
  });

  it('a file whose stat fails is not marked missing, nor is its sidecar dropped', async () => {
    const { chmod } = await import('node:fs/promises');
    // readable but not searchable: the folder lists, every stat inside it fails
    await chmod(path.join(rootPath, 'NoExec'), 0o444);
    const w = await walkTree(ctx, root, { mode: 'full' });
    expect(w.unseen.map((u) => u.relPath)).toContain('NoExec/1.mp3');
    const f = await finishWalk(ctx, root, w);
    expect(f.failedDirs).toContain('NoExec/1.mp3');
    expect(f.missing).toBe(0);
    expect(await statusOf('NoExec/1.mp3')).toBe('present');
    expect(await sidecarKept('NoExec/cover.jpg')).toBe(true);
    await chmod(path.join(rootPath, 'NoExec'), 0o755);
  });

  it('a root whose only folder is unreadable reads as unmounted and still names the folder', async () => {
    const { chmod } = await import('node:fs/promises');
    await chmod(path.join(lonePath, 'Only'), 0o000);
    const w = await walkTree(ctx, lone, { mode: 'full' });
    expect(w.looksUnmounted).toBe(true);
    const f = await finishWalk(ctx, lone, w);
    expect(f).toMatchObject({ failedDirs: ['Only'], missing: 0, merged: 0, reconcileSkipped: UNMOUNTED_SKIP });
    expect(finishNotes(f)).toBe(`; could not read Only; nothing under them was marked missing; ${UNMOUNTED_SKIP}`);
    await chmod(path.join(lonePath, 'Only'), 0o755);
  });

  it('losing more than the threshold in one scan marks nothing and reports the hold', async () => {
    for (let i = 0; i < 12; i++) await rm(path.join(rootPath, 'Many', `${String(i).padStart(2, '0')}.mp3`));
    await rm(path.join(rootPath, 'Many', 'cover.jpg'));
    const w = await walkTree(ctx, root, { mode: 'full' });
    const f = await finishWalk(ctx, root, w);
    expect(f.heldMissing).toEqual({ count: 12, threshold: 10 });
    expect(f.missing).toBe(0);
    expect(await statusOf('Many/00.mp3')).toBe('present');
    // a held scan drops no sidecars either
    expect(await sidecarKept('Many/cover.jpg')).toBe(true);
  });

  it('confirmMissing marks them', async () => {
    const w = await walkTree(ctx, root, { mode: 'full' });
    const f = await finishWalk(ctx, root, w, { confirmMissing: true });
    expect(f).toMatchObject({ heldMissing: null, missing: 12 });
    expect(await sidecarKept('Many/cover.jpg')).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('held losses are marked missing after 24 hours (db)', () => {
  let ctx: WorkerContext; let sql: any; let rootPath: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  let root: { id: string; libraryId: string; path: string };
  const names = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}.mp3`);
  const lost = names.slice(0, 12);
  const scan = async () => finishWalk(ctx, root, await walkTree(ctx, root, { mode: 'full' }));
  const stamps = async () => (await sql`select rel_path, missing_held_at from files
                                         where scan_root_id = ${rootId} and missing_held_at is not null order by rel_path`)
    .map((r: any) => [r.rel_path, String(r.missing_held_at)]);
  const missingCount = async () => (await sql`select count(*)::int as n from files where scan_root_id = ${rootId} and status = 'missing'`)[0].n;
  const removeLost = async () => { for (const n of lost) await rm(path.join(rootPath, 'Many', n)); };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: null as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`hc-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'HC', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-heldconfirm-'));
    await mkdir(path.join(rootPath, 'Many'));
    await mkdir(path.join(rootPath, 'Ok'));
    await writeFile(path.join(rootPath, 'Ok', '1.mp3'), 'x');
    for (const [i, n] of names.entries()) await writeFile(path.join(rootPath, 'Many', n), `h${i}`);
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, ${rootPath}, 'hc', 'ok')`;
    root = { id: rootId, libraryId, path: rootPath };
    await scan();
  });

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('a first held scan marks nothing and stamps the gone rows', async () => {
    await removeLost();
    const f = await scan();
    expect(f).toMatchObject({ missing: 0, confirmedAfterHold: 0, heldMissing: { count: 12, threshold: 10 } });
    expect(await missingCount()).toBe(0);
    expect((await stamps()).map((s: string[]) => s[0])).toEqual(lost.map((n) => `Many/${n}`));
  });

  it('a second held scan within 24 hours marks nothing and keeps the first stamps', async () => {
    const before = await stamps();
    const f = await scan();
    expect(f).toMatchObject({ missing: 0, confirmedAfterHold: 0, heldMissing: { count: 12, threshold: 10 } });
    expect(await missingCount()).toBe(0);
    expect(await stamps()).toEqual(before);
  });

  it('files that come back clear the hold', async () => {
    for (const n of lost) await writeFile(path.join(rootPath, 'Many', n), `back-${n}`);
    const f = await scan();
    expect(f).toMatchObject({ missing: 0, heldMissing: null });
    expect(await stamps()).toEqual([]);
  });

  it('a held scan 24 hours or more after the first marks the rows missing', async () => {
    await removeLost();
    expect((await scan()).heldMissing).toEqual({ count: 12, threshold: 10 });
    await sql`update files set missing_held_at = now() - interval '25 hours'
               where scan_root_id = ${rootId} and missing_held_at is not null`;
    const f = await scan();
    expect(f).toMatchObject({ missing: 12, confirmedAfterHold: 12, heldMissing: null });
    expect(await missingCount()).toBe(12);
    expect(await stamps()).toEqual([]);
    expect(finishNotes(f)).toBe('; Marked missing: 12 files were still gone 24 hours after they were held.');
  });
});
