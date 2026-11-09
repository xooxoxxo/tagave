/**
 * Maintenance tasks (0090) through pg-boss as production queues them: the
 * queues set up the way the worker sets them up (files.split, tags.apply and
 * art.fetch are 'stately'), each task dispatched the way the app dispatches
 * it, and the files.split and art.fetch handlers worked the way index.ts
 * registers them on the file worker. A one-file album is a real 75 s FLAC
 * made by ffmpeg (this Mac has no flac: ffmpeg and ffprobe stand in).
 *
 * 0.29.0 hung here: every task on a stately queue shared one empty
 * singletonKey, so a second album's cut points could not be queued while the
 * first waited, and an analysis left 'active' by a stopped worker held every
 * other one back until pg-boss expired it hours later.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import postgres from 'postgres';
import { PgBoss } from 'pg-boss';
import {
  dispatchMaintenanceTask, maintenanceSender, makeDb, recoverMaintenanceTasks, runMigrations, saveMaintenanceTask,
  type MaintenanceRequest,
} from '@tagave/db';
import { MAINTENANCE_QUEUES } from '@tagave/core';
import type { FilesSplitJobData } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { FlacTools, type BinaryRunner, type RunResult } from '../lib/flacTools.js';
import { prepareWorkerQueues } from '../lib/queueSetup.js';
import { filesSplitJob } from './filesSplit.js';
import { artFetchTask, type ArtFetchJobData } from './artFetch.js';

const RATE = 44_100;
const LENGTHS = [20_000, 30_000, 25_000];
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const adminUrl = process.env.TEST_DATABASE_URL;

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
  });
}

/** flac and metaflac, as files.split calls them for an analysis, done by ffmpeg and ffprobe. */
const ffmpegRunner: BinaryRunner = async (bin, args) => {
  const file = args[args.length - 1]!;
  const num = (name: string) => Number(args.find((a) => a.startsWith(`--${name}=`))!.split('=')[1]);
  if (bin === 'metaflac') {
    if (args[0] === '--list') return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,bits_per_raw_sample,duration_ts', '-of', 'json', file]);
    if (r.code !== 0) return r;
    const s = JSON.parse(r.stdout.toString()).streams[0];
    const v = { '--show-sample-rate': s.sample_rate, '--show-channels': s.channels, '--show-bps': s.bits_per_raw_sample, '--show-total-samples': s.duration_ts }[args[0]!];
    return { code: 0, stdout: Buffer.from(`${v}\n`), stderr: '' };
  }
  if (args[0] === '-d') {
    return run('ffmpeg', ['-v', 'error', '-i', file, '-af', `atrim=start_sample=${num('skip')}:end_sample=${num('until')}`, '-f', 's16le', '-acodec', 'pcm_s16le', '-']);
  }
  throw new Error(`no ${bin} ${args[0]} in an analysis`);
};
const deps = () => ({ tools: new FlacTools(ffmpegRunner, { flac: 'flac', metaflac: 'metaflac' }), tags: { write: async () => undefined } });

