/**
 * scan.root as a job: the partly-unmounted hold survives quick scans,
 * confirmMissing always walks in full and marks the held rows, and the
 * stats and Activity message say what was not done and why.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { scanRootJob } from './scanRoot.js';

describe.skipIf(!process.env.TEST_DATABASE_URL || process.getuid?.() === 0)('scanRootJob guards (db)', () => {
  // chmod 000 does not stop root; CI runs as an ordinary user
  let ctx: WorkerContext; let sql: any; let rootPath: string; let lonePath: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID(); const loneId = randomUUID();
  const lastScan = async (id: string) => (await sql`select status, stats from scans where scan_root_id = ${id} order by started_at desc limit 1`)[0];
  const lastRun = async (id: string) => (await sql`select state, progress, error from job_runs where subject_id = ${id} order by created_at desc limit 1`)[0];
  const statusOf = async (p: string) => (await sql`select status from audio_files where scan_root_id = ${rootId} and rel_path = ${p}`)[0]?.status;
  const later = async (dir: string, s: number) => { const t = new Date(Date.now() + s * 1000); await utimes(dir, t, t); };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: vi.fn(async () => null) } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`sr-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'SR', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-srjob-'));
    for (const d of ['Ok', 'Many']) await mkdir(path.join(rootPath, d));
    await writeFile(path.join(rootPath, 'Ok', '1.mp3'), 'x');
    for (let i = 0; i < 30; i++) await writeFile(path.join(rootPath, 'Many', `${String(i).padStart(2, '0')}.mp3`), `m${i}`);
    lonePath = await mkdtemp(path.join(tmpdir(), 'tagave-srjob-lone-'));
    await mkdir(path.join(lonePath, 'Only'));
    await writeFile(path.join(lonePath, 'Only', '1.mp3'), 'o');
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values
      (${rootId}, ${libraryId}, ${rootPath}, 'sr', 'ok'), (${loneId}, ${libraryId}, ${lonePath}, 'sr-lone', 'ok')`;
    await scanRootJob(ctx, { scanRootId: rootId, mode: 'full' });
    await scanRootJob(ctx, { scanRootId: loneId, mode: 'full' });
  });

  afterAll(async () => {
    await chmod(path.join(lonePath, 'Only'), 0o755).catch(() => undefined);
    await sql`delete from scan_roots where id in (${rootId}, ${loneId})`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
    await rm(lonePath, { recursive: true, force: true });
  });

  it('a quick scan that loses too many files holds them, reports it in stats and the message', async () => {
    for (let i = 0; i < 12; i++) await rm(path.join(rootPath, 'Many', `${String(i).padStart(2, '0')}.mp3`));
    await later(path.join(rootPath, 'Many'), 120); // the quick walk must see the folder changed
    await scanRootJob(ctx, { scanRootId: rootId, mode: 'quick' });
    const scan = await lastScan(rootId);
    expect(scan.status).toBe('completed');
    expect(scan.stats).toMatchObject({ mode: 'quick', missing: 0, failedDirs: [], heldMissing: { count: 12, threshold: 10 }, reconcileSkipped: null });
    expect((await lastRun(rootId)).progress.message)
      .toMatch(/; looks partly unmounted: 12 files would go missing \(more than 10\), so none were marked$/);
    expect(await statusOf('Many/00.mp3')).toBe('present');
    // the held folder's mtime is forgotten, so the next quick scan walks it in full
    expect(await sql`select 1 from scan_dirs where scan_root_id = ${rootId} and rel_path = 'Many'`).toHaveLength(0);
  });

  it('the next quick scan still holds them (the folder is not skipped)', async () => {
    await scanRootJob(ctx, { scanRootId: rootId, mode: 'quick' });
    expect((await lastScan(rootId)).stats).toMatchObject({ mode: 'quick', missing: 0, heldMissing: { count: 12, threshold: 10 } });
    expect(await statusOf('Many/00.mp3')).toBe('present');
  });

  it('confirmMissing on a quick request walks in full and marks them', async () => {
    // make the folder's mtime known and unchanged, so a quick walk would skip it
    const mtime = Math.floor((await stat(path.join(rootPath, 'Many'))).mtimeMs / 1000);
    await sql`insert into scan_dirs (scan_root_id, rel_path, mtime) values (${rootId}, 'Many', ${mtime})
              on conflict (scan_root_id, rel_path) do update set mtime = excluded.mtime`;
    await scanRootJob(ctx, { scanRootId: rootId, mode: 'quick', confirmMissing: true });
    const scan = await lastScan(rootId);
    expect(scan.stats).toMatchObject({ mode: 'full', missing: 12, heldMissing: null });
    expect((await lastRun(rootId)).progress.message).not.toMatch(/partly unmounted/);
    expect(await statusOf('Many/00.mp3')).toBe('missing');
    expect(await statusOf('Many/29.mp3')).toBe('present');
  });

  it('an abort for an unmounted-looking root names the folder it could not read', async () => {
    await chmod(path.join(lonePath, 'Only'), 0o000);
    await scanRootJob(ctx, { scanRootId: loneId, mode: 'full' });
    const scan = await lastScan(loneId);
    expect(scan.status).toBe('aborted');
    expect(scan.stats.error).toMatch(/nothing marked missing; could not read Only; nothing under them was marked missing; the root looks unmounted, so moved files are not matched in this scan$/);
    expect((await lastRun(loneId)).error).toBe(scan.stats.error);
    await chmod(path.join(lonePath, 'Only'), 0o755);
  });
});
