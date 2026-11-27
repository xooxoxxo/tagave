/**
 * Scans through the file gate (vault "tagave - Offline Library Spec"): a scan
 * that meets an offline music folder marks nothing missing anywhere, not even
 * in folders it walked, and parks for the folder's return. The root's gate
 * is the real helper for every path but one sub-folder, `Dead`, whose calls
 * go to the fake helper's `hang` (a file call on a dead share that never
 * answers). Build first: the real helper is the built dist/lib/fileHelper.js.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { FileGate, setFileGate, type GateOp } from '../lib/fileGate.js';
import { isMountPoint } from '../lib/musicFolder.js';
import { parkable } from '../lib/parking.js';
import { OFFLINE_SKIP } from '../lib/scanFinish.js';
import { clusterDirJob, type ClusterDirJobData } from './clusterDir.js';
import { rootsValidateJob } from './rootsValidate.js';
import { scanDirJob, type ScanDirJobData } from './scanDir.js';
import { scanParseJob, type ScanParseJobData } from './scanParse.js';
import { scanRootJob, type ScanRootJobData } from './scanRoot.js';

const FAKE = fileURLToPath(new URL('../testkit/fakeHelper.mjs', import.meta.url));
const DEAD = `${path.sep}Dead`;

const BROKEN = `${path.sep}Broken`;

/**
 * The real gate, except that a path under a `Dead` folder hangs (the fake
 * helper's `hang`), and, while `broken` is set, a path under `Broken`
 * answers that code (for the listed ops, or all): EIO through the fake
 * helper (the share answering), EHELPER as the gate does for a helper that
 * failed, EGATECLOSED as it does once it is closed (the worker stopping).
 */
