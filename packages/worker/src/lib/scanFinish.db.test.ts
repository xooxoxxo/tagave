/**
 * The finish step after a walk: rows are marked missing only when they are
 * still where the walk's snapshot saw them and were last seen before the
 * walk began by the database's clock. A worker clock that runs ahead marks
 * nothing that was just seen. dev:ino is stored on every stat.
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkTree } from './walk.js';
import { finishWalk } from './scanFinish.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('finishWalk (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let rootPath: string;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  let root: { id: string; libraryId: string; path: string };
  const byPath = async () => new Map<string, any>((await sql`select id, rel_path, status, inode, last_seen_at from audio_files where scan_root_id = ${rootId}`).map((r: any) => [r.rel_path, r]));

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
    await sql`insert into audio_files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, last_seen_at)
              values (${libraryId}, ${rootId}, 'A/ghost.mp3', 9, 1, 'present', now() - interval '1 day')`;
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
    await sql`update audio_files set rel_path = 'B/03.mp3' where scan_root_id = ${rootId} and rel_path = 'A/03.mp3'`;
    const f = await finishWalk(ctx, root, w);
    expect(f.missing).toBe(0);
    expect((await byPath()).get('B/03.mp3')!.status).toBe('present');
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
