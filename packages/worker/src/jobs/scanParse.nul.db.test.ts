/**
 * A parser result that carries NUL bytes in free text (codec, container, tag
 * keys) is stored as a present file, NULs stripped, not as a parse error.
 * music-metadata is stubbed: no real file yields these values on demand.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';

vi.mock('music-metadata', () => ({
  parseFile: async () => ({
    format: { container: 'FL\u0000AC', codec: 'FLAC\u0000\u0000', lossless: true, duration: 10 },
    common: { title: 'Song', 'odd\u0000key': 'v' },
    native: { 'vorbis\u0000': [{ id: 'TI\u0000TLE', value: 'Song' }] },
  }),
}));
const { scanParseJob } = await import('./scanParse.js');

describe.skipIf(!process.env.TEST_DATABASE_URL)('scan.parse strips NUL from what it stores (db)', () => {
  let ctx: WorkerContext; let sql: any; let rootPath: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID(); const fileId = randomUUID();

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-parsenul-'));
    await writeFile(path.join(rootPath, '1.flac'), 'x');
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`spn-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'SPN', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, ${rootPath}, 'spn')`;
    await sql`insert into audio_files (id, library_id, scan_root_id, rel_path) values (${fileId}, ${libraryId}, ${rootId}, '1.flac')`;
  });

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('codec, container and tag keys lose their NULs; the file is present', async () => {
    await scanParseJob(ctx, { audioFileIds: [fileId] });
    const [r] = await sql`select status, parse_error, codec, container, tags_raw from audio_files where id = ${fileId}`;
    expect(r.parse_error).toBeNull();
    expect(r.status).toBe('present');
    expect([r.codec, r.container]).toEqual(['FLAC', 'FLAC']);
    expect(r.tags_raw.common).toMatchObject({ oddkey: 'v' });
    expect(r.tags_raw.native).toEqual({ vorbis: [{ id: 'TITLE', value: 'Song' }] });
  });
});
