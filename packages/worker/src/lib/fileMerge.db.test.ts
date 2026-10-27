/**
 * One merge, one transaction: the fresh row (a moved file's new path) is
 * deleted and the old row takes its place, so every id hanging off the old
 * row survives. A fresh row that gained data since the plan, or an old row
 * that moved since the snapshot, is left alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { albumKeyLock, makeDb } from '@tagave/db';
import { mergeFilePair, mergeFilePairs, ownerIdentifyRequested } from './fileMerge.js';
import { ensureFakeBossJob, releaseFakeBossJob } from '../testkit/fakeBossJob.js';

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

describe.skipIf(!process.env.TEST_DATABASE_URL)('mergeFilePair absorb (db)', () => {
  let sql: any;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
  const ctx = () => ({ sql });
  const rgIds: string[] = [];

  /** old album (matched, with a track) on root A; fresh album (pending) on root B built from the copy */
  const setup = async () => {
    const oldAlbum = randomUUID(); const freshAlbum = randomUUID();
    const oldId = randomUUID(); const freshId = randomUUID();
    await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, size_bytes, status) values
              (${oldId}, ${libraryId}, ${rootA}, ${`X/${oldId}.flac`}, 10, 'missing'),
              (${freshId}, ${libraryId}, ${rootB}, ${`X/${freshId}.flac`}, 10, 'present')`;
    await sql`insert into local_albums (id, library_id, cluster_key, state) values
              (${oldAlbum}, ${libraryId}, ${`o:${oldAlbum}`}, 'matched'), (${freshAlbum}, ${libraryId}, ${`f:${freshAlbum}`}, 'pending')`;
    const [ot] = await sql`insert into local_tracks (local_album_id, audio_file_id) values (${oldAlbum}, ${oldId}) returning id`;
    const [ft] = await sql`insert into local_tracks (local_album_id, audio_file_id) values (${freshAlbum}, ${freshId}) returning id`;
    return { oldAlbum, freshAlbum, oldId, freshId, oldTrack: ot.id as string, freshTrack: ft.id as string };
  };
  const req = (s: Awaited<ReturnType<typeof setup>>) => ({ oldId: s.oldId, freshId: s.freshId, oldAt: { scanRootId: rootA, relPath: `X/${s.oldId}.flac` }, walkStart: null, allowAbsorb: true });
  const releaseGroup = async () => {
    const [rg] = await sql`insert into release_groups (mbid, title) values (${randomUUID()}, 'RG') returning id`;
    rgIds.push(rg.id);
    return rg.id as string;
  };

  beforeAll(async () => {
    sql = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`ab-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'AB', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootA}, ${libraryId}, '/a', 'a'), (${rootB}, ${libraryId}, '/b', 'b')`;
  });

  afterAll(async () => {
    await sql`delete from tag_plans where library_id = ${libraryId}`;
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql`delete from releases where release_group_id = any(${rgIds}::uuid[])`;
    await sql`delete from release_groups where id = any(${rgIds}::uuid[])`;
    await sql.end({ timeout: 5 });
  });

  it('untouched fresh album: absorbed into the old row, the fresh album and its tracks go, plays move to the old track', async () => {
    const s = await setup();
    await sql`insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, local_album_id, title, started_at, heard, scrobbles)
              values (${userId}, ${libraryId}, ${`p-${s.freshId}`}, 'web', ${s.freshTrack}, ${s.freshAlbum}, 'T', now(), true, false)`;
    const out = await mergeFilePair(ctx(), req(s));
    expect(out).toMatchObject({ kind: 'absorbed', oldId: s.oldId, removedAlbumIds: [s.freshAlbum] });
    expect(await sql`select 1 from local_albums where id = ${s.freshAlbum}`).toHaveLength(0);
    expect((await sql`select rel_path, scan_root_id, status from audio_files where id = ${s.oldId}`)[0]).toMatchObject({ scan_root_id: rootB, status: 'present' });
    expect((await sql`select local_track_id, local_album_id from player_plays where dedupe_key = ${`p-${s.freshId}`}`)[0])
      .toEqual({ local_track_id: s.oldTrack, local_album_id: s.oldAlbum });
  });

  it.each([
    ['an owner lock on the fresh album', async (s: any) => sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${libraryId}, 'album', ${s.freshAlbum}, 'title', ${userId})`],
    ['a confirmed match', async (s: any) => {
      const rg = await releaseGroup();
      const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg}, ${randomUUID()}, 'R') returning id`;
      await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by) values (${libraryId}, ${s.freshAlbum}, ${rel.id}, 0.1, 'confirmed', 'user')`;
    }],
    ['a cluster override', async (s: any) => sql`insert into cluster_overrides (library_id, audio_file_id, local_album_id, created_by) values (${libraryId}, ${s.freshId}, ${s.freshAlbum}, ${userId})`],
    ['a favourite by local track id', async (s: any) => {
      const rg = await releaseGroup();
      await sql`insert into user_reviews (library_id, user_id, release_group_id, favorite_track_ids) values (${libraryId}, ${userId}, ${rg}, ${[s.freshTrack]}::uuid[])`;
    }],
    ['album state as_is', async (s: any) => sql`update local_albums set state = 'as_is' where id = ${s.freshAlbum}`],
    // Ruling 12 and owner-set flags beyond the spec list
    ['album state ignored', async (s: any) => sql`update local_albums set state = 'ignored' where id = ${s.freshAlbum}`],
    ['an owner merge (merged_from)', async (s: any) => sql`update local_albums set merged_from = '{"albums":[]}'::jsonb where id = ${s.freshAlbum}`],
    ['the owner preferring it among duplicates', async (s: any) => sql`update local_albums set preferred = true where id = ${s.freshAlbum}`],
    ['an owner cover', async (s: any) => sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, license_note)
                                              values (${libraryId}, 'local_album', ${s.freshAlbum}, ${s.freshAlbum}, 'front', 'owner', 'owner')`],
    ['a track-scope lock on the fresh file', async (s: any) => sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${libraryId}, 'track', ${s.freshId}, 'title', ${userId})`],
    ['a tag plan item', async (s: any) => {
      const [plan] = await sql`insert into tag_plans (library_id, name, scope, policy, status, created_by) values (${libraryId}, 'p', '{}', '{}', 'draft', ${userId}) returning id`;
      await sql`insert into tag_plan_items (tag_plan_id, audio_file_id, before, after, diff, status) values (${plan.id}, ${s.freshId}, '{}', '{}', '[]', 'pending')`;
    }],
    ['a rejected match (an owner decision, not a confirmation)', async (s: any) => {
      const rg = await releaseGroup();
      const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg}, ${randomUUID()}, 'R') returning id`;
      await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by) values (${libraryId}, ${s.freshAlbum}, ${rel.id}, 0.1, 'rejected', 'user')`;
    }],
    // review round 1: gap decisions and excluded candidates
    ['a gap the owner turned into a task', async (s: any) => sql`insert into gaps (library_id, kind, subject_type, subject_id, state, accepted_at)
                                                                   values (${libraryId}, 'incomplete_album', 'local_album', ${s.freshAlbum}, 'todo', now())`],
    ['a dismissed gap', async (s: any) => sql`insert into gaps (library_id, kind, subject_type, subject_id, state, dismiss_reason, decided_at)
                                                values (${libraryId}, 'quality', 'local_album', ${s.freshAlbum}, 'dismissed', 'not_interested', now())`],
    ['a gap with an owner note', async (s: any) => sql`insert into gaps (library_id, kind, subject_type, subject_id, state, note)
                                                        values (${libraryId}, 'unidentified', 'local_album', ${s.freshAlbum}, 'open', 'check the vinyl')`],
    ['an excluded match candidate', async (s: any) => {
      const rg = await releaseGroup();
      const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg}, ${randomUUID()}, 'R') returning id`;
      await sql`insert into match_candidates (local_album_id, release_id, distance, source, excluded) values (${s.freshAlbum}, ${rel.id}, 0.3, 'mb', true)`;
    }],
  ])('falls back (nothing changes) when the fresh side has %s', async (_label, touch) => {
    const s = await setup();
    await touch(s);
    const out = await mergeFilePair(ctx(), req(s));
    expect(out).toEqual({ kind: 'skipped', reason: 'fresh_touched' });
    expect(await sql`select 1 from audio_files where id = ${s.freshId}`).toHaveLength(1);
    expect(await sql`select 1 from local_albums where id = ${s.freshAlbum}`).toHaveLength(1);
  });

  describe('destination clustered first, acceptance (spec §1)', () => {
    const count = async (q: string) => (await sql.unsafe(q, [libraryId]))[0].n as number;

    it('old id wins: match, locks and cover stay; listens, plays, events and the collection link move; no album is added', async () => {
      const s = await setup();
      // The old album's own history: a confirmed match, an owner lock, a sidecar cover.
      const rg = await releaseGroup();
      const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg}, ${randomUUID()}, 'R') returning id`;
      const [match] = await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by)
                                values (${libraryId}, ${s.oldAlbum}, ${rel.id}, 0.05, 'confirmed', 'user') returning id`;
      const [lock] = await sql`insert into field_locks (library_id, scope, scope_id, field, value, created_by)
                               values (${libraryId}, 'album', ${s.oldAlbum}, 'year', '1999'::jsonb, ${userId}) returning id`;
      const [oldSide] = await sql`insert into sidecar_files (library_id, scan_root_id, rel_path, kind) values (${libraryId}, ${rootA}, 'X/folder.jpg', 'image') returning id`;
      const [newSide] = await sql`insert into sidecar_files (library_id, scan_root_id, rel_path, kind) values (${libraryId}, ${rootB}, 'X/folder.jpg', 'image') returning id`;
      const [oldCover] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
                                   values (${libraryId}, 'local_album', ${s.oldAlbum}, ${s.oldAlbum}, 'front', 'sidecar', ${oldSide.id}, 'x') returning id`;
      // The fresh album: an automatic match and a cover from the same sidecar the old one moved next to (Task 13).
      const [rel2] = await sql`insert into releases (release_group_id, mbid, title) values (${rg}, ${randomUUID()}, 'R2') returning id`;
      await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by) values (${libraryId}, ${s.freshAlbum}, ${rel2.id}, 0.2, 'auto', 'system')`;
      await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
                values (${libraryId}, 'local_album', ${s.freshAlbum}, ${s.freshAlbum}, 'front', 'sidecar', ${newSide.id}, 'x')`;
      // Listening history and a collection link on the fresh side.
      const [listen] = await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                                 values (${userId}, ${libraryId}, ${s.freshAlbum}, now() - interval '1 hour', now(), 1, 1) returning id`;
      const [play] = await sql`insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, local_album_id, title, started_at, heard, scrobbles, player_listen_id)
                               values (${userId}, ${libraryId}, ${`pp-${s.freshId}`}, 'web', ${s.freshTrack}, ${s.freshAlbum}, 'T', now(), true, false, ${listen.id}) returning id`;
      const [event] = await sql`insert into player_events (user_id, library_id, local_track_id, local_album_id, queue_id, kind, played_ms, position_ms, occurred_at)
                                values (${userId}, ${libraryId}, ${s.freshTrack}, ${s.freshAlbum}, ${randomUUID()}, 'completed', 1000, 1000, now()) returning id`;
      const [source] = await sql`insert into collection_sources (library_id, provider) values (${libraryId}, 'discogs') returning id`;
      const [item] = await sql`insert into collection_items (library_id, collection_source_id, provider_item_id, local_album_id)
                               values (${libraryId}, ${source.id}, ${`i-${s.freshId}`}, ${s.freshAlbum}) returning id`;
      // an automatic gap (no owner decision) does not block
      await sql`insert into gaps (library_id, kind, subject_type, subject_id, state) values (${libraryId}, 'quality', 'local_album', ${s.freshAlbum}, 'open')`;
      const albumsBefore = await count('select count(*)::int as n from local_albums where library_id = $1');

      const out = await mergeFilePair(ctx(), req(s));

      expect(out).toMatchObject({ kind: 'absorbed', oldId: s.oldId, removedAlbumIds: [s.freshAlbum] });
      expect(await count('select count(*)::int as n from local_albums where library_id = $1')).toBe(albumsBefore - 1);
      expect(await sql`select id from local_tracks where audio_file_id = ${s.oldId}`).toEqual([{ id: s.oldTrack }]);
      expect(await sql`select id, status from album_matches where local_album_id = ${s.oldAlbum}`).toEqual([{ id: match.id, status: 'confirmed' }]);
      expect(await sql`select id from field_locks where scope = 'album' and scope_id = ${s.oldAlbum}`).toEqual([{ id: lock.id }]);
      // exactly one cover, the old album's own (the sidecar re-point after the merges moves it to the new folder)
      expect(await sql`select id from images where local_album_id = ${s.oldAlbum}`).toEqual([{ id: oldCover.id }]);
      expect(await sql`select count(*)::int as n from images where sidecar_file_id = ${newSide.id}`).toEqual([{ n: 0 }]);
      expect(await sql`select local_album_id from player_listens where id = ${listen.id}`).toEqual([{ local_album_id: s.oldAlbum }]);
      expect(await sql`select local_track_id, local_album_id, player_listen_id from player_plays where id = ${play.id}`)
        .toEqual([{ local_track_id: s.oldTrack, local_album_id: s.oldAlbum, player_listen_id: listen.id }]);
      expect(await sql`select local_track_id, local_album_id from player_events where id = ${event.id}`).toEqual([{ local_track_id: s.oldTrack, local_album_id: s.oldAlbum }]);
      expect(await sql`select local_album_id from collection_items where id = ${item.id}`).toEqual([{ local_album_id: s.oldAlbum }]);
    });

    it('an old album without a cover takes the fresh album\'s embedded cover, now on the old file', async () => {
      const s = await setup();
      const [cover] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, audio_file_id, license_note)
                                values (${libraryId}, 'local_album', ${s.freshAlbum}, ${s.freshAlbum}, 'front', 'embedded', ${s.freshId}, 'x') returning id`;
      expect(await mergeFilePair(ctx(), req(s))).toMatchObject({ kind: 'absorbed', removedAlbumIds: [s.freshAlbum] });
      expect(await sql`select id, entity_id, audio_file_id from images where local_album_id = ${s.oldAlbum}`)
        .toEqual([{ id: cover.id, entity_id: s.oldAlbum, audio_file_id: s.oldId }]);
    });

    it('a collection link moves even when the old album already has one', async () => {
      const s = await setup();
      const [source] = await sql`insert into collection_sources (library_id, provider) values (${libraryId}, 'discogs') returning id`;
      await sql`insert into collection_items (library_id, collection_source_id, provider_item_id, local_album_id) values (${libraryId}, ${source.id}, 'a', ${s.oldAlbum})`;
      await sql`insert into collection_items (library_id, collection_source_id, provider_item_id, local_album_id) values (${libraryId}, ${source.id}, 'b', ${s.freshAlbum})`;
      expect(await mergeFilePair(ctx(), req(s))).toMatchObject({ kind: 'absorbed' });
      expect(await sql`select provider_item_id, local_album_id from collection_items where collection_source_id = ${source.id} order by 1`)
        .toEqual([{ provider_item_id: 'a', local_album_id: s.oldAlbum }, { provider_item_id: 'b', local_album_id: s.oldAlbum }]);
    });

    /** A second old/fresh file pair on the same two albums. */
    const addPair = async (s: Awaited<ReturnType<typeof setup>>, oldOver: { album?: string | null } = {}) => {
      const o = randomUUID(); const f = randomUUID();
      await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, size_bytes, status) values
                (${o}, ${libraryId}, ${rootA}, ${`X/${o}.flac`}, 10, 'missing'), (${f}, ${libraryId}, ${rootB}, ${`X/${f}.flac`}, 10, 'present')`;
      const oldAlbum = 'album' in oldOver ? oldOver.album : s.oldAlbum;
      if (oldAlbum !== null) await sql`insert into local_tracks (local_album_id, audio_file_id) values (${oldAlbum ?? null}, ${o})`;
      await sql`insert into local_tracks (local_album_id, audio_file_id) values (${s.freshAlbum}, ${f})`;
      return { oldId: o, freshId: f, req: { oldId: o, freshId: f, oldAt: { scanRootId: rootA, relPath: `X/${o}.flac` }, walkStart: null, allowAbsorb: true } };
    };

    it('a fresh album is absorbed whole or not at all: one of its files alone falls back, all of them together merge', async () => {
      const s = await setup();
      const p2 = await addPair(s);
      const [listen] = await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                                 values (${userId}, ${libraryId}, ${s.freshAlbum}, now() - interval '2 hours', now(), 2, 2) returning id`;
      expect(await mergeFilePair(ctx(), req(s))).toEqual({ kind: 'skipped', reason: 'fresh_touched' });
      expect(await sql`select count(*)::int as n from local_tracks where local_album_id = ${s.freshAlbum}`).toEqual([{ n: 2 }]);
      const outs = await mergeFilePairs(ctx(), [req(s), p2.req]);
      expect(outs).toMatchObject([{ kind: 'absorbed', oldId: s.oldId, removedAlbumIds: [s.freshAlbum] }, { kind: 'absorbed', oldId: p2.oldId, removedAlbumIds: [] }]);
      expect(await sql`select local_album_id from player_listens where id = ${listen.id}`).toEqual([{ local_album_id: s.oldAlbum }]);
      expect(await sql`select count(*)::int as n from local_tracks where local_album_id = ${s.oldAlbum}`).toEqual([{ n: 2 }]);
    });

    it('pair 3 of 3 failing its check leaves the whole fresh album (and all three pairs) alone', async () => {
      const s = await setup();
      const p2 = await addPair(s); const p3 = await addPair(s);
      await sql`update audio_files set rel_path = ${`Y/${p3.oldId}.flac`} where id = ${p3.oldId}`; // moved since the snapshot
      const outs = await mergeFilePairs(ctx(), [req(s), p2.req, p3.req]);
      expect(outs).toEqual([{ kind: 'skipped', reason: 'fresh_touched' }, { kind: 'skipped', reason: 'fresh_touched' }, { kind: 'skipped', reason: 'old_moved' }]);
      expect(await sql`select count(*)::int as n from local_tracks where local_album_id = ${s.freshAlbum}`).toEqual([{ n: 3 }]);
      expect(await sql`select count(*)::int as n from audio_files where id = any(${[s.oldId, p2.oldId]}::uuid[]) and status = 'missing'`).toEqual([{ n: 2 }]);
    });

    it('a track lock on one file of the fresh album makes all its pairs fall back', async () => {
      const s = await setup();
      const p2 = await addPair(s);
      await sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${libraryId}, 'track', ${p2.freshId}, 'title', ${userId})`;
      expect(await mergeFilePairs(ctx(), [req(s), p2.req])).toEqual([{ kind: 'skipped', reason: 'fresh_touched' }, { kind: 'skipped', reason: 'fresh_touched' }]);
      expect(await sql`select 1 from local_albums where id = ${s.freshAlbum}`).toHaveLength(1);
    });

    it('falls back when the old rows sit on two albums', async () => {
      const s = await setup();
      const other = randomUUID();
      await sql`insert into local_albums (id, library_id, cluster_key) values (${other}, ${libraryId}, ${`o2:${other}`})`;
      const p2 = await addPair(s, { album: other });
      expect(await mergeFilePairs(ctx(), [req(s), p2.req])).toEqual([{ kind: 'skipped', reason: 'fresh_touched' }, { kind: 'skipped', reason: 'fresh_touched' }]);
    });

    it('a fresh track with no twin on its old row moves onto the old file and album, keeping its id and plays', async () => {
      const s = await setup();
      await sql`update local_tracks set cue_start_ms = 0 where id in (${s.oldTrack}, ${s.freshTrack})`;
      const [extra] = await sql`insert into local_tracks (local_album_id, audio_file_id, cue_start_ms, canonical_track_id, state)
                                values (${s.freshAlbum}, ${s.freshId}, 5000, null, 'matched') returning id`;
      await sql`insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, local_album_id, title, started_at, heard, scrobbles)
                values (${userId}, ${libraryId}, ${`nt-${s.freshId}`}, 'web', ${extra.id}, ${s.freshAlbum}, 'T', now(), true, false)`;
      expect(await mergeFilePair(ctx(), req(s))).toMatchObject({ kind: 'absorbed', removedAlbumIds: [s.freshAlbum] });
      expect(await sql`select audio_file_id, local_album_id, state from local_tracks where id = ${extra.id}`)
        .toEqual([{ audio_file_id: s.oldId, local_album_id: s.oldAlbum, state: 'unmatched' }]);
      expect(await sql`select local_track_id, local_album_id from player_plays where dedupe_key = ${`nt-${s.freshId}`}`).toEqual([{ local_track_id: extra.id, local_album_id: s.oldAlbum }]);
      expect(await sql`select count(*)::int as n from local_tracks where audio_file_id = ${s.oldId}`).toEqual([{ n: 2 }]);
    });

    it('same-path move to another root: the copy sits on the old album itself, whose owner data does not block', async () => {
      const s = await setup();
      // cluster.dir put the copy's track onto the old album (same key): no fresh album of its own
      await sql`update local_tracks set local_album_id = ${s.oldAlbum} where id = ${s.freshTrack}`;
      const rg = await releaseGroup();
      const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg}, ${randomUUID()}, 'R') returning id`;
      await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by) values (${libraryId}, ${s.oldAlbum}, ${rel.id}, 0.1, 'confirmed', 'user')`;
      await sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${libraryId}, 'album', ${s.oldAlbum}, 'title', ${userId})`;
      expect(await mergeFilePair(ctx(), req(s))).toMatchObject({ kind: 'absorbed', removedAlbumIds: [] });
      expect(await sql`select id from local_tracks where local_album_id = ${s.oldAlbum}`).toEqual([{ id: s.oldTrack }]);
      expect(await sql`select status from album_matches where local_album_id = ${s.oldAlbum}`).toEqual([{ status: 'confirmed' }]);
    });

    it('two emptied fresh albums with the same listen keep one, on the old album; its plays follow the kept one', async () => {
      const s = await setup();
      const fresh2 = randomUUID();
      await sql`insert into local_albums (id, library_id, cluster_key) values (${fresh2}, ${libraryId}, ${`f2:${fresh2}`})`;
      const p2 = await addPair(s);
      await sql`update local_tracks set local_album_id = ${fresh2} where audio_file_id = ${p2.freshId}`;
      const at = new Date(Date.now() - 7_200_000).toISOString();
      const listens: string[] = [];
      for (const [album, heard] of [[s.freshAlbum, 1], [fresh2, 2]] as const) {
        const [l] = await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                              values (${userId}, ${libraryId}, ${album}, ${at}::timestamptz, now(), ${heard}, 2) returning id`;
        listens.push(l.id);
      }
      const [play] = await sql`insert into player_plays (user_id, library_id, dedupe_key, source, local_album_id, title, started_at, heard, scrobbles, player_listen_id)
                               values (${userId}, ${libraryId}, ${`dl-${s.freshId}`}, 'web', ${s.freshAlbum}, 'T', now(), true, false, ${listens[0]}) returning id`;
      const outs = await mergeFilePairs(ctx(), [req(s), p2.req]);
      expect(outs.map((o) => o.kind)).toEqual(['absorbed', 'absorbed']);
      expect((outs[0] as any).removedAlbumIds.sort()).toEqual([s.freshAlbum, fresh2].sort());
      expect(await sql`select id, tracks_heard from player_listens where local_album_id = ${s.oldAlbum} and started_at = ${at}::timestamptz`)
        .toEqual([{ id: listens[1], tracks_heard: 2 }]);
      expect(await sql`select player_listen_id, local_album_id from player_plays where id = ${play.id}`).toEqual([{ player_listen_id: listens[1], local_album_id: s.oldAlbum }]);
    });

    it('falls back when the old row has no album: the fresh album and its listens would go (F6)', async () => {
      const s = await setup();
      await sql`delete from local_tracks where id = ${s.oldTrack}`;
      await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                values (${userId}, ${libraryId}, ${s.freshAlbum}, now() - interval '1 hour', now(), 1, 1)`;
      expect(await mergeFilePair(ctx(), req(s))).toEqual({ kind: 'skipped', reason: 'fresh_touched' });
      expect(await sql`select count(*)::int as n from player_listens where local_album_id = ${s.freshAlbum}`).toEqual([{ n: 1 }]);
      expect((await sql`select status from audio_files where id = ${s.oldId}`)[0].status).toBe('missing');
    });

    it('a fresh listen that the old album already has is dropped as a duplicate, not a reason to fall back', async () => {
      const s = await setup();
      const at = new Date(Date.now() - 3_600_000).toISOString();
      const ids: string[] = [];
      for (const album of [s.oldAlbum, s.freshAlbum]) {
        const [l] = await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                              values (${userId}, ${libraryId}, ${album}, ${at}::timestamptz, now(), 1, 1) returning id`;
        ids.push(l.id);
      }
      expect(await mergeFilePair(ctx(), req(s))).toMatchObject({ kind: 'absorbed', removedAlbumIds: [s.freshAlbum] });
      expect(await sql`select id from player_listens where id = any(${ids}::uuid[])`).toEqual([{ id: ids[0] }]);
    });

    it('the kept listen\'s tracks heard and end are counted again from the plays it took over', async () => {
      const s = await setup();
      const extraId = randomUUID();
      await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, size_bytes, status)
                values (${extraId}, ${libraryId}, ${rootA}, ${`X/${extraId}.flac`}, 11, 'present')`;
      const [extra] = await sql`insert into local_tracks (local_album_id, audio_file_id) values (${s.oldAlbum}, ${extraId}) returning id`;
      const at = Date.now() - 3_600_000;
      const iso = (offsetS: number) => new Date(at + offsetS * 1000).toISOString();
      const ids: string[] = [];
      for (const album of [s.oldAlbum, s.freshAlbum]) {
        const [l] = await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                              values (${userId}, ${libraryId}, ${album}, ${iso(0)}::timestamptz, ${iso(60)}::timestamptz, 1, 2) returning id`;
        ids.push(l.id);
      }
      const play = (key: string, track: string, album: string, listen: string, offsetS: number) => sql`
        insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, local_album_id, title, started_at, heard, scrobbles, player_listen_id)
        values (${userId}, ${libraryId}, ${`${key}-${s.freshId}`}, 'web', ${track}, ${album}, 'T', ${iso(offsetS)}::timestamptz, true, false, ${listen})`;
      await play('rk', s.oldTrack, s.oldAlbum, ids[0]!, 10);
      await play('rf', s.freshTrack, s.freshAlbum, ids[1]!, 120);   // its twin is the old track
      await play('rx', extra.id, s.freshAlbum, ids[1]!, 300);
      expect(await mergeFilePair(ctx(), req(s))).toMatchObject({ kind: 'absorbed', removedAlbumIds: [s.freshAlbum] });
      expect(await sql`select id, tracks_heard, ended_at = ${iso(300)}::timestamptz as ended_at_last_play
                         from player_listens where id = any(${ids}::uuid[])`)
        .toEqual([{ id: ids[0], tracks_heard: 2, ended_at_last_play: true }]);
    });

    it('a loose fresh track (no album) is absorbed: its plays move to the old track, no album goes', async () => {
      const s = await setup();
      await sql`update local_tracks set local_album_id = null where id = ${s.freshTrack}`;
      await sql`insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, title, started_at, heard, scrobbles)
                values (${userId}, ${libraryId}, ${`pl-${s.freshId}`}, 'web', ${s.freshTrack}, 'T', now(), true, false)`;
      expect(await mergeFilePair(ctx(), req(s))).toMatchObject({ kind: 'absorbed', removedAlbumIds: [] });
      expect(await sql`select local_track_id from player_plays where dedupe_key = ${`pl-${s.freshId}`}`).toEqual([{ local_track_id: s.oldTrack }]);
      expect(await sql`select 1 from local_albums where id = ${s.freshAlbum}`).toHaveLength(1); // it never held this file's track
    });

    it('allowAbsorb false still leaves a clustered fresh row alone', async () => {
      const s = await setup();
      expect(await mergeFilePair(ctx(), { ...req(s), allowAbsorb: false })).toEqual({ kind: 'skipped', reason: 'fresh_has_data' });
    });

    it('waits for the fresh album\'s key lock (a cluster.dir filling it) before absorbing', async () => {
      const s = await setup();
      let locked!: () => void; const didLock = new Promise<void>((r) => { locked = r; });
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      const cluster = sql.begin(async (tx: any) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${albumKeyLock(libraryId, `f:${s.freshAlbum}`)}, 0))`;
        locked();
        await gate;
      });
      await didLock;
      let settled = false;
      const merge = mergeFilePair(ctx(), req(s)).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      release();
      await cluster;
      expect(await merge).toMatchObject({ kind: 'absorbed', removedAlbumIds: [s.freshAlbum] });
    });
  });
});

