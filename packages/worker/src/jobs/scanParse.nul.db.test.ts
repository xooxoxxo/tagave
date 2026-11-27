/**
 * A parser result that carries NUL bytes in free text (codec, container, tag
 * keys) is stored as a present file, NULs stripped, not as a parse error.
 * music-metadata is stubbed: no real file yields these values on demand.
 * The parse normally runs in a file helper, where the stub cannot reach, so
 * this suite's gate runs the handler's parse in this process; every other
 * call goes to the real helper.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import { fileTypeHandler } from '@tagave/core/files';
import type { WorkerContext } from '../lib/context.js';
import { FileGate, setFileGate, type GateOp, type RunOptions } from '../lib/fileGate.js';

vi.mock('music-metadata', () => ({
  parseFile: async () => ({
    format: { container: 'FL\u0000AC', codec: 'FLAC\u0000\u0000', lossless: true, duration: 10 },
    common: { title: 'Song', 'odd\u0000key': 'v' },
    native: { 'vorbis\u0000': [{ id: 'TI\u0000TLE', value: 'Song' }] },
  }),
}));
const { scanParseJob } = await import('./scanParse.js');

class InProcessParse extends FileGate {
  override run<T>(rootId: string, op: GateOp, opts?: RunOptions): Promise<T> {
    if (op.op === 'parse') return fileTypeHandler(op.handlerId)!.parse(op.path) as Promise<T>;
    return super.run<T>(rootId, op, opts);
  }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('scan.parse strips NUL from what it stores (db)', () => {
  let ctx: WorkerContext; let sql: any; let rootPath: string; let gate: FileGate;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID(); const fileId = randomUUID();

  beforeAll(async () => {
    gate = new InProcessParse();
    setFileGate(gate);
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-parsenul-'));
    await writeFile(path.join(rootPath, '1.flac'), 'x');
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`spn-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'SPN', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, ${rootPath}, 'spn')`;
    await sql`insert into files (id, library_id, scan_root_id, rel_path, handler) values (${fileId}, ${libraryId}, ${rootId}, '1.flac', 'audio')`;
  });

  afterAll(async () => {
    setFileGate(null);
    await gate.close();
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('codec, container and tag keys lose their NULs; the file is present', async () => {
    await scanParseJob(ctx, { audioFileIds: [fileId] });
    const [r] = await sql`select status, parse_error, codec, container, tags_raw from files where id = ${fileId}`;
    expect(r.parse_error).toBeNull();
    expect(r.status).toBe('present');
    expect([r.codec, r.container]).toEqual(['FLAC', 'FLAC']);
    expect(r.tags_raw.common).toMatchObject({ oddkey: 'v' });
    expect(r.tags_raw.native).toEqual({ vorbis: [{ id: 'TITLE', value: 'Song' }] });
  });
});
