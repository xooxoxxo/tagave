/**
 * A Tag Plan whose music folder goes offline mid-apply (vault "tagave -
 * Offline Library Spec", Decision 2: tag writes resume on their own). Real
 * temp files, the real file helper and its tag writer, and a real pg-boss on
 * a database of its own. The gate's fake helper `hang` stands in for files
 * on a dead share: the plan waits, its job parks, and the return applies the
 * rest. No file is ever half written: every audio hash stays the same.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import postgres from 'postgres';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashAudioStream } from '@tagave/core';
import { makeDb, runMigrations } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { FileGate, setFileGate, type GateOp } from '../lib/fileGate.js';
import { FolderOfflineError } from '../lib/folderOffline.js';
import { onlineAgain } from '../lib/folderWatch/watch.js';
import { parkable, rootOfPlan } from '../lib/parking.js';
import { prepareWorkerQueues } from '../lib/queueSetup.js';
import { tempPrefixFor } from '../lib/safeFileWriter.js';
import { MutagenTagWriter, resolvePythonInterpreter } from '../lib/tagWriter.js';
import { tagsApplyJob, type TagsApplyJobData } from './tagsApply.js';
import { tagsPreviewJob } from './tagsPreview.js';

const json = (v: unknown) => JSON.stringify(v);
const FAKE = fileURLToPath(new URL('../testkit/fakeHelper.mjs', import.meta.url));
const adminUrl = process.env.TEST_DATABASE_URL;

function toolsAvailable(): boolean {
  try {
    execSync(`"${resolvePythonInterpreter()}" -c "import mutagen"`, { stdio: 'pipe' });
    execSync('which ffmpeg', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

type Mode = 'ok' | 'hang' | 'cut' | 'closed' | 'fail';

/**
 * The real gate, with a dead share on demand:
 *   hang    the first file the gate is asked about answers; every other file hangs (offline at the deadline)
 *   cut     the write runs, then its answer is lost (the gate gave up just as it finished)
 *   closed  the write meets a closed gate (the worker stopping)
 *   fail    the write answers a plain write error (not offline)
 */
class SwitchGate extends FileGate {
  readonly dead = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 600, helpers: 2, stuckMax: 8 } });
  mode: Mode = 'ok';
  first: string | null = null;
  readonly ops: string[] = [];
  override async run<T>(rootId: string, op: GateOp, opts?: { probe?: boolean }): Promise<T> {
    this.ops.push(op.op);
    const p = (op as { path?: string }).path ?? '';
    if (this.mode === 'hang') {
      this.first ??= p;
      if (p !== this.first) return this.dead.run<T>(rootId, { ...op, path: 'hang' } as GateOp, opts);
    }
    if (this.mode === 'closed' && op.op === 'writeTagged') throw Object.assign(new Error('The file gate is closed'), { code: 'EGATECLOSED' });
    if (this.mode === 'fail' && op.op === 'writeTagged') return { error: 'write_failed: the tag writer refused', code: 'write_error' } as T;
    const out = await super.run<T>(rootId, op, opts);
    if (this.mode === 'cut' && op.op === 'writeTagged') throw new FolderOfflineError(rootId, 'timeout');
    return out;
  }
  override async close(): Promise<void> {
    await Promise.all([super.close(), this.dead.close()]);
  }
}