class DeadFolderGate extends FileGate {
  readonly dead = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 600, helpers: 2, stuckMax: 4 } });
  broken: { code: 'EIO' | 'EHELPER' | 'EGATECLOSED'; ops?: GateOp['op'][] } | null = null;
  override run<T>(rootId: string, op: GateOp, opts?: { probe?: boolean }): Promise<T> {
    const p = (op as { path?: string; from?: string }).path ?? (op as { from?: string }).from ?? '';
    if (p.includes(DEAD)) return this.dead.run<T>(rootId, { ...op, path: 'hang' } as GateOp, opts);
    if (this.broken && p.includes(BROKEN) && (!this.broken.ops || this.broken.ops.includes(op.op))) {
      if (this.broken.code === 'EIO') return this.dead.run<T>(rootId, { ...op, path: 'eio' } as GateOp, opts);
      const message = this.broken.code === 'EHELPER' ? 'The file helper stopped without an answer' : 'The file gate is closed';
      return Promise.reject(Object.assign(new Error(message), { code: this.broken.code }));
    }
    return super.run<T>(rootId, op, opts);
  }
  override async close(): Promise<void> {
    await Promise.all([super.close(), this.dead.close()]);
  }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('scans and an offline music folder (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let gate: DeadFolderGate;
  let rootPath: string;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const send = vi.fn(async () => null);

  const fileStatuses = async (id: string) =>
    (await sql`select rel_path, status from files where scan_root_id = ${id} order by rel_path`).map((r: any) => ({ ...r }));
  const lastScan = async (id: string) => (await sql`select status, stats from scans where scan_root_id = ${id} order by started_at desc limit 1`)[0];
  const parkedRows = async (id: string) => sql`select queue, singleton_key from parked_jobs where scan_root_id = ${id}`;
  const setReach = (reach: string, reason: string | null) => sql`update scan_roots set reach = ${reach}, reach_reason = ${reason} where id = ${rootId}`;
  const runParked = <T extends object>(queue: string, rootOf: (d: T) => string, handler: (data: T) => Promise<unknown>, data: T) =>
    parkable<T>(ctx, queue, rootOf, () => null, ({ data: d }) => handler(d))({ id: randomUUID(), data });

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`robin-${userId}@example.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Offline', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'offlinetest-scan-'));
    for (const d of ['Alive', 'Lost', 'Dead', 'Broken']) await mkdir(path.join(rootPath, d));
    await writeFile(path.join(rootPath, 'Broken', '4.flac'), 'd');
    await writeFile(path.join(rootPath, 'Alive', '1.flac'), 'a');
    await writeFile(path.join(rootPath, 'Lost', '2.flac'), 'b');
    await writeFile(path.join(rootPath, 'Dead', '3.flac'), 'c');
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, validation_message, validated_at)
              values (${rootId}, ${libraryId}, ${rootPath}, 'Robin music', 'ok', 'as it was', '2026-11-01T10:00:00Z')`;
    // Lost/gone.flac is indexed but not on disk: a complete walk would mark it missing.
    for (const rel of ['Alive/1.flac', 'Lost/2.flac', 'Lost/gone.flac', 'Dead/3.flac', 'Broken/4.flac', 'Broken/gone.flac']) {
      await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, handler, status, tags_raw)
                values (${libraryId}, ${rootId}, ${rel}, 1, 1, 'audio', 'present', '{}')`;
    }
  });

  beforeEach(async () => {
    gate = new DeadFolderGate({ limits: { waitMs: 5_000, idleMs: 5_000 } });
    setFileGate(gate);
    send.mockClear();
    await setReach('online', null);
    await sql`delete from parked_jobs where scan_root_id = ${rootId}`;
  });

  afterEach(async () => {
    setFileGate(null);
    await gate.close();
  });

  afterAll(async () => {
    await sql`delete from parked_jobs where scan_root_id = ${rootId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('a scan that meets a dead share marks nothing missing, even in folders it walked', async () => {
    const before = await fileStatuses(rootId);
    const out = await runParked<ScanRootJobData>('scan.root', (d) => d.scanRootId, (d) => scanRootJob(ctx, d), { scanRootId: rootId, mode: 'full' });
    expect(out).toEqual({ parked: true });
    expect(await fileStatuses(rootId)).toEqual(before);
    expect(await lastScan(rootId)).toMatchObject({ status: 'aborted', stats: { mode: 'full', offline: true, error: OFFLINE_SKIP } });
    expect(await parkedRows(rootId)).toHaveLength(1);
    // nothing was sent on: no parse, no grouping
    expect(send).not.toHaveBeenCalled();
  });

  it('an offline root is parked at once, its path untouched', async () => {
    await setReach('offline', 'timeout');
    const spy = vi.spyOn(gate, 'run');
    const before = await fileStatuses(rootId);
    const out = await runParked<ScanRootJobData>('scan.root', (d) => d.scanRootId, (d) => scanRootJob(ctx, d), { scanRootId: rootId, mode: 'quick' });
    expect(out).toEqual({ parked: true });
    expect(spy).not.toHaveBeenCalled();
    expect(await fileStatuses(rootId)).toEqual(before);
    expect(await lastScan(rootId)).toMatchObject({ status: 'aborted', stats: { offline: true } });
    expect(await parkedRows(rootId)).toHaveLength(1);
  });

  it('a folder rescan that meets a dead share parks and marks nothing', async () => {
    await rm(path.join(rootPath, 'Dead', '3.flac')).catch(() => undefined);
    const before = await fileStatuses(rootId);
    const out = await runParked<ScanDirJobData>('scan.dir', (d) => d.scanRootId, (d) => scanDirJob(ctx, d), { scanRootId: rootId, dirPath: 'Dead' });
    expect(out).toEqual({ parked: true });
    expect(await fileStatuses(rootId)).toEqual(before);
    expect(await parkedRows(rootId)).toHaveLength(1);
    await writeFile(path.join(rootPath, 'Dead', '3.flac'), 'c');
  });

  it('roots.validate skips an offline root', async () => {
    await setReach('offline', 'io_error');
    const spy = vi.spyOn(gate, 'run');
    const cols = async () => (await sql`select validation_status, validation_message, validated_at, probe_writable from scan_roots where id = ${rootId}`)[0];
    const before = await cols();
    await rootsValidateJob(ctx, { scanRootId: rootId });
    expect(await cols()).toEqual(before);
    expect(spy).not.toHaveBeenCalled();
  });

  it('scan.parse parks a file on a dead share, and does not mark it as a failed parse', async () => {
    const [row] = await sql`select id from files where scan_root_id = ${rootId} and rel_path = 'Dead/3.flac'`;
    const out = await runParked<ScanParseJobData>('scan.parse', () => rootId, (d) => scanParseJob(ctx, d), { audioFileIds: [row.id] });
    expect(out).toEqual({ parked: true });
    expect((await sql`select status, parse_error from files where id = ${row.id}`)[0]).toEqual({ status: 'present', parse_error: null });
  });

  it('cluster.dir parks, changing nothing, when the cue sheet it needs is on a dead share', async () => {
    // The read at clusterDir.ts:285 is the folder's cue sheet: it decides the album's tracks, so the job waits whole.
    await sql`insert into sidecar_files (library_id, scan_root_id, rel_path, kind) values (${libraryId}, ${rootId}, 'Dead/3.cue', 'cue')
              on conflict do nothing`;
    const albums = async () => (await sql`select count(*)::int as n from local_albums where library_id = ${libraryId}`)[0].n;
    const before = await albums();
    const out = await runParked<ClusterDirJobData>('cluster.dir', (d) => d.scanRootId, (d) => clusterDirJob(ctx, d), { libraryId, scanRootId: rootId, dirPath: 'Dead' });
    expect(out).toEqual({ parked: true });
    expect(await albums()).toBe(before);
    expect(await parkedRows(rootId)).toHaveLength(1);
  });

  it('a folder whose helper fails (EHELPER) is never taken for gone: scan.dir fails and marks nothing', async () => {
    gate.broken = { code: 'EHELPER', ops: ['access'] };
    const before = await fileStatuses(rootId);
    await expect(runParked<ScanDirJobData>('scan.dir', (d) => d.scanRootId, (d) => scanDirJob(ctx, d), { scanRootId: rootId, dirPath: 'Broken' }))
      .rejects.toMatchObject({ code: 'EHELPER' });
    expect(await fileStatuses(rootId)).toEqual(before);
    expect(await parkedRows(rootId)).toHaveLength(0);
  });

  it('a folder rescan whose helper fails or whose gate closes marks nothing missing (EHELPER, EGATECLOSED)', async () => {
    // Broken/gone.flac is indexed but not on disk: only a complete walk of Broken may mark it.
    for (const code of ['EHELPER', 'EGATECLOSED'] as const) {
      for (const ops of [['readdirPage'], ['stat']] as GateOp['op'][][]) {
        gate.broken = { code, ops };
        const before = await fileStatuses(rootId);
        await expect(runParked<ScanDirJobData>('scan.dir', (d) => d.scanRootId, (d) => scanDirJob(ctx, d), { scanRootId: rootId, dirPath: 'Broken' }))
          .rejects.toMatchObject({ code });
        expect(await fileStatuses(rootId)).toEqual(before);
        expect(before).toContainEqual({ rel_path: 'Broken/gone.flac', status: 'present' });
        expect(await parkedRows(rootId)).toHaveLength(0);
      }
    }
  });

  it('roots.validate stamps no verdict on a root its helper failed on', async () => {
    const cols = async () => (await sql`select validation_status, validation_message, validated_at, probe_writable from scan_roots where id = ${rootId}`)[0];
    const before = await cols();
    vi.spyOn(gate, 'run').mockRejectedValueOnce(Object.assign(new Error('The file helper stopped without an answer'), { code: 'EHELPER' }));
    await expect(rootsValidateJob(ctx, { scanRootId: rootId })).rejects.toMatchObject({ code: 'EHELPER' });
    expect(await cols()).toEqual(before);
  });

  it('a listing whose helper fails (EHELPER) fails the scan and marks nothing missing', async () => {
    await rm(path.join(rootPath, 'Dead'), { recursive: true }); // no hang in this walk
    try {
      gate.broken = { code: 'EHELPER', ops: ['readdirPage'] };
      const before = await fileStatuses(rootId);
      await expect(runParked<ScanRootJobData>('scan.root', (d) => d.scanRootId, (d) => scanRootJob(ctx, d), { scanRootId: rootId, mode: 'full' }))
        .rejects.toMatchObject({ code: 'EHELPER' });
      expect(await fileStatuses(rootId)).toEqual(before);
      expect(await lastScan(rootId)).toMatchObject({ status: 'failed' });
    } finally {
      await mkdir(path.join(rootPath, 'Dead'));
      await writeFile(path.join(rootPath, 'Dead', '3.flac'), 'c');
    }
  });

  it('a folder that answers EIO parks the scan and marks nothing missing', async () => {
    await rm(path.join(rootPath, 'Dead'), { recursive: true }); // EIO alone stops this walk, no hang
    try {
      gate.broken = { code: 'EIO' };
      const before = await fileStatuses(rootId);
      const out = await runParked<ScanRootJobData>('scan.root', (d) => d.scanRootId, (d) => scanRootJob(ctx, d), { scanRootId: rootId, mode: 'full' });
      expect(out).toEqual({ parked: true });
      expect(await fileStatuses(rootId)).toEqual(before);
      expect(await lastScan(rootId)).toMatchObject({ status: 'aborted', stats: { offline: true } });
    } finally {
      await mkdir(path.join(rootPath, 'Dead'));
      await writeFile(path.join(rootPath, 'Dead', '3.flac'), 'c');
    }
  });

  it('scan.parse never stores a good file as unreachable or unparsable when its helper fails', async () => {
    const [row] = await sql`select id from files where scan_root_id = ${rootId} and rel_path = 'Broken/4.flac'`;
    for (const ops of [['access'], ['parse']] as GateOp['op'][][]) {
      gate.broken = { code: 'EHELPER', ops };
      await expect(scanParseJob(ctx, { audioFileIds: [row.id] })).rejects.toMatchObject({ code: 'EHELPER' });
      expect((await sql`select status, parse_error from files where id = ${row.id}`)[0]).toEqual({ status: 'present', parse_error: null });
    }
  });

  it('cluster.dir never groups without its cue sheet when the read fails (EHELPER)', async () => {
    await sql`insert into sidecar_files (library_id, scan_root_id, rel_path, kind) values (${libraryId}, ${rootId}, 'Broken/4.cue', 'cue')
              on conflict do nothing`;
    gate.broken = { code: 'EHELPER', ops: ['readSmall'] };
    const albums = async () => (await sql`select count(*)::int as n from local_albums where library_id = ${libraryId}`)[0].n;
    const before = await albums();
    await expect(clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'Broken' })).rejects.toMatchObject({ code: 'EHELPER' });
    expect(await albums()).toBe(before);
  });
});

