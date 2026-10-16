/**
 * The Music Connections feeds against the real server (registerApiRoutes and
 * its hooks) on a scratch database: the change log the triggers write
 * (0048), each capability's payloads, the bearer gate, the rate limit, the
 * cursor rules, and the package's conformance suite run against tagave
 * itself (spec §3, §5 Security, §6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { CAPABILITY_DATA, FeedPageSchema, encodeCursor, runConformance, type Capability } from 'music-connections';
import type { AuthHandle } from '@tagave/auth';
import { registerApiRoutes } from '../app.js';
import { initAuth } from '../middleware/auth.js';
import { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { createTestUser, type TestUser } from '../testkit/users.js';
import { hashToken } from '../lib/mcOAuth.js';
import { createMcFeedRoutes, resetMcFeedLimits } from './mcFeeds.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { feedTuning, readFeed } from '../lib/mcFeeds.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const ALL = ['ratings:read', 'collection:read', 'listens:read', 'identity:read', 'offline_access'];

type Item = { key: string; op: 'upsert' | 'delete'; updated_at: string; data: any };
type Page = { items: Item[]; next: string; more: boolean };

describe.skipIf(!adminUrl)('music connections feeds (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let person: TestUser;
  let other: TestUser;
  let token: string;
  let clientId: string;

  const libraryId = randomUUID();
  const rgA = randomUUID();
  const rgB = randomUUID();
  const rgAMbid = randomUUID();
  const releaseA = randomUUID();
  const releaseAMbid = randomUUID();
  const sourceId = randomUUID();
  const itemA = randomUUID();
  const itemB = randomUUID();
  const itemC = randomUUID();
  const albumA = randomUUID();
  const rootId = randomUUID();
  const fileIds = [randomUUID(), randomUUID()];

  async function newToken(userId: string, scopes: string[], opts: { expired?: boolean; revoked?: boolean } = {}): Promise<string> {
    const t = `mca_${randomUUID()}`;
    await sql`insert into mc_oauth_tokens (family_id, client_id, user_id, scopes, access_token_hash, access_expires_at, revoked_at)
              values (${randomUUID()}, ${clientId}, ${userId}, ${scopes}, ${hashToken(t)},
                      ${opts.expired ? sql`now() - interval '1 minute'` : sql`now() + interval '1 hour'`},
                      ${opts.revoked ? sql`now()` : null})`;
    return t;
  }

  const get = (url: string, t: string | null = token) =>
    app.inject({ method: 'GET', url, headers: t ? { authorization: `Bearer ${t}` } : {} });

  async function page(cap: Capability, query = '', t = token): Promise<Page> {
    const res = await get(`/mc/v1/${cap}${query ? `?${query}` : ''}`, t);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as Page;
    expect(FeedPageSchema(CAPABILITY_DATA[cap]).safeParse(body).success).toBe(true);
    return body;
  }

  /** Every item of a feed, walked with `limit` per page. */
  async function all(cap: Capability, since = '', limit = 500): Promise<Page & { pages: number }> {
    const items: Item[] = [];
    let next = since;
    let pages = 0;
    for (;;) {
      const p = await page(cap, `limit=${limit}${next ? `&since=${encodeURIComponent(next)}` : ''}`);
      pages++;
      items.push(...p.items);
      if (!p.more) return { items, next: p.next || next, more: false, pages };
      next = p.next;
    }
  }

  /** The current cursor at the end of a feed (to read only what changes after). */
  const tail = async (cap: Capability) => (await all(cap)).next;
  const latest = (items: Item[], key: string) => items.filter((i) => i.key === key).at(-1);
  const logRows = async (cap: string, key: string) =>
    (await sql<Array<{ n: number }>>`select count(*)::int as n from mc_changes where capability = ${cap} and key = ${key}`)[0]!.n;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 3, onnotice: () => undefined });
    person = await createTestUser(handle, { role: 'listener' });
    other = await createTestUser(handle, { role: 'listener' });

    clientId = `mcc_${randomUUID()}`;
    await sql`insert into mc_oauth_clients (client_id, client_secret_hash, name, redirect_uri)
              values (${clientId}, ${hashToken('secret')}, 'review-gatherer', 'http://192.168.2.50/cb')`;
    token = await newToken(person.userId, ALL);

    await sql`insert into libraries (id, owner_user_id, name, created_at) values (${libraryId}, ${person.userId}, 'Home', now() - interval '1 day')`;
    // a second library, made later: not the one a link reads
    await sql`insert into libraries (owner_user_id, name) values (${person.userId}, 'Later')`;
    await sql`insert into release_groups (id, mbid, title, artist_credit, discogs_master_id)
              values (${rgA}, ${rgAMbid}, 'Kind of Blue', ${sql.json(['Miles Davis'])}, 5460)`;
    // Discogs-only (no MusicBrainz group): a synthetic group from the master
    await sql`insert into release_groups (id, mbid, title, artist_credit, discogs_master_id)
              values (${rgB}, null, 'Obscure LP', ${sql.json(['Nobody'])}, 999001)`;
    await sql`insert into releases (id, release_group_id, mbid, title) values (${releaseA}, ${rgA}, ${releaseAMbid}, 'Kind of Blue')`;

    await sql`insert into user_reviews (library_id, user_id, release_group_id, rating, body_md)
              values (${libraryId}, ${person.userId}, ${rgA}, 3.5, 'secret prose that never leaves'),
                     (${libraryId}, ${other.userId}, ${rgA}, 1.0, 'someone else')`;
    await sql`insert into listens (library_id, user_id, release_group_id, listened_at, format)
              values (${libraryId}, ${person.userId}, ${rgA}, '2026-10-01T08:00:00Z', 'vinyl'),
                     (${libraryId}, ${person.userId}, ${rgA}, '2026-10-01T21:00:00Z', 'digital'),
                     (${libraryId}, ${person.userId}, ${rgA}, '2026-10-01T23:59:00Z', null),
                     (${libraryId}, ${person.userId}, ${rgA}, '2026-10-02T00:01:00Z', 'vinyl'),
                     (${libraryId}, ${other.userId}, ${rgA}, '2026-10-01T09:00:00Z', 'cd')`;

    await sql`insert into collection_sources (id, library_id, provider, username) values (${sourceId}, ${libraryId}, 'discogs', 'me')`;
    await sql`insert into collection_items (id, library_id, collection_source_id, provider_item_id, discogs_release_id, discogs_master_id, release_group_id, release_id, formats, basic_info, date_added)
              values (${itemA}, ${libraryId}, ${sourceId}, '1', 111, 5460, ${rgA}, ${releaseA},
                      ${sql.json([{ name: 'Vinyl', qty: 1, descriptions: ['LP', 'Album', 'Reissue'] }])},
                      ${sql.json({ title: 'Kind of Blue', artists: ['Miles Davis'] })}, '2020-05-01T00:00:00Z'),
                     (${itemB}, ${libraryId}, ${sourceId}, '2', 222, 999001, ${rgB}, null,
                      ${sql.json([{ name: 'CD', descriptions: ['Album'] }])},
                      ${sql.json({ title: 'Obscure LP', artists: ['Nobody'] })}, '2021-01-01T00:00:00Z'),
                     (${itemC}, ${libraryId}, ${sourceId}, '3', 777, 888, null, null,
                      ${sql.json([{ name: 'Cassette', descriptions: [] }])},
                      ${sql.json({ title: 'Tape Only', artists: ['Basement Band', 'Guest'] })}, '2019-03-03T00:00:00Z')`;

    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/music', 'Music')`;
    await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, codec)
              values (${fileIds[0]!}, ${libraryId}, ${rootId}, 'Miles/01.flac', 'FLAC'),
                     (${fileIds[1]!}, ${libraryId}, ${rootId}, 'Miles/02.flac', 'FLAC')`;
    await sql`insert into local_albums (id, library_id, cluster_key, state, release_id, release_group_id, title_guess, artist_guess, embedded_mbid)
              values (${albumA}, ${libraryId}, 'miles', 'matched', ${releaseA}, ${rgA}, 'Kind of Blue', 'Miles Davis', null)`;
    await sql`insert into local_tracks (local_album_id, audio_file_id) values (${albumA}, ${fileIds[0]!}), (${albumA}, ${fileIds[1]!})`;
    await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, source)
              values (${libraryId}, ${albumA}, ${releaseA}, 0.08, 'confirmed', 'user', 'mb_search')`;

    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  beforeEach(() => resetMcFeedLimits());

  // ── payloads ─────────────────────────────────────────────────────────────

  it('ratings: 3.5 arrives as 7 with raw "3.5", the person’s own only, no prose', async () => {
    const p = await page('ratings');
    expect(p.items).toHaveLength(1);
    const [item] = p.items;
    expect(item).toMatchObject({ key: rgA, op: 'upsert' });
    expect(item!.data).toEqual({
      album: { rg_mbid: rgAMbid, release_mbid: releaseAMbid, discogs_master_id: 5460, discogs_release_id: 111, artist: 'Miles Davis', title: 'Kind of Blue' },
      rating: 7, rating_raw: '3.5', scale: '0-5', favorite: false, rated_at: expect.any(String),
    });
    const raw = JSON.stringify(p);
    expect(raw).not.toContain('secret prose');
    expect(raw).not.toContain('someone else');
    expect(raw).not.toContain('"rating":2'); // the other person's 1.0
  });

  it('ratings: a cleared rating is a tombstone, never a 0; rating again brings it back', async () => {
    const since = await tail('ratings');
    await sql`update user_reviews set rating = null where user_id = ${person.userId} and release_group_id = ${rgA}`;
    let after = await all('ratings', since);
    expect(after.items).toEqual([{ key: rgA, op: 'delete', updated_at: expect.any(String), data: null }]);
    // editing only the text is no change to the feed
    await sql`update user_reviews set body_md = 'edited' where user_id = ${person.userId}`;
    expect((await all('ratings', after.next)).items).toEqual([]);
    await sql`update user_reviews set rating = 4.5 where user_id = ${person.userId} and release_group_id = ${rgA}`;
    after = await all('ratings', after.next);
    expect(after.items.map((i) => [i.op, i.data?.rating, i.data?.rating_raw])).toEqual([['upsert', 9, '4.5']]);
    await sql`update user_reviews set rating = 3.5 where user_id = ${person.userId} and release_group_id = ${rgA}`;
  });

  it('ratings: a deleted review is a tombstone', async () => {
    const rg = randomUUID();
    await sql`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'Short-lived')`;
    await sql`insert into user_reviews (library_id, user_id, release_group_id, rating) values (${libraryId}, ${person.userId}, ${rg}, 2.0)`;
    const since = await tail('ratings');
    await sql`delete from user_reviews where release_group_id = ${rg}`;
    expect((await all('ratings', since)).items).toEqual([{ key: rg, op: 'delete', updated_at: expect.any(String), data: null }]);
    // the log only appends (both rows stay until mc.purge), and a snapshot serves the key once
    expect(await logRows('ratings', rg)).toBe(2);
    expect((await all('ratings')).items.filter((i) => i.key === rg)).toEqual([{ key: rg, op: 'delete', updated_at: expect.any(String), data: null }]);
  });

  it('collection: Discogs copies and local files, aggregated per album', async () => {
    const { items } = await all('collection');
    const a = latest(items, rgA);
    expect(a?.data).toEqual({
      album: { rg_mbid: rgAMbid, release_mbid: releaseAMbid, discogs_master_id: 5460, discogs_release_id: 111, artist: 'Miles Davis', title: 'Kind of Blue' },
      formats: [{ kind: 'vinyl', detail: 'LP, Album, Reissue' }, { kind: 'digital', detail: 'FLAC' }],
      acquired_at: '2020-05-01T00:00:00.000Z',
    });
  });

  it('collection: a Discogs copy with no MBID is emitted, never dropped', async () => {
    const { items } = await all('collection');
    // mapped to a Discogs-only release group
    expect(latest(items, rgB)?.data).toEqual({
      album: { rg_mbid: null, discogs_master_id: 999001, discogs_release_id: 222, artist: 'Nobody', title: 'Obscure LP' },
      formats: [{ kind: 'cd', detail: 'Album' }],
      acquired_at: '2021-01-01T00:00:00.000Z',
    });
    // mapped to nothing at all: keyed by its Discogs release
    expect(latest(items, 'discogs-release:777')?.data).toEqual({
      album: { rg_mbid: null, discogs_master_id: 888, discogs_release_id: 777, artist: 'Basement Band, Guest', title: 'Tape Only' },
      formats: [{ kind: 'cassette' }],
      acquired_at: '2019-03-03T00:00:00.000Z',
    });
  });

  it('collection: removed from Discogs is a delete; mapping later moves the key', async () => {
    const since = await tail('collection');
    await sql`update collection_items set removed_at = now() where id = ${itemB}`;
    let p = await all('collection', since);
    expect(p.items.map((i) => [i.key, i.op])).toEqual([[rgB, 'delete']]);
    await sql`update collection_items set removed_at = null where id = ${itemB}`;

    // the unmapped copy gets mapped: its old key goes, the group's key comes
    const rgC = randomUUID();
    await sql`insert into release_groups (id, mbid, title, discogs_master_id) values (${rgC}, ${randomUUID()}, 'Tape Only', 888)`;
    p = await all('collection', p.next);
    await sql`update collection_items set release_group_id = ${rgC} where id = ${itemC}`;
    p = await all('collection', p.next);
    expect(p.items).toHaveLength(2);
    expect(p.items.map((i) => [i.key, i.op])).toEqual(expect.arrayContaining([['discogs-release:777', 'delete'], [rgC, 'upsert']]));
    await sql`update collection_items set release_group_id = null where id = ${itemC}`;
  });

  it('listens: a daily aggregate per album, the person’s own', async () => {
    const { items } = await all('listens');
    const byKey = Object.fromEntries(items.filter((i) => i.op === 'upsert').map((i) => [i.key, i.data]));
    expect(byKey[`${rgA}:2026-10-01`]).toMatchObject({ date: '2026-10-01', count: 3, formats: ['digital', 'vinyl'] });
    expect(byKey[`${rgA}:2026-10-02`]).toMatchObject({ date: '2026-10-02', count: 1, formats: ['vinyl'] });
    expect(byKey[`${rgA}:2026-10-01`].album).toMatchObject({ rg_mbid: rgAMbid, artist: 'Miles Davis', title: 'Kind of Blue' });
    expect(JSON.stringify(items)).not.toContain('"cd"'); // the other person's listen
  });

  it('identity: the matched release, with how sure tagave is', async () => {
    const { items } = await all('identity');
    expect(latest(items, rgA)?.data).toEqual({
      album: { rg_mbid: rgAMbid, release_mbid: releaseAMbid, discogs_master_id: 5460, discogs_release_id: 111, artist: 'Miles Davis', title: 'Kind of Blue' },
      local_key: rgA, provenance: 'manual', confidence: 1,
    });
    const since = (await all('identity')).next;
    await sql`update album_matches set status = 'auto', decided_by = 'system' where local_album_id = ${albumA}`;
    const p = await all('identity', since);
    expect(p.items.map((i) => [i.key, i.data?.provenance, i.data?.confidence])).toEqual([[rgA, 'auto', 0.92]]);
    await sql`update album_matches set status = 'confirmed', decided_by = 'user' where local_album_id = ${albumA}`;
  });

  it('a release group’s MBID change reaches every feed that names it', async () => {
    const cursors = Object.fromEntries(await Promise.all((['ratings', 'collection', 'listens', 'identity'] as const).map(async (c) => [c, await tail(c)])));
    const newMbid = randomUUID();
    await sql`update release_groups set mbid = ${newMbid} where id = ${rgA}`;
    for (const cap of ['ratings', 'collection', 'listens', 'identity'] as const) {
      const p = await all(cap, cursors[cap]);
      expect(p.items.length).toBeGreaterThan(0);
      for (const i of p.items) expect(i.data.album.rg_mbid).toBe(newMbid);
    }
    await sql`update release_groups set mbid = ${rgAMbid} where id = ${rgA}`;
  });

  // ── the change log ───────────────────────────────────────────────────────

  it('one row per key per statement, and nothing for a rewrite that changes nothing', async () => {
    const before = await logRows('listens', `${rgA}:2026-09-30`);
    expect(before).toBe(0);
    await sql`insert into listens (library_id, user_id, release_group_id, listened_at)
              select ${libraryId}, ${person.userId}, ${rgA}, '2026-09-30T10:00:00Z'::timestamptz + make_interval(mins => g)
                from generate_series(1, 25) g`;
    expect(await logRows('listens', `${rgA}:2026-09-30`)).toBe(1);

    // collection.sync rewrites every copy with the values it already has
    const n = (await sql<Array<{ n: number }>>`select count(*)::int as n from mc_changes`)[0]!.n;
    const maxId = (await sql<Array<{ m: string }>>`select max(id)::text as m from mc_changes`)[0]!.m;
    await sql`update collection_items set formats = formats, basic_info = basic_info, last_seen_at = now() where library_id = ${libraryId}`;
    await sql`update local_albums set identify_attempts = identify_attempts + 1, updated_at = now() where library_id = ${libraryId}`;
    await sql`update audio_files set last_seen_at = now(), status = status where library_id = ${libraryId}`;
    expect((await sql<Array<{ n: number }>>`select count(*)::int as n from mc_changes where id > ${maxId}::bigint`)[0]!.n).toBe(0);
    expect((await sql<Array<{ n: number }>>`select count(*)::int as n from mc_changes`)[0]!.n).toBe(n);
  });

  it('files going missing change the album’s formats, logged once for the album', async () => {
    const since = await tail('collection');
    await sql`update audio_files set status = 'missing' where id = any(${fileIds}::uuid[])`;
    const p = await all('collection', since);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ key: rgA, op: 'upsert' });
    expect(p.items[0]!.data.formats).toEqual([{ kind: 'vinyl', detail: 'LP, Album, Reissue' }]);
    await sql`update audio_files set status = 'present' where id = any(${fileIds}::uuid[])`;
  });

  it('deleting a person takes their rows with them (no tombstone, no error)', async () => {
    const gone = await createTestUser(handle, { role: 'listener' });
    await sql`insert into user_reviews (library_id, user_id, release_group_id, rating) values (${libraryId}, ${gone.userId}, ${rgA}, 5)`;
    await sql`insert into listens (library_id, user_id, release_group_id, listened_at) values (${libraryId}, ${gone.userId}, ${rgA}, now())`;
    expect((await sql`select 1 from mc_changes where user_id = ${gone.userId}`).length).toBe(2);
    await sql`delete from users where id = ${gone.userId}`;
    expect((await sql`select 1 from mc_changes where user_id = ${gone.userId}`).length).toBe(0);
  });

  it('a change is served only once every transaction that started before it has ended', async () => {
    const since = await tail('ratings');
    const open = await sql.reserve();
    try {
      await open`begin`;
      await open`select pg_current_xact_id()`; // a writer, still open
      await sql`update user_reviews set rating = 2.5 where user_id = ${person.userId} and release_group_id = ${rgA}`;
      // committed, but a transaction older than it could still add an earlier row
      expect((await all('ratings', since)).items).toEqual([]);
      await open`commit`;
      expect((await all('ratings', since)).items.map((i) => i.data?.rating)).toEqual([5]);
    } finally {
      await open`rollback`.catch(() => undefined); // never hand back a connection mid-transaction
      open.release();
    }
    await sql`update user_reviews set rating = 3.5 where user_id = ${person.userId} and release_group_id = ${rgA}`;
  });

  // ── the op is the reader's, not the writer's ─────────────────────────────

  it('a delete row whose key has data when read is served as an upsert', async () => {
    const since = await tail('collection');
    await sql`insert into mc_changes (capability, key, op, user_id, library_id) values ('collection', ${rgA}, 'delete', null, ${libraryId})`;
    const p = await all('collection', since);
    expect(p.items.map((i) => [i.key, i.op])).toEqual([[rgA, 'upsert']]);
    expect(p.items[0]!.data.formats.length).toBeGreaterThan(0);
  });

  it('two writers racing on one album: the live album is served, not the stale delete', async () => {
    // K has one Discogs copy and no files. A removes the copy while B adds a
    // matched album with a file; each logs K in its own snapshot: B (upsert,
    // it still sees the copy) first, then A (delete, it cannot see B's album).
    const k = randomUUID();
    const copy = randomUUID();
    const album = randomUUID();
    const file = randomUUID();
    await sql`insert into release_groups (id, mbid, title) values (${k}, ${randomUUID()}, 'Raced')`;
    await sql`insert into collection_items (id, library_id, collection_source_id, provider_item_id, release_group_id, formats)
              values (${copy}, ${libraryId}, ${sourceId}, ${`race-${copy}`}, ${k}, ${sql.json([{ name: 'Vinyl', descriptions: [] }])})`;
    const since = await tail('collection');
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await b`begin`;
      await b`insert into audio_files (id, library_id, scan_root_id, rel_path, codec) values (${file}, ${libraryId}, ${rootId}, ${`race/${file}.flac`}, 'FLAC')`;
      await b`insert into local_albums (id, library_id, cluster_key, state, release_group_id) values (${album}, ${libraryId}, ${`race-${album}`}, 'matched', ${k})`;
      await b`insert into local_tracks (local_album_id, audio_file_id) values (${album}, ${file})`;
      await a`begin`;
      await a`update collection_items set removed_at = now() where id = ${copy}`;
      await b`commit`;
      await a`commit`;
    } finally {
      await a`rollback`.catch(() => undefined);
      await b`rollback`.catch(() => undefined);
      a.release();
      b.release();
    }
    const ops = (await sql<Array<{ op: string }>>`select op from mc_changes where capability = 'collection' and key = ${k} order by changed_at, id`).map((r) => r.op);
    expect(ops.at(-1)).toBe('delete'); // the race left a stale delete as the newest row
    const p = await all('collection', since);
    expect(p.items.filter((i) => i.key === k).map((i) => [i.op, i.data?.formats])).toEqual([['upsert', [{ kind: 'digital', detail: 'FLAC' }]]]);
  });

  it('two writers logging one key never wait on each other', async () => {
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a`begin`;
      await a`insert into collection_items (library_id, collection_source_id, provider_item_id, release_group_id) values (${libraryId}, ${sourceId}, ${`w1-${randomUUID()}`}, ${rgA})`;
      await b`begin`;
      await b`set local lock_timeout = '100ms'`;
      await b`insert into collection_items (library_id, collection_source_id, provider_item_id, release_group_id) values (${libraryId}, ${sourceId}, ${`w2-${randomUUID()}`}, ${rgA})`;
      await b`update user_reviews set rating = 3.0 where user_id = ${other.userId} and release_group_id = ${rgA}`;
      await b`commit`;
      await a`commit`;
    } finally {
      await a`rollback`.catch(() => undefined);
      await b`rollback`.catch(() => undefined);
      a.release();
      b.release();
    }
    await sql`delete from collection_items where provider_item_id like 'w_-%'`;
    await sql`update user_reviews set rating = 1.0 where user_id = ${other.userId}`;
  });

  it('a key logged many times appears once per page, and the cursor is the last row served', async () => {
    const since = await tail('ratings');
    for (const r of [2, 2.5, 3, 4]) await sql`update user_reviews set rating = ${r} where user_id = ${person.userId} and release_group_id = ${rgA}`;
    const res = await get(`/mc/v1/ratings?since=${since}`);
    const p = res.json() as Page;
    expect(p.items.map((i) => [i.key, i.data?.rating])).toEqual([[rgA, 8]]);
    // nothing after that cursor: it is the last row, not an earlier duplicate
    expect((await all('ratings', p.next)).items).toEqual([]);
    // paged one row at a time, every row is its own page and the newest value comes last
    const one = await all('ratings', since, 1);
    expect(one.items.at(-1)?.data?.rating).toBe(8);
    await sql`update user_reviews set rating = 3.5 where user_id = ${person.userId} and release_group_id = ${rgA}`;
  });

  it('warns once while a long transaction holds the feeds back', async () => {
    const warnings: string[] = [];
    const scope = { userId: person.userId, libraryId };
    const saved = feedTuning.horizonLagWarnMs;
    try {
      feedTuning.horizonLagWarnMs = -1; // any lag counts
      await readFeed(sql, 'ratings', scope, null, 10, (m) => warnings.push(m));
      await readFeed(sql, 'ratings', scope, null, 10, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/holds the feeds back/);
      feedTuning.horizonLagWarnMs = 60 * 60_000; // caught up: the episode ends
      await readFeed(sql, 'ratings', scope, null, 10, (m) => warnings.push(m));
      feedTuning.horizonLagWarnMs = -1;
      await readFeed(sql, 'ratings', scope, null, 10, (m) => warnings.push(m));
      expect(warnings).toHaveLength(2);
    } finally {
      feedTuning.horizonLagWarnMs = saved;
    }
  });

  // ── paging and cursors ───────────────────────────────────────────────────

  it('pages with an advancing cursor and ends with more: false', async () => {
    const one = await all('listens', '', 1);
    const whole = await all('listens');
    expect(one.pages).toBeGreaterThan(2);
    // a key logged again shows once per page, so paging smaller may serve it
    // more often, but the newest item of every key is the same either way
    const newest = (items: Item[]) => Object.fromEntries(items.map((i) => [i.key, i]));
    expect(newest(one.items)).toEqual(newest(whole.items));
    expect(new Set(whole.items.map((i) => i.key)).size).toBe(whole.items.length);
    // the end cursor is stable: nothing new, nothing served
    expect((await all('listens', whole.next)).items).toEqual([]);
  });

  it('an invalid cursor is 400; one older than the tombstones is 410', async () => {
    expect((await get('/mc/v1/ratings?since=%%%garbage')).statusCode).toBe(400);
    expect((await get(`/mc/v1/ratings?since=${encodeCursor({ t: '2026-02-31T00:00:00Z', id: '1' })}`)).statusCode).toBe(400);
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    const res = await get(`/mc/v1/ratings?since=${encodeCursor({ t: old, id: '1' })}`);
    expect(res.statusCode).toBe(410);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // ── the bearer gate ──────────────────────────────────────────────────────

  it('refuses by default: no, unknown, expired or revoked token, or a disabled client, is 401', async () => {
    const expired = await newToken(person.userId, ALL, { expired: true });
    const revoked = await newToken(person.userId, ALL, { revoked: true });
    for (const t of [null, 'mca_nope', expired, revoked]) {
      const res = await get('/mc/v1/ratings', t);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain('Kind of Blue');
    }
    expect((await app.inject({ method: 'GET', url: '/mc/v1/ratings', headers: { authorization: `Basic ${token}` } })).statusCode).toBe(401);

    const otherClient = `mcc_${randomUUID()}`;
    await sql`insert into mc_oauth_clients (client_id, client_secret_hash, name, redirect_uri, disabled_at)
              values (${otherClient}, ${hashToken('s')}, 'off', 'http://10.0.0.2/cb', now())`;
    const t = `mca_${randomUUID()}`;
    await sql`insert into mc_oauth_tokens (family_id, client_id, user_id, scopes, access_token_hash, access_expires_at)
              values (${randomUUID()}, ${otherClient}, ${person.userId}, ${ALL}, ${hashToken(t)}, now() + interval '1 hour')`;
    expect((await get('/mc/v1/ratings', t)).statusCode).toBe(401);
  });

  it('a token without the capability’s scope is 403 there and 200 where it was granted', async () => {
    const t = await newToken(person.userId, ['collection:read']);
    const res = await get('/mc/v1/ratings', t);
    expect(res.statusCode).toBe(403);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    expect((await get('/mc/v1/collection', t)).statusCode).toBe(200);
    // offline_access alone grants no data
    expect((await get('/mc/v1/listens', await newToken(person.userId, ['offline_access']))).statusCode).toBe(403);
  });

  it('a token of another person reads that person’s ratings, not this one’s', async () => {
    const t = await newToken(other.userId, ALL);
    const p = await page('ratings', '', t);
    expect(p.items.map((i) => [i.key, i.data?.rating])).toEqual([[rgA, 2]]);
  });

  it('more than 60 calls a minute on one token is 429 with Retry-After', async () => {
    const t = await newToken(person.userId, ALL);
    for (let i = 0; i < 60; i++) expect((await get('/mc/v1/identity?limit=1', t)).statusCode).toBe(200);
    const res = await get('/mc/v1/identity?limit=1', t);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(res.headers['cache-control']).toBe('no-store');
    // another token is counted on its own
    expect((await get('/mc/v1/identity?limit=1')).statusCode).toBe(200);
  });

  it('the gate is the plugin’s: a route there that declares nothing is refused', async () => {
    const gated = Fastify({ logger: false });
    await errorHandler(gated);
    await gated.register(createMcFeedRoutes, {
      extraRoutes: (f: FastifyInstance) => {
        f.get('/mc/v1/dummy', async () => ({ leaked: true }));
        f.get('/mc/v1/dummy-public', { config: { mcPublic: true } }, async () => ({ ok: true }));
        f.get('/mc/v1/dummy-scoped', { config: { mcScope: 'listens:read' } }, async () => ({ ok: true }));
      },
    });
    await gated.ready();
    try {
      const anon = await gated.inject({ method: 'GET', url: '/mc/v1/dummy' });
      expect(anon.statusCode).toBe(401);
      expect(anon.headers['cache-control']).toBe('no-store');
      const withToken = await gated.inject({ method: 'GET', url: '/mc/v1/dummy', headers: { authorization: `Bearer ${token}` } });
      expect(withToken.statusCode).toBe(403);
      expect(withToken.body).not.toContain('leaked');
      expect((await gated.inject({ method: 'GET', url: '/mc/v1/dummy-public' })).statusCode).toBe(200);
      expect((await gated.inject({ method: 'GET', url: '/mc/v1/dummy-scoped' })).statusCode).toBe(401);
      expect((await gated.inject({ method: 'GET', url: '/mc/v1/dummy-scoped', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    } finally {
      await gated.close();
    }
  });

  it('serves each provided capability’s JSON Schema, publicly', async () => {
    const res = await get('/mc/v1/schema/ratings.json', null);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ type: 'object' });
    expect((await get('/mc/v1/schema/critic-scores.json', null)).statusCode).toBe(404);
    expect((await get('/mc/v1/schema/nope.json', null)).statusCode).toBe(404);
  });

  // ── the package's conformance suite, against tagave itself ───────────────

  it('passes runConformance', async () => {
    const injectFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const res = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: (init?.headers ?? {}) as Record<string, string> });
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      return new Response(res.body, { status: res.statusCode, headers });
    }) as typeof fetch;
    const result = await runConformance({ baseUrl: TEST_PUBLIC_URL, token, fetch: injectFetch });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