describe.skipIf(!adminUrl || !toolsAvailable())('tags.apply and an offline music folder (db, pg-boss, real files)', () => {
  let admin: postgres.Sql;
  let dbName = '';
  let sql: postgres.Sql;
  let boss: PgBoss;
  let ctx: WorkerContext;
  let gate: SwitchGate;
  let tagger: MutagenTagWriter;
  let tempDir = '';
  let userId = '';
  let libraryId = '';
  let rootId = '';

  const gateMode = (m: Mode) => {
    gate.mode = m;
    gate.first = null;
  };
  const plan = async (id: string) =>
    (await sql<{ status: string; stats: Record<string, unknown> | null }[]>`select status, stats from tag_plans where id = ${id}`)[0]!;
  const itemStatuses = async (id: string) => {
    const rows = await sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from tag_plan_items where tag_plan_id = ${id} group by status`;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  };
  const runParked = (queue: 'tags.apply', data: TagsApplyJobData) =>
    parkable<TagsApplyJobData>(ctx, queue, (d) => rootOfPlan(ctx, d.planId), (d) => `tags.apply:${d.planId}`,
      ({ data: d }) => tagsApplyJob(ctx, d))({ id: randomUUID(), data });
  /** Runs every queued job of the queue, as the worker would. */
  const drain = async (queue: 'tags.apply') => {
    for (;;) {
      const jobs = await boss.fetch<TagsApplyJobData>(queue, { batchSize: 10 });
      if (!jobs || jobs.length === 0) return;
      for (const job of jobs) {
        await runParked(queue, job.data);
        await boss.complete(queue, job.id);
      }
    }
  };
  const audioHash = (f: string) => hashAudioStream(f, 'mp3');

  /** Three mp3 files with their tags, in the catalogue, and a plan that changes each one's album. */
  async function planOfThree(name: string): Promise<{ planId: string; files: string[] }> {
    const folder = path.join(tempDir, name);
    await fs.mkdir(folder, { recursive: true });
    const planId = randomUUID();
    await sql`insert into tag_plans (id, library_id, name, scope, policy, status, created_by)
      values (${planId}, ${libraryId}, ${`Set album: ${name}`}, ${json({ type: 'library' })}::jsonb,
              ${json({ preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ' })}::jsonb, 'previewed', ${userId})`;
    const out: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const rel = `${name}/0${i} - Track.mp3`;
      const full = path.join(tempDir, rel);
      execSync(`ffmpeg -loglevel error -f lavfi -i "sine=frequency=${300 + i * 100}:duration=1" -c:a libmp3lame -b:a 128k -y "${full}"`, { stdio: 'pipe' });
      await tagger.write(full, { title: `Track ${i}`, artist: 'Robin', album: 'Old album', tracknumber: String(i) }, { id3Version: '2.4' });
      const fileId = randomUUID();
      const st = await fs.stat(full);
      await sql`insert into files (id, library_id, scan_root_id, rel_path, size_bytes, status, handler)
        values (${fileId}, ${libraryId}, ${rootId}, ${rel}, ${st.size}, 'present', 'audio')`;
      const before = { title: `Track ${i}`, artist: 'Robin', album: 'Old album', tracknumber: String(i) };
      await sql`insert into tag_plan_items (tag_plan_id, audio_file_id, before, after, diff, status)
        values (${planId}, ${fileId}, ${json(before)}::jsonb, ${json({ album: 'New album' })}::jsonb,
                ${json([{ field: 'album', before: 'Old album', after: 'New album', reason: 'policy:overwrite' }])}::jsonb, 'pending')`;
      out.push(full);
    }
    return { planId, files: out };
  }

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    dbName = `tagave_tagoff_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
    gate = new SwitchGate({ limits: { waitMs: 15_000, idleMs: 60_000, helpers: 2, stuckMax: 4 } });
    setFileGate(gate);
    tagger = new MutagenTagWriter();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagave-offline-apply-'));
    const [user] = await sql`insert into users (email, password_hash) values ('robin@example.com', 'x') returning id::text as id`;
    userId = user!.id as string;
    const [lib] = await sql`insert into libraries (name, owner_user_id, settings)
      values ('Music', ${userId}, ${json({ tagWritesEnabled: true })}::jsonb) returning id::text as id`;
    libraryId = lib!.id as string;
    const [root] = await sql`insert into scan_roots (library_id, path, display_name, writable, probe_writable, enabled)
      values (${libraryId}, ${tempDir}, 'Robin music', true, true, true) returning id::text as id`;
    rootId = root!.id as string;
  }, 120_000);

  beforeEach(() => {
    gateMode('ok');
  });

  afterAll(async () => {
    setFileGate(null);
    await gate?.close();
    await tagger?.close();
    await boss?.stop({ graceful: false }).catch(() => undefined);
    await sql?.end({ timeout: 5 });
    if (dbName) await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('an outage mid-plan leaves it waiting, then the return applies the rest and the hashes match', async () => {
    const { planId, files } = await planOfThree('Waiting');
    await sql`update tag_plans set stats = ${json({ lastError: 'an older error' })}::jsonb where id = ${planId}`;
    const hashBefore = new Map<string, string>();
    for (const f of files) hashBefore.set(f, await audioHash(f));

    gateMode('hang');
    const out = await runParked('tags.apply', { planId });
    expect(out).toEqual({ parked: true });
    expect(await plan(planId)).toMatchObject({ status: 'waiting', stats: { lastError: 'an older error' } });
    expect(await itemStatuses(planId)).toEqual({ applied: 1, pending: 2 });
    expect(await sql`select queue, singleton_key from parked_jobs where scan_root_id = ${rootId}`)
      .toEqual([{ queue: 'tags.apply', singleton_key: `tags.apply:${planId}` }]);

    gateMode('ok');
    await onlineAgain(ctx)(rootId, 'offline');
    await drain('tags.apply');
    expect(await plan(planId)).toMatchObject({ status: 'applied' });
    expect(await itemStatuses(planId)).toEqual({ applied: 3 });
    for (const f of files) {
      expect(await audioHash(f)).toBe(hashBefore.get(f));
      expect(await tagger.read(f)).toMatchObject({ album: 'New album', artist: 'Robin' });
    }
    expect(await sql`select 1 from parked_jobs where scan_root_id = ${rootId}`).toHaveLength(0);
  }, 120_000);

  it('a write the gate gave up on is checked before it is retried', async () => {
    const { planId, files } = await planOfThree('Cut');
    // only the first file is in this plan
    await sql`delete from tag_plan_items where tag_plan_id = ${planId}
      and audio_file_id in (select id from files where rel_path <> 'Cut/01 - Track.mp3' and scan_root_id = ${rootId})`;
    const file = files[0]!;
    const hashBefore = await audioHash(file);

    gateMode('cut');
    expect(await runParked('tags.apply', { planId })).toEqual({ parked: true });
    expect(await plan(planId)).toMatchObject({ status: 'waiting' });
    // the journal of the cut-off attempt: the hash before, no hash after
    expect(await sql`select status, audio_hash_before, audio_hash_after from tag_plan_items where tag_plan_id = ${planId}`)
      .toEqual([{ status: 'pending', audio_hash_before: hashBefore, audio_hash_after: null }]);
    // the write had finished on the share
    expect(await tagger.read(file)).toMatchObject({ album: 'New album' });
    // and a killed helper leaves its temp copy beside the file (ruling R9)
    const stale = path.join(path.dirname(file), `${tempPrefixFor(file)}${randomUUID()}.mp3`);
    await fs.copyFile(file, stale);
    const other = path.join(path.dirname(file), `${tempPrefixFor(files[1]!)}${randomUUID()}.mp3`);
    await fs.copyFile(files[1]!, other);

    gateMode('ok');
    const writesBefore = gate.ops.filter((o) => o === 'writeTagged').length;
    await onlineAgain(ctx)(rootId, 'offline');
    await drain('tags.apply');
    expect(await plan(planId)).toMatchObject({ status: 'applied' });
    expect(await sql`select status, audio_hash_before, audio_hash_after from tag_plan_items where tag_plan_id = ${planId}`)
      .toEqual([{ status: 'applied', audio_hash_before: hashBefore, audio_hash_after: hashBefore }]);
    // written once: the return found the new tags there and wrote nothing
    expect(gate.ops.filter((o) => o === 'writeTagged').length).toBe(writesBefore);
    expect(await audioHash(file)).toBe(hashBefore);
    await expect(fs.access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    // another file's temp copy is not this file's to remove
    await expect(fs.access(other)).resolves.toBeUndefined();
  }, 120_000);

  const writes = () => gate.ops.filter((o) => o === 'writeTagged').length;
  const setReach = (reach: string, reason: string | null) =>
    sql`update scan_roots set reach = ${reach}, reach_reason = ${reason} where id = ${rootId}`;

  it.each(['paused', 'cancelled'])('a plan %s while it waits stays so when the folder is back: nothing written', async (owner) => {
    const { planId, files } = await planOfThree(`Owner ${owner}`);
    gateMode('hang');
    expect(await runParked('tags.apply', { planId })).toEqual({ parked: true });
    expect(await plan(planId)).toMatchObject({ status: 'waiting' });
    // the owner stops it; the parked job is still there (the worst case: the api drops it, see tagPlansWaiting.db.test.ts)
    await sql`update tag_plans set status = ${owner} where id = ${planId}`;
    gateMode('ok');
    const before = writes();
    const tags = await Promise.all(files.map((f) => tagger.read(f)));
    await onlineAgain(ctx)(rootId, 'offline');
    await drain('tags.apply');
    expect(await plan(planId)).toMatchObject({ status: owner });
    expect(writes()).toBe(before);
    expect(await itemStatuses(planId)).toEqual({ applied: 1, pending: 2 });
    expect(await Promise.all(files.map((f) => tagger.read(f)))).toEqual(tags);
  }, 120_000);

  it('a split in the plan meets an offline folder: the plan pauses for the owner and does not resume on its own', async () => {
    const { planId } = await planOfThree('Split offline');
    const [file] = await sql<{ id: string }[]>`select audio_file_id::text as id from tag_plan_items where tag_plan_id = ${planId} limit 1`;
    await sql`insert into album_splits (library_id, file_id, state, tag_plan_id) values (${libraryId}, ${file!.id}, 'splitting', ${planId})`;
    await setReach('offline', 'timeout');
    try {
      const out = await runParked('tags.apply', { planId });
      expect(out).not.toEqual({ parked: true });
      expect(await plan(planId)).toMatchObject({ status: 'paused', stats: { lastError: 'Paused while the music folder is offline' } });
      expect(await sql`select 1 from parked_jobs where scan_root_id = ${rootId}`).toHaveLength(0);
      await setReach('online', null);
      const before = writes();
      await onlineAgain(ctx)(rootId, 'offline');
      await drain('tags.apply');
      expect(await plan(planId)).toMatchObject({ status: 'paused' });
      expect(writes()).toBe(before);
    } finally {
      await setReach('online', null);
      await sql`delete from album_splits where tag_plan_id = ${planId}`;
    }
  }, 120_000);

  it('a journal whose hash is not the file\'s: the item fails, the plan pauses, nothing is written', async () => {
    const { planId, files } = await planOfThree('Mismatch');
    await sql`update tag_plan_items set audio_hash_before = ${'0'.repeat(64)}, audio_hash_after = null where tag_plan_id = ${planId}`;
    const before = writes();
    await tagsApplyJob(ctx, { planId });
    expect(await plan(planId)).toMatchObject({ status: 'paused' });
    expect((await itemStatuses(planId)).failed).toBeGreaterThanOrEqual(1);
    expect(writes()).toBe(before);
    for (const f of files) expect(await tagger.read(f)).toMatchObject({ album: 'Old album' });
  }, 120_000);

  it('a worker that stops mid-apply leaves the plan applying, its items pending and no last error', async () => {
    const { planId } = await planOfThree('Stopping');
    gateMode('closed');
    await expect(tagsApplyJob(ctx, { planId })).rejects.toMatchObject({ code: 'EGATECLOSED' });
    const p = await plan(planId);
    expect(p.status).toBe('applying');
    expect(p.stats?.['lastError']).toBeUndefined();
    expect(await itemStatuses(planId)).toEqual({ pending: 3 });
  }, 120_000);

  it('an item that fails for another reason keeps no journal of a cut-off write', async () => {
    const { planId } = await planOfThree('Failing');
    gateMode('fail');
    await tagsApplyJob(ctx, { planId });
    expect(await sql`select status, audio_hash_before, audio_hash_after from tag_plan_items where tag_plan_id = ${planId}`)
      .toEqual(Array(3).fill({ status: 'failed', audio_hash_before: null, audio_hash_after: null }));
  }, 120_000);

  it('a re-preview of a waiting plan keeps its items and the cut-off journal', async () => {
    const { planId } = await planOfThree('Preview waiting');
    await sql`update tag_plans set status = 'waiting' where id = ${planId}`;
    await sql`update tag_plan_items set audio_hash_before = ${'1'.repeat(64)}, audio_hash_after = null where tag_plan_id = ${planId}`;
    await tagsPreviewJob(ctx, planId);
    expect(await plan(planId)).toMatchObject({ status: 'waiting' });
    expect(await sql`select status, audio_hash_before from tag_plan_items where tag_plan_id = ${planId}`)
      .toEqual(Array(3).fill({ status: 'pending', audio_hash_before: '1'.repeat(64) }));
  }, 120_000);
});