const until = async (what: string, check: () => Promise<boolean>, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe.skipIf(!adminUrl || !hasFfmpeg)('maintenance tasks through pg-boss as production queues them (db, real audio)', () => {
  let admin: postgres.Sql;
  let dbName = '';
  let url = '';
  let sql: postgres.Sql;
  let boss: PgBoss;
  let ctx: WorkerContext;
  let rootPath = '';
  let libraryId = '';
  let userId = '';
  let rootId = '';
  let source = '';

  /** The app's dispatch: intent first, then the job in the same transaction; a refusal is logged and left to the outbox. */
  const ask = async (request: MaintenanceRequest) => {
    const task = await saveMaintenanceTask(sql, request);
    await dispatchMaintenanceTask(sql, maintenanceSender(boss), task.id).catch(() => undefined);
    return task;
  };
  const task = async (id: string) => (await sql`select state, stage, attempt, attempt_id, dispatched_at, error from maintenance_tasks where id = ${id}`)[0]!;
  const split = async (id: string) => (await sql`select state, plan, error from album_splits where id = ${id}`)[0]!;
  const ready = (id: string) => async () => (await split(id)).state === 'ready';
  /** What the file worker does at start (index.ts). */
  const recover = (serves: (queue: string) => boolean = () => true) =>
    recoverMaintenanceTasks(sql, { serves, send: maintenanceSender(boss), cancel: (queue, id) => boss.cancel(queue, id) });

  /** A matched album that is one FLAC holding its three-track release. */
  async function oneFileAlbum(name: string): Promise<string> {
    const dir = `${name}/Album`;
    await mkdir(path.join(rootPath, dir), { recursive: true });
    const rel = `${dir}/whole.flac`;
    await copyFile(source, path.join(rootPath, rel));
    const [rg] = await sql`insert into release_groups (mbid, title) values (${randomUUID()}, ${name}) returning id`;
    const [release] = await sql`insert into releases (release_group_id, mbid, title, track_count) values (${rg!.id}, ${randomUUID()}, ${name}, 3) returning id`;
    for (const [i, len] of LENGTHS.entries()) {
      await sql`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values (${release!.id}, 1, ${i + 1}, ${`Track ${i + 1}`}, ${len})`;
    }
    const [album] = await sql`insert into local_albums (library_id, cluster_key, title_guess, artist_guess, state, dir_paths, track_count, release_id, release_group_id)
      values (${libraryId}, ${`ck-${name}`}, ${name}, 'Artist', 'matched', ${[dir]}, 1, ${release!.id}, ${rg!.id}) returning id`;
    const [file] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, duration_ms, container)
      values (${libraryId}, ${rootId}, ${rel}, 10, 1, 'present', 'audio', 75000, 'FLAC') returning id`;
    await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin) values (${album!.id}, ${file!.id}, 1, 'Whole', 'file')`;
    return album!.id as string;
  }

  /** What POST …/split does for an album: a split row finding its cuts, and its analysis task. */
  async function askCutPoints(albumId: string): Promise<{ splitId: string; taskId: string }> {
    const [row] = await sql`insert into album_splits (library_id, local_album_id, state, created_by)
      values (${libraryId}, ${albumId}, 'analyzing', ${userId}) returning id::text as id`;
    const t = await ask({
      libraryId, kind: 'split', scope: `${row!.id}:analyze`, subjectId: albumId,
      queue: 'files.split', input: { splitId: row!.id, action: 'analyze' }, stage: 'Cut point analysis queued',
    });
    return { splitId: row!.id as string, taskId: t.id };
  }

  /** The file worker's handlers, registered as index.ts registers them. */
  async function startFileWorker(): Promise<() => Promise<void>> {
    await boss.work<FilesSplitJobData>('files.split', { batchSize: 1, pollingIntervalSeconds: 0.5 }, async (jobs) => {
      for (const job of jobs) await filesSplitJob(ctx, job.data, deps());
    });
    await boss.work<ArtFetchJobData>('art.fetch', { batchSize: 4, pollingIntervalSeconds: 0.5 }, async (jobs) => {
      await Promise.all(jobs.map(({ data }) => artFetchTask(ctx, data)));
    });
    return async () => {
      await boss.offWork('files.split');
      await boss.offWork('art.fetch');
    };
  }

  /**
   * A file worker that took the job and claimed the task, then stopped (a
   * restart, an update): the job stays 'active' and nobody holds the claim.
   * The job is taken as pg-boss's fetch takes it, by id, so no other queued
   * job is picked up instead.
   */
  async function abandonedClaim(t: { id: string; queue: string; scope: string; kind: string }): Promise<void> {
    const { attempt_id: jobId } = await task(t.id);
    const session = postgres(url, { max: 1, onnotice: () => undefined });
    const taken = await session`update pgboss.job set state = 'active', started_on = now(), heartbeat_on = now()
      where name = ${t.queue} and id = ${jobId} and state = 'created' returning id`;
    expect(taken).toHaveLength(1);
    const key = `tagave:maintenance:${JSON.stringify([libraryId, t.kind, t.scope])}`;
    await session`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    await session`update maintenance_tasks set state = 'running', stage = 'Finding cut points' where id = ${t.id}`;
    await session.end();
  }

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    dbName = `tagave_maint_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await admin.unsafe(`create database ${dbName}`);
    const u = new URL(adminUrl!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    await runMigrations(url, { log: () => undefined });
    const made = await makeDb(url);
    sql = made.client;
    boss = new PgBoss({ connectionString: url, supervise: false, schedule: false });
    boss.on('error', () => undefined);
    await boss.start();
    await prepareWorkerQueues(boss, sql);
    ctx = { db: made.db, sql, boss, logger: pino({ level: 'silent' }) };

    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-maint-'));
    source = path.join(rootPath, 'source.flac');
    // 75 s of tone, silent for 300 ms where the tracks really meet (20.5 s and 49.3 s)
    const made75 = await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      `aevalsrc='if(lt(abs(t-20.5),0.15)+lt(abs(t-49.3),0.15),0,0.3*sin(2*PI*440*t))':s=${RATE}:d=75`, '-c:a', 'flac', '-sample_fmt', 's16', source]);
    expect(made75.code, made75.stderr).toBe(0);
    const [user] = await sql`insert into users (email, password_hash) values ('owner@test.com', 'x') returning id::text as id`;
    userId = user!.id as string;
    const [lib] = await sql`insert into libraries (name, owner_user_id, settings) values ('Music', ${userId}, '{}') returning id::text as id`;
    libraryId = lib!.id as string;
    const [root] = await sql`insert into scan_roots (library_id, path, display_name, validation_status, writable, probe_writable)
      values (${libraryId}, ${rootPath}, 'music', 'ok', true, true) returning id::text as id`;
    rootId = root!.id as string;
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false }).catch(() => undefined);
    await sql?.end({ timeout: 5 });
    if (dbName) await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
    if (rootPath) await rm(rootPath, { recursive: true, force: true });
  });

  it('queues two albums\' cut points at once, and the file worker finds both', async () => {
    const a = await askCutPoints(await oneFileAlbum('Air'));
    const b = await askCutPoints(await oneFileAlbum('Other'));
    expect((await task(a.taskId)).dispatched_at).not.toBeNull();
    expect((await task(b.taskId)).dispatched_at).not.toBeNull();
    const stop = await startFileWorker();
    try {
      await until('both analyses', async () => (await ready(a.splitId)()) && (await ready(b.splitId)()));
    } finally {
      await stop();
    }
    expect((await split(a.splitId)).plan.tracks).toHaveLength(3);
    expect(await task(a.taskId)).toMatchObject({ state: 'done', stage: 'Cut points ready' });
    expect(await task(b.taskId)).toMatchObject({ state: 'done', stage: 'Cut points ready' });
  }, 60_000);

  it('an analysis a stopped worker left running holds nothing back, and runs again when the worker starts', async () => {
    const left = await askCutPoints(await oneFileAlbum('Left'));
    await abandonedClaim({ id: left.taskId, queue: 'files.split', kind: 'split', scope: `${left.splitId}:analyze` });
    const next = await askCutPoints(await oneFileAlbum('Next'));
    expect((await task(next.taskId)).dispatched_at).not.toBeNull();

    // the new worker, at start: the claim nobody holds any more is given up
    const recovered = await recover();
    expect(recovered.requeued).toEqual([left.taskId]);
    const stop = await startFileWorker();
    try {
      await until('both analyses', async () => (await ready(left.splitId)()) && (await ready(next.splitId)()));
    } finally {
      await stop();
    }
    expect(await task(left.taskId)).toMatchObject({ state: 'done', attempt: 2 });
    // once: nothing left to recover on the next start
    expect(await recover())
      .toEqual({ requeued: [], interrupted: [], legacy: [] });
  }, 60_000);

  it('a running task whose worker still holds it is left alone', async () => {
    const held = await askCutPoints(await oneFileAlbum('Held'));
    const session = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const key = `tagave:maintenance:${JSON.stringify([libraryId, 'split', `${held.splitId}:analyze`])}`;
      await session`select pg_advisory_lock(hashtextextended(${key}, 0))`;
      await sql`update maintenance_tasks set state = 'running' where id = ${held.taskId}`;
      expect((await recover()).requeued).toEqual([]);
      expect((await task(held.taskId)).state).toBe('running');
    } finally {
      await session.end();
      await sql`update maintenance_tasks set state = 'cancelled' where id = ${held.taskId}`;
      await sql`update album_splits set state = 'failed' where id = ${held.splitId}`;
    }
  }, 30_000);

  it('a split a stopped worker left running is interrupted for the owner to continue, not run again on its own', async () => {
    const albumId = await oneFileAlbum('Writing');
    const [row] = await sql`insert into album_splits (library_id, local_album_id, state, created_by)
      values (${libraryId}, ${albumId}, 'splitting', ${userId}) returning id::text as id`;
    const t = await ask({
      libraryId, kind: 'split', scope: `${row!.id}:split`, subjectId: albumId,
      queue: 'files.split', input: { splitId: row!.id, action: 'split' }, stage: 'Split queued',
    });
    await abandonedClaim({ id: t.id, queue: 'files.split', kind: 'split', scope: `${row!.id}:split` });
    const recovered = await recover();
    expect(recovered.interrupted).toEqual([t.id]);
    expect(await task(t.id)).toMatchObject({ state: 'interrupted', error: 'The worker stopped before this task finished.' });
    expect((await sql`select state from pgboss.job where id = ${t.attempt_id}`)[0]?.state).not.toBe('active');
  }, 30_000);

  it('an owner\'s cover lookup is queued while the album\'s routine lookup waits, and a stopped one runs again', async () => {
    const [album] = await sql`insert into local_albums (library_id, cluster_key, title_guess, artist_guess, state, track_count)
      values (${libraryId}, 'ck-cover', 'Cover', 'Artist', 'matched', 0) returning id::text as id`;
    const albumId = album!.id as string;
    // a routine lookup (enrich, the art sweep) already waiting for the same album
    expect(await boss.send('art.fetch', { localAlbumId: albumId }, { singletonKey: `art:${albumId}` })).toBeTruthy();
    const cover = { libraryId, kind: 'cover' as const, scope: albumId, subjectId: albumId, queue: 'art.fetch', input: { localAlbumId: albumId }, stage: 'Waiting to look for cover art' };
    const t = await ask(cover);
    expect((await task(t.id)).dispatched_at).not.toBeNull();
    await abandonedClaim({ id: t.id, queue: 'art.fetch', kind: 'cover', scope: albumId });
    expect((await recover()).requeued).toEqual([t.id]);
    const stop = await startFileWorker();
    try {
      await until('the cover lookup', async () => (await task(t.id)).state === 'done');
    } finally {
      await stop();
    }
    expect(await task(t.id)).toMatchObject({ state: 'done', stage: 'No cover art found', attempt: 2 });
  }, 60_000);

  it('a 0.27 analysis with no job left gets a task at worker start; one whose job still waits is left to it', async () => {
    const lostAlbum = await oneFileAlbum('Lost');
    const waitingAlbum = await oneFileAlbum('Waiting');
    const [lost] = await sql`insert into album_splits (library_id, local_album_id, state, created_by)
      values (${libraryId}, ${lostAlbum}, 'analyzing', ${userId}) returning id::text as id`;
    const [waiting] = await sql`insert into album_splits (library_id, local_album_id, state, created_by)
      values (${libraryId}, ${waitingAlbum}, 'analyzing', ${userId}) returning id::text as id`;
    // what 0.27 sent for the one still waiting
    await boss.send('files.split', { splitId: waiting!.id, action: 'analyze' }, { singletonKey: `files.split:${waiting!.id}:analyze` });
    const recovered = await recover();
    expect(recovered.legacy).toEqual([lost!.id]);
    const [made] = await sql`select id, state, dispatched_at from maintenance_tasks where scope_key = ${`${lost!.id}:analyze`}`;
    expect(made?.dispatched_at).not.toBeNull();
    expect(await sql`select id from maintenance_tasks where scope_key = ${`${waiting!.id}:analyze`}`).toEqual([]);
    const stop = await startFileWorker();
    try {
      await until('both analyses', async () => (await ready(lost!.id)()) && (await ready(waiting!.id)()));
    } finally {
      await stop();
    }
    expect((await recover()).legacy).toEqual([]);
  }, 60_000);

  it('a worker that does not serve the queue recovers nothing on it', async () => {
    const left = await askCutPoints(await oneFileAlbum('Elsewhere'));
    await abandonedClaim({ id: left.taskId, queue: 'files.split', kind: 'split', scope: `${left.splitId}:analyze` });
    const identifyWorker = (queue: string) => queue.startsWith('identify.');
    expect(await recover(identifyWorker))
      .toEqual({ requeued: [], interrupted: [], legacy: [] });
    expect((await task(left.taskId)).state).toBe('running');
    await recover();
  }, 30_000);

  it.each(MAINTENANCE_QUEUES)('queues two tasks on %s at once under the worker\'s queue policy', async (queue) => {
    const kind = queue === 'art.fetch' ? 'cover' : queue === 'files.trash' ? 'empty-trash' : queue === 'files.upgrade' ? 'flac-upgrade'
      : queue === 'files.embedCover' ? 'embed-cover' : 'split';
    const subject = randomUUID();
    const input = queue === 'art.fetch' ? { localAlbumId: subject } : { planId: subject };
    const one = await ask({ libraryId, kind, scope: `guard:${randomUUID()}`, subjectId: subject, queue, input, stage: 'Queued' });
    const two = await ask({ libraryId, kind, scope: `guard:${randomUUID()}`, subjectId: subject, queue, input, stage: 'Queued' });
    expect((await task(one.id)).dispatched_at).not.toBeNull();
    expect((await task(two.id)).dispatched_at).not.toBeNull();
    expect(await sql`select state from pgboss.job where id in (${one.attempt_id}, ${two.attempt_id})`).toHaveLength(2);
    await sql`update maintenance_tasks set state = 'cancelled' where id in (${one.id}, ${two.id})`;
    await sql`delete from pgboss.job where id in (${one.attempt_id}, ${two.attempt_id})`;
  }, 30_000);
});