/**
 * Owner identify requests live in pg-boss's job table. Other suites fake or
 * drop pgboss.job in the shared test database, so this runs in a scratch
 * database with a stand-in table holding the columns the check reads.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('ownerIdentifyRequested on the shared test database (db)', () => {
  it('sees an owner-requested identify job this test queued, and nothing once it is gone', async (t) => {
    const sql = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    const created = await ensureFakeBossJob(sql);
    const jobId = randomUUID();
    const albumId = randomUUID();
    try {
      try {
        await sql`insert into pgboss.job (id, name, state, data)
                  values (${jobId}, 'identify.album', 'created', ${JSON.stringify({ localAlbumId: albumId, requestedBy: 'owner' })}::text::jsonb)`;
      } catch (err) {
        // a real pg-boss table needs its queue first; the scratch test below covers the check then
        t.skip(`pgboss.job takes no plain insert here: ${(err as Error).message}`);
      }
      const check = () => sql.begin((tx: any) => ownerIdentifyRequested(tx, [albumId]));
      expect(await check()).toBe(true);
      await sql`delete from pgboss.job where id = ${jobId}`;
      expect(await check()).toBe(false);
    } finally {
      await releaseFakeBossJob(sql, created, [jobId]);
      await sql.end({ timeout: 5 });
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('ownerIdentifyRequested (db)', () => {
  it('sees owner-requested or pinned identify jobs still waiting or running, nothing else; no pg-boss table means none', async () => {
    const admin = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    const name = `tagave_oir_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.unsafe(`create database ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    const sql = (await makeDb(u.toString())).client;
    try {
      const a = randomUUID();
      const check = (ids: string[]) => sql.begin((tx: any) => ownerIdentifyRequested(tx, ids));
      expect(await check([a])).toBe(false);                                   // no pgboss schema at all
      await sql`create schema pgboss`;
      expect(await check([a])).toBe(false);                                   // schema, no table
      await sql`create table pgboss.job (id uuid default gen_random_uuid(), name text, state text, data jsonb)`;
      const job = (n: string, state: string, data: object) => sql`insert into pgboss.job (name, state, data) values (${n}, ${state}, ${JSON.stringify(data)}::text::jsonb)`;
      await job('identify.album', 'created', { localAlbumId: a });                          // automatic
      await job('identify.album', 'completed', { localAlbumId: a, requestedBy: 'owner' }); // done
      await job('scan.parse', 'created', { localAlbumId: a, requestedBy: 'owner' });       // other queue
      expect(await check([a])).toBe(false);
      await job('identify.album', 'active', { localAlbumId: a, pinnedMbid: randomUUID() });
      expect(await check([a])).toBe(true);
      const b = randomUUID();
      await job('identify.acoustid', 'retry', { localAlbumId: b, requestedBy: 'owner' });
      expect(await check([b])).toBe(true);
      expect(await check([randomUUID()])).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);
});