describe('isMountPoint', () => {
  const line = (mountPoint: string, fstype: string, source: string) => `36 25 0:52 / ${mountPoint} rw,relatime shared:1 - ${fstype} ${source} rw,hard\n`;
  const base = line('/', 'overlay', 'overlay');

  it('isMountPoint answers on both layouts', async () => {
    // the parent bind: /mnt/music is seen as /mnt/.host/music
    const parent = base + line('/mnt/.host', 'ext4', '/dev/sda1') + line('/mnt/.host/music', 'nfs4', '192.0.2.10:/export/music');
    expect(await isMountPoint('/mnt/music', { readMountinfo: async () => parent, env: { TAGAVE_MUSIC_NAME: 'music' } })).toBe(true);
    expect(await isMountPoint('/mnt/music/Jazz', { readMountinfo: async () => parent, env: { TAGAVE_MUSIC_NAME: 'music' } })).toBe(false);
    // the direct layout: the share is mounted at /mnt/music itself
    const direct = base + line('/mnt/music', 'nfs4', '192.0.2.10:/export/music');
    expect(await isMountPoint('/mnt/music', { readMountinfo: async () => direct, env: {} })).toBe(true);
    expect(await isMountPoint('/mnt/music/', { readMountinfo: async () => direct, env: {} })).toBe(true);
    expect(await isMountPoint('/mnt/music', { readMountinfo: async () => base, env: {} })).toBe(false);
  });

  it('a mount table it cannot read is no mount point', async () => {
    expect(await isMountPoint('/mnt/music', { readMountinfo: async () => { throw new Error('ENOENT'); }, env: {} })).toBe(false);
  });
});
