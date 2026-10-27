/**
 * cluster.dir is music's grouping job: it is sent only for files whose
 * handler the music app claims (musicFiles.ts). Every sender that starts from
 * file rows is checked here with rows of a handler music does not claim
 * ('test-doc', which this build does not carry either): scan.parse,
 * missing-marking, Tier 1/Tier 2 merges, hold releases and the sweep. Holds,
 * missing-marking and merges themselves still happen for those rows when the
 * walk indexes their handler. The walk indexes only the handlers of apps that
 * are on (installed_modules; music always): a row of any other handler is
 * left alone. cluster.dir's candidates, a tag plan's library and folder
 * scopes and the folder tag editor read music's files only.
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
import { clusteredByMusic, MUSIC_HANDLERS, walkedHandlers } from './musicFiles.js';
import { clusterDirJob } from '../jobs/clusterDir.js';
import { enumerateFilesForScope } from '../jobs/tagsPreview.js';
import { scanParseJob } from '../jobs/scanParse.js';
import { filesBackfillDigestJob } from '../jobs/filesBackfillDigest.js';
import { writeFlac } from '../testkit/flac.js';

const DOC = 'test-doc';

describe('music files gate', () => {
  it('claims the audio handler only, from the music app\u2019s manifest', () => {
    expect(MUSIC_HANDLERS).toEqual(['audio']);
    expect(clusteredByMusic('audio')).toBe(true);
    expect(clusteredByMusic(DOC)).toBe(false);
    expect(clusteredByMusic(null)).toBe(false);
  });

  it('walks the built-in apps’ handlers on a database from before the module ledger (schema skew allowed)', async () => {
    const beforeLedger = (() => Promise.reject(Object.assign(new Error('relation "installed_modules" does not exist'), { code: '42P01' }))) as any;
    expect([...(await walkedHandlers({ sql: beforeLedger }))]).toEqual(['audio']);
    const broken = (() => Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }))) as any;
    await expect(walkedHandlers({ sql: broken })).rejects.toThrow(/connection lost/);
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

  it('a scan marks rows of a handler it walks missing but re-clusters only the music folders that lost files', async () => {
    await file('GoneDoc/1.doc', DOC, { last_seen_at: dayAgo() });
    await file('GoneMusic/1.flac', 'audio', { last_seen_at: dayAgo() });
    await writeFlac(path.join(rootPath, 'Here.flac'), { title: 'here' });
    const r = await walkRoot(ctx, { id: rootId, libraryId, path: rootPath }, { mode: 'full', handlers: new Set(['audio', DOC]) });
    expect(r.missing).toBe(2);
    expect(r.dirsWithMissing).toEqual(['GoneMusic']);
    const added = await sql`select handler, media_type from files where library_id = ${libraryId} and rel_path = 'Here.flac'`;
    expect(added).toEqual([{ handler: 'audio', media_type: 'audio/flac' }]);
  });

  it('the walk indexes the handlers of the apps that are on (music always), and leaves other rows alone', async () => {
    expect([...(await walkedHandlers(ctx))]).toEqual(['audio']);
    // music is built in: its handlers are walked even with its ledger row off
    await sql`update installed_modules set enabled = false, enabled_at = null where id = 'music'`;
    try {
      expect([...(await walkedHandlers(ctx))]).toEqual(['audio']);
    } finally {
      await sql`update installed_modules set enabled = true, enabled_at = now() where id = 'music'`;
    }
    const doc = await file('GoneDoc/1.doc', DOC, { last_seen_at: dayAgo() });
    await file('GoneMusic/1.flac', 'audio', { last_seen_at: dayAgo() });
    await writeFile(path.join(rootPath, 'Here.doc'), 'doc');
    const r = await walkRoot(ctx, { id: rootId, libraryId, path: rootPath }, { mode: 'full' });
    expect(r.missing).toBe(1);
    expect(r.dirsWithMissing).toEqual(['GoneMusic']);
    // the doc row is neither seen nor missing, and a doc on disk is not indexed
    expect(await sql`select status from files where id = ${doc}`).toEqual([{ status: 'present' }]);
    expect(await sql`select 1 from files where library_id = ${libraryId} and rel_path = 'Here.doc'`).toHaveLength(0);
    await rm(path.join(rootPath, 'Here.doc'));
  });

  it('cluster.dir, a tag plan\u2019s library and folder scopes and the folder editor read music\u2019s files only', async () => {
    const tags = (title: string, no: number) => JSON.stringify({ common: { album: 'Mixed', artist: 'A', albumartist: 'A', title, track: { no, of: 2 } } });
    const audio = await file('Mixed/01.flac', 'audio');
    const doc = await file('Mixed/02.doc', DOC);
    await sql`update files set tags_raw = ${tags('one', 1)}::text::jsonb, tags_read_at = now() where id = ${audio}`;
    await sql`update files set tags_raw = ${tags('two', 2)}::text::jsonb, tags_read_at = now() where id = ${doc}`;
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'Mixed' });
    const tracks = await sql`select lt.audio_file_id from local_tracks lt join local_albums la on la.id = lt.local_album_id where la.library_id = ${libraryId}`;
    expect(tracks.map((t: any) => t.audio_file_id)).toEqual([audio]);
    expect(await enumerateFilesForScope(ctx, libraryId, { type: 'library' })).toEqual([audio]);
    expect(await enumerateFilesForScope(ctx, libraryId, { type: 'folder', dirPath: 'Mixed', scanRootId: rootId })).toEqual([audio]);
    expect(doc).not.toBe(audio);
    await sql`delete from local_albums where library_id = ${libraryId}`;
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
