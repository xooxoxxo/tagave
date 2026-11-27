/**
 * Ruling R34: one file that hangs (a FIFO indexed as a track) or answers EIO
 * on a live music share must not park its scan.parse batch for good. While
 * the root reads online, the file gets its error after three re-parks and the
 * rest of the batch is parsed. A root read offline never stamps an error.
 * The real file helper (build first) for every path but the ones a test
 * routes to the fake helper.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { FileGate, setFileGate, type GateOp } from '../lib/fileGate.js';
import { parkable } from '../lib/parking.js';
import { HUNG_FILE_ERROR, HUNG_REPARKS_MAX, scanParseJob, type ScanParseJobData } from './scanParse.js';

const FAKE = fileURLToPath(new URL('../testkit/fakeHelper.mjs', import.meta.url));

/** A tiny valid WAV: 8 samples of silence. */
function wav(): Buffer {
  const data = Buffer.alloc(16);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function mkfifoAvailable(): boolean {
  try {
    execSync('which mkfifo', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** The real gate; the parse of a file named `... Bad.wav` answers EIO through the fake helper (the share answering for one bad file). */
class OneBadFileGate extends FileGate {
  readonly fake = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 600, helpers: 1, stuckMax: 4 } });
  override run<T>(rootId: string, op: GateOp, opts?: { probe?: boolean }): Promise<T> {
    const p = (op as { path?: string }).path ?? '';
    if (p.endsWith(' Bad.wav') && op.op === 'parse') return this.fake.run<T>(rootId, { ...op, path: 'eio' } as GateOp, opts);
    return super.run<T>(rootId, op, opts);
  }
  override async close(): Promise<void> {
    await Promise.all([super.close(), this.fake.close()]);
  }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('scan.parse and one file that hangs on a live share (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let gate: OneBadFileGate;
  let rootPath: string;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const send = vi.fn(async () => null);

  const setReach = (reach: string) => sql`update scan_roots set reach = ${reach}, reach_since = now() where id = ${rootId}`;
  const file = async (rel: string) => {
    const [row] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, handler, status)
                            values (${libraryId}, ${rootId}, ${rel}, 1, 1, 'audio', 'present') returning id::text as id`;
    return row.id as string;
  };
  const state = async (id: string) =>
    (await sql`select status, parse_error, tags_read_at is not null as read from files where id = ${id}`)[0];
  const run = (data: ScanParseJobData) =>
    parkable<ScanParseJobData>(ctx, 'scan.parse', () => rootId, () => null, ({ data: d }) => scanParseJob(ctx, d))({ id: randomUUID(), data });
  /** The watch's release (stillOnline or onlineAgain, in short): the gate takes work again, the parked row is sent again. */
  const resend = async (): Promise<ScanParseJobData> => {
    gate.clear(rootId);
    const rows = await sql`delete from parked_jobs where scan_root_id = ${rootId} and queue = 'scan.parse' returning data`;
    expect(rows).toHaveLength(1);
    return rows[0].data as ScanParseJobData;
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`robin-${userId}@example.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Hung', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'offlinetest-hung-'));
    await mkdir(path.join(rootPath, 'Album'));
    for (const name of ['02 Good.wav', '03 Bad.wav', '04 Good.wav', '05 Bad.wav', '06 Good.wav']) {
      await writeFile(path.join(rootPath, 'Album', name), wav());
    }
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, reach, reach_since)
              values (${rootId}, ${libraryId}, ${rootPath}, 'Robin music', 'ok', 'online', now() - interval '1 hour')`;
  });

  afterEach(async () => {
    setFileGate(null);
    await gate?.close();
    await sql`delete from parked_jobs where scan_root_id = ${rootId}`;
    await sql`update scan_roots set reach = 'online', reach_since = now() - interval '1 hour' where id = ${rootId}`;
  });

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  /** Parks once and HUNG_REPARKS_MAX times more, the bad file and the good one untouched; the next run marks the bad one and parses the rest. */
  async function parksThenMarks(bad: string, good: string): Promise<void> {
    let data: ScanParseJobData = { audioFileIds: [bad, good] };
    for (let park = 1; park <= HUNG_REPARKS_MAX + 1; park++) {
      expect(await run(data)).toEqual({ parked: true });
      expect(await state(bad)).toMatchObject({ status: 'present', parse_error: null });
      expect(await state(good)).toMatchObject({ read: false });
      data = await resend();
      expect(data.hung).toMatchObject({ fileId: bad, parks: park });
    }
    expect(await run(data)).toBeUndefined();
    expect(await state(bad)).toMatchObject({ status: 'error', parse_error: HUNG_FILE_ERROR });
    expect(await state(good)).toMatchObject({ status: 'present', parse_error: null, read: true });
    expect(await sql`select 1 from parked_jobs where scan_root_id = ${rootId}`).toHaveLength(0);
  }

  it.skipIf(!mkfifoAvailable())('a FIFO indexed as a track: after three re-parks it gets its error, the rest is parsed', async () => {
    gate = new OneBadFileGate({ limits: { waitMs: 1_000, idleMs: 1_000, helpers: 2, stuckMax: 4 } });
    setFileGate(gate);
    execFileSync('mkfifo', [path.join(rootPath, 'Album', '01 Pipe.wav')]);
    await parksThenMarks(await file('Album/01 Pipe.wav'), await file('Album/02 Good.wav'));
  }, 60_000);

  it('a file that answers EIO on a live share: the same', async () => {
    gate = new OneBadFileGate({ limits: { waitMs: 5_000, idleMs: 5_000, helpers: 2, stuckMax: 4 } });
    setFileGate(gate);
    await parksThenMarks(await file('Album/03 Bad.wav'), await file('Album/04 Good.wav'));
  }, 60_000);

  it('a root that reads offline (or goes away and comes back) across many re-parks never stamps an error', async () => {
    gate = new OneBadFileGate({ limits: { waitMs: 5_000, idleMs: 5_000, helpers: 2, stuckMax: 4 } });
    setFileGate(gate);
    const bad = await file('Album/05 Bad.wav');
    const good = await file('Album/06 Good.wav');
    let data: ScanParseJobData = { audioFileIds: [bad, good] };
    for (let i = 0; i < (HUNG_REPARKS_MAX + 2) * 2; i++) {
      // a real outage: read offline, or read offline and back since the last park
      if (i % 2 === 0) await setReach('offline');
      else await setReach('online');
      expect(await run(data)).toEqual({ parked: true });
      if (i % 2 === 1) await setReach('offline');
      data = await resend();
      expect(data.hung?.parks ?? 0).toBeLessThanOrEqual(1);
    }
    expect(await state(bad)).toMatchObject({ status: 'present', parse_error: null });
  }, 60_000);
});
