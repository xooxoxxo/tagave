/**
 * cluster.dir is music's grouping job: it is sent only for files whose
 * handler the music app claims (musicFiles.ts). Every sender that starts from
 * file rows is checked here with rows of a handler music does not claim
 * ('test-doc', which this build does not carry either): scan.parse,
 * missing-marking, Tier 1/Tier 2 merges, hold releases and the sweep. Holds,
 * missing-marking and merges themselves still happen for those rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { placeHolds, releaseExpiredHolds, releaseReadyHolds } from './clusterHold.js';
import { loadMatchFiles, runMerges } from './reconcile.js';
import { walkRoot } from './walk.js';
import { clusteredByMusic, MUSIC_HANDLERS } from './musicFiles.js';
import { scanParseJob } from '../jobs/scanParse.js';
import { filesBackfillDigestJob } from '../jobs/filesBackfillDigest.js';
import { writeFlac } from '../testkit/flac.js';

const DOC = 'test-doc';

describe('music files gate', () => {
  it('claims the audio handler only', () => {
    expect(MUSIC_HANDLERS).toEqual(['audio']);
    expect(clusteredByMusic('audio')).toBe(true);
    expect(clusteredByMusic(DOC)).toBe(false);
    expect(clusteredByMusic(null)).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('cluster.dir only for files the music app groups (db)', () => {
  let ctx: WorkerContext; let sql: any; let rootPath: string;
  const sent: Array<{ name: string; data: any }> = [];
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();
  const file = async (relPath: string, handler: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await sql`insert into files ${sql({ id, library_id: libraryId, scan_root_id: rootId, rel_path: relPath, handler, size_bytes: 500, mtime: 100, status: 'present', ...over })}`;
    return id;
  };
  const clustered = () => sent.filter((j) => j.name === 'cluster.dir').map((j) => j.data.dirPath as string).sort();
  const holdOf = async (id: string) => (await sql`select reconcile_hold_at from files where id = ${id}`)[0].reconcile_hold_at;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async (name: string, data: any) => { sent.push({ name, data }); return randomUUID(); } } as any, logger: pino({ level: 'silent' }) };
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-gate-'));
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`gate-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Gate', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, ${rootPath}, 'gate', 'ok')`;
  });
  beforeEach(async () => { sent.length = 0; await sql`delete from files where library_id = ${libraryId}`; });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('scan.parse reads each row by its handler and re-clusters only music folders', async () => {
    await mkdir(path.join(rootPath, 'Music'), { recursive: true });
    await writeFlac(path.join(rootPath, 'Music', '1.flac'), { title: 'x' });
    await mkdir(path.join(rootPath, 'Docs'), { recursive: true });
    await writeFile(path.join(rootPath, 'Docs', 'a.doc'), 'doc');
    const music = await file('Music/1.flac', 'audio');
    const doc = await file('Docs/a.doc', DOC);
    await scanParseJob(ctx, { audioFileIds: [music, doc] });
    const rows = await sql`select id, status, parse_error, tags_read_at is not null as read from files where id = any(${[music, doc]}::uuid[])`;
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    expect(byId.get(music)).toMatchObject({ status: 'present', parse_error: null, read: true });
    expect(byId.get(doc)).toMatchObject({ status: 'error', parse_error: `no file-type handler "${DOC}" in this version`, read: false });
    expect(clustered()).toEqual(['Music']);
  });

  it('holds never pair across handlers', async () => {
    await file('Old/1.doc', DOC, { status: 'missing', last_seen_at: dayAgo() });
    const audio = await file('New/1.flac', 'audio');
    expect(await placeHolds(ctx, [audio])).toEqual([]);
    const doc = await file('NewDoc/1.doc', DOC);
    expect(await placeHolds(ctx, [doc])).toEqual([doc]);
  });

  it('a released hold re-clusters its folder only for music files (scan.parse path)', async () => {
    await file('Old/1.doc', DOC, { status: 'missing', last_seen_at: dayAgo() });
    await file('Old/1.flac', 'audio', { status: 'missing', size_bytes: 600, last_seen_at: dayAgo() });
    const doc = await file('NewDoc/1.doc', DOC);
    const audio = await file('NewMusic/1.flac', 'audio', { size_bytes: 600 });
    expect((await placeHolds(ctx, [doc, audio])).sort()).toEqual([doc, audio].sort());
    await sql`update files set status = 'error', parse_error = 'x' where id = any(${[doc, audio]}::uuid[])`;
    const released = await releaseReadyHolds(ctx, [
      { libraryId, scanRootId: rootId, dirPath: 'NewDoc' }, { libraryId, scanRootId: rootId, dirPath: 'NewMusic' },
    ]);
    expect(await holdOf(doc)).toBeNull();
    expect(await holdOf(audio)).toBeNull();
    expect(released.map((d) => d.dirPath)).toEqual(['NewMusic']);
  });

  it('the sweep releases capped holds of any handler and re-clusters only music folders', async () => {
    await file('Old/1.doc', DOC, { status: 'missing', last_seen_at: dayAgo() });
    await file('Old/1.flac', 'audio', { status: 'missing', size_bytes: 600, last_seen_at: dayAgo() });
    const doc = await file('NewDoc/1.doc', DOC);
    const audio = await file('NewMusic/1.flac', 'audio', { size_bytes: 600 });
    await placeHolds(ctx, [doc, audio]);
    await sql`update files set reconcile_hold_at = now() - interval '61 minutes' where id = any(${[doc, audio]}::uuid[])`;
    expect(await releaseExpiredHolds(ctx, { libraryId })).toBe(2);
    expect(await holdOf(doc)).toBeNull();
    expect(await holdOf(audio)).toBeNull();
    expect(clustered()).toEqual(['NewMusic']);
  });

  it('a merge re-clusters its old and new folders only for music files (Tier 1 and Tier 2 path)', async () => {
    const walkStart = new Date();
    await file('From/1.doc', DOC, { status: 'missing', last_seen_at: dayAgo() });
    await file('To/1.doc', DOC);
    await file('FromM/1.flac', 'audio', { status: 'missing', size_bytes: 600, last_seen_at: dayAgo() });
    await file('ToM/1.flac', 'audio', { size_bytes: 600 });
    const olds = await loadMatchFiles(ctx, sql`af.library_id = ${libraryId} and af.status = 'missing'`);
    const freshs = await loadMatchFiles(ctx, sql`af.library_id = ${libraryId} and af.status = 'present'`);
    const res = await runMerges(ctx, 1, olds, freshs, walkStart, true);
    expect(res.merged).toBe(2);
    expect(res.reclusterDirs.map((d) => d.dirPath).sort()).toEqual(['FromM', 'ToM']);
    expect(res.moves.map((m) => m.toDir).sort()).toEqual(['To', 'ToM']);
  });

  it('a file never pairs with a file of another handler', async () => {
    await file('From/1.flac', 'audio', { status: 'missing', last_seen_at: dayAgo() });
    await file('To/1.flac', DOC);
    const olds = await loadMatchFiles(ctx, sql`af.library_id = ${libraryId} and af.status = 'missing'`);
    const freshs = await loadMatchFiles(ctx, sql`af.library_id = ${libraryId} and af.status = 'present'`);
    expect((await runMerges(ctx, 1, olds, freshs, new Date(), true)).merged).toBe(0);
  });

  it('a scan marks rows of any handler missing but re-clusters only the music folders that lost files', async () => {
    await file('GoneDoc/1.doc', DOC, { last_seen_at: dayAgo() });
    await file('GoneMusic/1.flac', 'audio', { last_seen_at: dayAgo() });
    await writeFlac(path.join(rootPath, 'Here.flac'), { title: 'here' });
    const r = await walkRoot(ctx, { id: rootId, libraryId, path: rootPath }, { mode: 'full' });
    expect(r.missing).toBe(2);
    expect(r.dirsWithMissing).toEqual(['GoneMusic']);
    const added = await sql`select handler, media_type from files where library_id = ${libraryId} and rel_path = 'Here.flac'`;
    expect(added).toEqual([{ handler: 'audio', media_type: 'audio/flac' }]);
  });

  it('files.backfillDigest takes the digest from the row\'s handler: none for a handler this build lacks', async () => {
    const raw = JSON.stringify({ common: { title: 'T', artist: 'A', track: { no: 1 } } });
    const doc = await file('D/1.doc', DOC);
    const audio = await file('D/1.flac', 'audio');
    await sql`update files set tags_raw = ${raw}::text::jsonb where id = any(${[doc, audio]}::uuid[])`;
    await filesBackfillDigestJob(ctx, {});
    const rows = await sql`select id, core_tags_digest from files where id = any(${[doc, audio]}::uuid[])`;
    const byId = new Map(rows.map((r: any) => [r.id, r.core_tags_digest]));
    expect(byId.get(doc)).toBeNull();
    expect(byId.get(audio)).toMatch(/^[0-9a-f]{40}$/);
  });
});
