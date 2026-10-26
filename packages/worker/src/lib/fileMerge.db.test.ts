/**
 * One merge, one transaction: the fresh row (a moved file's new path) is
 * deleted and the old row takes its place, so every id hanging off the old
 * row survives. A fresh row that gained data since the plan, or an old row
 * that moved since the snapshot, is left alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@tagave/db';
import { mergeFilePair } from './fileMerge.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('mergeFilePair (db)', () => {
  let sql: any;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
  const ctx = () => ({ sql });
  const file = async (root: string, relPath: string, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await sql`insert into audio_files ${sql({ id, library_id: libraryId, scan_root_id: root, rel_path: relPath, size_bytes: 10, mtime: 100, status: 'present', ...over })}`;
    return id;
  };
  const row = async (id: string) => (await sql`select scan_root_id, rel_path, status, size_bytes::float8 as size, mtime::float8 as mtime from audio_files where id = ${id}`)[0];

  beforeAll(async () => {
    sql = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`fm-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'FM', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootA}, ${libraryId}, '/a', 'a'), (${rootB}, ${libraryId}, '/b', 'b')`;
  });

  afterAll(async () => {
    await sql`delete from tag_plans where library_id = ${libraryId}`;
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('re-points the old row onto the new path (across roots) and deletes the fresh one', async () => {
    const oldId = await file(rootA, 'X/1.flac', { status: 'missing' });
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key) values (${albumId}, ${libraryId}, ${`k:${albumId}`})`;
    const [t] = await sql`insert into local_tracks (local_album_id, audio_file_id) values (${albumId}, ${oldId}) returning id`;
    const freshId = await file(rootB, 'Y/1.flac');
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/1.flac' }, walkStart: null, allowAbsorb: false });
    expect(out).toMatchObject({ kind: 'merged', oldId, reparse: false, from: { scanRootId: rootA, relPath: 'X/1.flac' }, to: { scanRootId: rootB, relPath: 'Y/1.flac' } });
    expect(await row(oldId)).toMatchObject({ scan_root_id: rootB, rel_path: 'Y/1.flac', status: 'present' });
    expect(await row(freshId)).toBeUndefined();
    expect((await sql`select audio_file_id from local_tracks where id = ${t.id}`)[0].audio_file_id).toBe(oldId);
  });

  it('asks for a re-parse only when size or mtime differ and the fresh row was never parsed', async () => {
    const oldId = await file(rootA, 'X/2.flac', { status: 'missing', inode: '1:5' });
    const freshId = await file(rootA, 'Z/2.flac', { inode: '1:5', mtime: 999 });
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/2.flac' }, walkStart: null, allowAbsorb: false });
    expect(out).toMatchObject({ kind: 'merged', reparse: true });
    expect((await row(oldId)).mtime).toBe(999);
  });

  it('copies the parse of a parsed fresh row (Tier 2) instead of re-parsing', async () => {
    // This client binds jsonb raw: JSON text cast in SQL (repo pattern), not sql.json().
    const setTags = (id: string, title: string) => sql`update audio_files set tags_raw = ${JSON.stringify({ common: { title } })}::text::jsonb where id = ${id}`;
    const oldId = await file(rootA, 'X/3.flac', { status: 'missing' });
    await setTags(oldId, 'old');
    const freshId = await file(rootA, 'Q/3.flac', { mtime: 5, tags_read_at: new Date().toISOString(), core_tags_digest: 'cd', duration_ms: 1234 });
    await setTags(freshId, 'new');
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/3.flac' }, walkStart: null, allowAbsorb: false });
    expect(out).toMatchObject({ kind: 'merged', reparse: false });
    const [r] = await sql`select tags_raw, core_tags_digest, duration_ms from audio_files where id = ${oldId}`;
    expect(r).toMatchObject({ tags_raw: { common: { title: 'new' } }, core_tags_digest: 'cd', duration_ms: 1234 });
  });

  it('skips when the fresh row has tracks (it was clustered meanwhile) and deletes nothing', async () => {
    const oldId = await file(rootA, 'X/4.flac', { status: 'missing' });
    const freshId = await file(rootA, 'W/4.flac');
    await sql`insert into local_tracks (audio_file_id) values (${freshId})`;
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/4.flac' }, walkStart: null, allowAbsorb: false });
    expect(out).toEqual({ kind: 'skipped', reason: 'fresh_has_data' });
    expect(await row(freshId)).toBeDefined();
    expect((await row(oldId)).status).toBe('missing');
  });

  it('skips when the old row is no longer where the snapshot saw it', async () => {
    const oldId = await file(rootA, 'X/5.flac', { status: 'missing' });
    const freshId = await file(rootA, 'V/5.flac');
    await sql`update audio_files set rel_path = 'Moved/5.flac' where id = ${oldId}`;
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/5.flac' }, walkStart: null, allowAbsorb: false });
    expect(out).toEqual({ kind: 'skipped', reason: 'old_moved' });
  });

  it('Tier 1: an old row seen again after the walk began is not a vanished row', async () => {
    const walkStart = new Date(Date.now() - 60_000);
    const oldId = await file(rootA, 'X/6.flac'); // last_seen_at = now() > walkStart
    const freshId = await file(rootA, 'U/6.flac');
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/6.flac' }, walkStart, allowAbsorb: false });
    expect(out).toEqual({ kind: 'skipped', reason: 'old_moved' });
  });
  it('Tier 1: an old row last seen before the walk began merges', async () => {
    const oldId = await file(rootA, 'X/7.flac');
    await sql`update audio_files set last_seen_at = now() - interval '1 hour' where id = ${oldId}`;
    const freshId = await file(rootA, 'T/7.flac');
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/7.flac' }, walkStart: new Date(Date.now() - 60_000), allowAbsorb: false });
    expect(out).toMatchObject({ kind: 'merged', oldId, reparse: false });
    expect(await row(oldId)).toMatchObject({ rel_path: 'T/7.flac', status: 'present' });
    expect(await row(freshId)).toBeUndefined();
  });

  it('skips a fresh row that was tag-planned meanwhile and deletes nothing', async () => {
    const oldId = await file(rootA, 'X/8.flac', { status: 'missing' });
    const freshId = await file(rootA, 'S/8.flac');
    const [plan] = await sql`insert into tag_plans (library_id, name, scope, policy, status, created_by)
                             values (${libraryId}, 'p', '{}', '{}', 'draft', ${userId}) returning id`;
    await sql`insert into tag_plan_items (tag_plan_id, audio_file_id, before, after, diff, status)
              values (${plan.id}, ${freshId}, '{}', '{}', '[]', 'pending')`;
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/8.flac' }, walkStart: null, allowAbsorb: false });
    expect(out).toEqual({ kind: 'skipped', reason: 'fresh_has_data' });
    expect(await row(freshId)).toBeDefined();
    expect((await row(oldId)).status).toBe('missing');
  });

  it('a cluster.dir insert in flight when the merge starts: the merge waits for it, then skips', async () => {
    const oldId = await file(rootA, 'X/9.flac', { status: 'missing' });
    const freshId = await file(rootA, 'R/9.flac');
    let inserted!: () => void; const didInsert = new Promise<void>((r) => { inserted = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const cluster = sql.begin(async (tx: any) => {
      await tx`insert into local_tracks (audio_file_id) values (${freshId})`;
      inserted();
      await gate;
    });
    await didInsert;
    let settled = false;
    const merge = mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/9.flac' }, walkStart: null, allowAbsorb: false })
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false); // blocked on the fresh row's FK lock
    release();
    await cluster;
    expect(await merge).toEqual({ kind: 'skipped', reason: 'fresh_has_data' });
    expect(await row(freshId)).toBeDefined();
    expect((await sql`select count(*)::int as n from local_tracks where audio_file_id = ${freshId}`)[0].n).toBe(1);
  });

  it('keeps an unparseable (error) row as error when nothing changed and nothing was parsed (F13)', async () => {
    const oldId = await file(rootA, 'X/10.flac');
    await sql`update audio_files set status = 'error', last_seen_at = now() - interval '1 hour' where id = ${oldId}`;
    const freshId = await file(rootA, 'P/10.flac');
    const out = await mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath: 'X/10.flac' }, walkStart: new Date(Date.now() - 60_000), allowAbsorb: false });
    expect(out).toMatchObject({ kind: 'merged', reparse: false });
    expect((await row(oldId)).status).toBe('error');
  });

  it('reports fresh_gone when the fresh row was deleted before the merge', async () => {
    const oldId = await file(rootA, 'X/11.flac', { status: 'missing' });
    const out = await mergeFilePair(ctx(), { oldId, freshId: randomUUID(), oldAt: { scanRootId: rootA, relPath: 'X/11.flac' }, walkStart: null, allowAbsorb: false });
    expect(out).toEqual({ kind: 'skipped', reason: 'fresh_gone' });
    expect((await row(oldId)).status).toBe('missing');
  });
  describe('fix round 1', () => {
    const merge = (oldId: string, freshId: string, relPath: string) =>
      mergeFilePair(ctx(), { oldId, freshId, oldAt: { scanRootId: rootA, relPath }, walkStart: null, allowAbsorb: false });

    it('a fresh row whose parse failed counts as parsed: its error comes over', async () => {
      const oldId = await file(rootA, 'X/12.flac', { status: 'missing' });
      const freshId = await file(rootA, 'O/12.flac', { status: 'error', parse_error: 'bad header' });
      const out = await merge(oldId, freshId, 'X/12.flac');
      expect(out).toMatchObject({ kind: 'merged', reparse: false });
      const [r] = await sql`select status, parse_error from audio_files where id = ${oldId}`;
      expect(r).toEqual({ status: 'error', parse_error: 'bad header' });
    });

    it('skips a fresh row a later walk marked missing (fresh_touched) and deletes nothing', async () => {
      const oldId = await file(rootA, 'X/13.flac', { status: 'missing' });
      const freshId = await file(rootA, 'N/13.flac', { status: 'missing' });
      expect(await merge(oldId, freshId, 'X/13.flac')).toEqual({ kind: 'skipped', reason: 'fresh_touched' });
      expect(await row(freshId)).toBeDefined();
      expect((await row(oldId)).rel_path).toBe('X/13.flac');
    });

    it('moves track-scope locks from the fresh id to the old id; the old lock wins a shared field', async () => {
      const oldId = await file(rootA, 'X/14.flac', { status: 'missing' });
      const freshId = await file(rootA, 'M/14.flac');
      const lock = async (scopeId: string, field: string, value: string) => (await sql`
        insert into field_locks (library_id, scope, scope_id, field, value, created_by)
        values (${libraryId}, 'track', ${scopeId}, ${field}, ${JSON.stringify(value)}::text::jsonb, ${userId}) returning id`)[0].id as string;
      const oldTitle = await lock(oldId, 'title', 'Old');
      const freshTitle = await lock(freshId, 'title', 'Fresh');
      const freshGenre = await lock(freshId, 'genre', 'Jazz');
      expect(await merge(oldId, freshId, 'X/14.flac')).toMatchObject({ kind: 'merged' });
      const locks = await sql`select id, scope_id, field, value from field_locks where scope = 'track' and scope_id in (${oldId}, ${freshId}) order by field`;
      expect(locks).toEqual([
        { id: freshGenre, scope_id: oldId, field: 'genre', value: 'Jazz' },
        { id: oldTitle, scope_id: oldId, field: 'title', value: 'Old' },
      ]);
      expect((await sql`select 1 from field_locks where id = ${freshTitle}`).length).toBe(0);
    });

    it('clears audio hash and fingerprint when the bytes changed, keeps them when not', async () => {
      const ident = { audio_hash: 'h1', audio_hash_at: new Date().toISOString(), fingerprint: 'fp', fingerprint_duration: 120, fingerprinted_at: new Date().toISOString() };
      const read = async (id: string) => (await sql`select audio_hash, fingerprint, fingerprint_duration, audio_hash_at is null as no_hash_at, fingerprinted_at is null as no_fp_at from audio_files where id = ${id}`)[0];

      const changedOld = await file(rootA, 'X/15.flac', { status: 'missing', ...ident });
      const changedFresh = await file(rootA, 'L/15.flac', { size_bytes: 11 });
      expect(await merge(changedOld, changedFresh, 'X/15.flac')).toMatchObject({ kind: 'merged', reparse: true });
      expect(await read(changedOld)).toEqual({ audio_hash: null, fingerprint: null, fingerprint_duration: null, no_hash_at: true, no_fp_at: true });

      const sameOld = await file(rootA, 'X/16.flac', { status: 'missing', ...ident });
      const sameFresh = await file(rootA, 'L/16.flac');
      expect(await merge(sameOld, sameFresh, 'X/16.flac')).toMatchObject({ kind: 'merged', reparse: false });
      expect(await read(sameOld)).toEqual({ audio_hash: 'h1', fingerprint: 'fp', fingerprint_duration: 120, no_hash_at: false, no_fp_at: false });
    });
  });
});
