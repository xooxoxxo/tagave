/**
 * The api side of landing Music Connections data, against the real server on
 * a scratch database, with a fake linked app (no live network: checked
 * requests are carried by a test transport):
 *
 *   - Accept / Dismiss: the decision POSTed to the app first, through the
 *     pinned transport, with the link's token; a 403 or 404 from it said in
 *     the answer, nothing kept; Accept adds a tagave-only wantlist entry the
 *     Discogs side never lists;
 *   - revoking a link deletes exactly its rows;
 *   - the review panel's critic scores: CritiqueBrainz and each linked app's,
 *     labelled "Pitchfork (via review-gatherer)", and the app's gone when the
 *     module is off;
 *   - the echo rule on the identity feed;
 *   - the module switch (Settings › Modules): off hides the feeds and the
 *     manifest and refuses new links; remove data;
 *   - every mc_ and player_ table is listed in its module's manifest.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { sealTokens, setRemoteFetch } from '@tagave/core/mc';
import { MODULES } from '@tagave/core/facets';
import { fillAlbumMbid, identityFills, mcCriticScores, mcIdentity, mcLinks, mcWantlistSuggestions, setMcEnabled, wantlistItems } from '@tagave/db';
import { getTableColumns } from 'drizzle-orm';
import type { AuthHandle } from '@tagave/auth';
import { registerApiRoutes } from '../app.js';
import { initAuth } from '../middleware/auth.js';
import { TEST_APP_SECRET, TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } from '../testkit/authApp.js';
import { createTestUser, type TestUser } from '../testkit/users.js';
import { initDb } from '../db.js';
import { criticScoresFor } from '../lib/facets.js';
import { readFeed } from '../lib/mcFeeds.js';
import { resetConnectionRouteLimits } from './mcConnections.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const RG = 'http://192.168.2.70:8080';

type Seen = { url: string; method: string; auth: string | null; body: string };

describe.skipIf(!adminUrl)('music connections landing: wantlist decisions, revoke, critic scores, the module switch (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let sql: postgres.Sql;
  let app: FastifyInstance;
  let owner: TestUser;
  let person: TestUser;
  let libraryId: string;
  const seen: Seen[] = [];
  let decisionStatus = 200;
  const spent = new Set<string>();
  let familyDead = false;
  let expectAccess: string | null = null;

  const as = (u: TestUser) => ({ cookie: u.cookie, origin: TEST_PUBLIC_URL });
  const manifest = {
    protocol: 'music-connections/1', service: 'review-gatherer', version: '0.4.0',
    auth: { authorize: '/connect/authorize', token: '/connect/token', register: '/connect/register' },
    provides: { 'critic-scores': '/mc/v1/critic-scores', identity: '/mc/v1/identity', 'wantlist-suggestions': '/mc/v1/wantlist-suggestions' },
    consumes: ['ratings'],
  };
  let port = 9000;

  async function link(u: TestUser, scopes = ['critic-scores:read', 'identity:read', 'wantlist-suggestions:read', 'wantlist-suggestions:write'], expired = false) {
    const id = randomUUID();
    const tokens = sealTokens({ access_token: 'acc', refresh_token: 'ref', client_secret: 'sec', access_expires_at: new Date(Date.now() + (expired ? -60_000 : 3600_000)).toISOString() }, TEST_APP_SECRET);
    await sql`insert into mc_links (id, user_id, remote_url, manifest, client_id, sealed_tokens, scopes, requested_scopes, state)
              values (${id}, ${u.userId}, ${`http://192.168.2.70:${port++}`}, ${sql.json(manifest as never)}, 'cid', ${tokens}, ${scopes}, ${scopes}, 'active')`;
    return id;
  }
  async function suggestion(u: TestUser, linkId: string, key: string, over: Record<string, unknown> = {}) {
    const [r] = await sql<Array<{ id: string }>>`
      insert into mc_wantlist_suggestions (link_id, user_id, key, release_group_id, album, data, remote_updated_at)
      values (${linkId}, ${u.userId}, ${key}, ${(over['rg'] as string) ?? null},
              ${sql.json({ rg_mbid: null, artist: 'Neu!', title: 'Neu! 75', discogs_release_id: 12345 } as never)},
              ${sql.json({ reason: '<b>You</b> rate Neu! highly', score: 8.5, suggested_at: '2026-10-01T00:00:00.000Z' } as never)}, now())
      returning id::text as id`;
    return r!.id;
  }
  const decide = (u: TestUser, id: string, decision: string, lib: string = libraryId) =>
    app.inject({ method: 'POST', url: `/api/v1/me/wantlist-suggestions/${id}/decision`, headers: as(u), payload: { decision, libraryId: lib } });
  const wantlistOf = (u: TestUser, lib: string = libraryId) =>
    app.inject({ method: 'GET', url: `/api/v1/me/wantlist?libraryId=${lib}`, headers: { cookie: u.cookie } });

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    owner = await createTestUser(handle, { role: 'owner' });
    person = await createTestUser(handle, { role: 'listener' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}') returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into collection_sources (library_id, provider) values (${libraryId}, 'discogs')`;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    setRemoteFetch(undefined);
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  beforeEach(async () => {
    resetConnectionRouteLimits();
    seen.length = 0;
    decisionStatus = 200;
    spent.clear();
    familyDead = false;
    expectAccess = null;
    await setMcEnabled(sql, true);
    setRemoteFetch(async (url, init = {}) => {
      const u = new URL(url);
      seen.push({ url, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), body: typeof init.body === 'string' ? init.body : '' });
      if (u.pathname.endsWith('/decision')) {
        if (expectAccess && new Headers(init.headers).get('authorization') !== `Bearer ${expectAccess}`) return new Response('', { status: 401 });
        return new Response(decisionStatus < 300 ? '{}' : '', { status: decisionStatus });
      }
      if (u.pathname === '/connect/token') {
        // a rotating issuer: a refresh token spent twice kills the family (reuse detection)
        const presented = new URLSearchParams(typeof init.body === 'string' ? init.body : '').get('refresh_token') ?? '';
        await new Promise((r) => setTimeout(r, 100));
        if (spent.has(presented) || familyDead) { familyDead = true; return Response.json({ error: 'invalid_grant' }, { status: 400 }); }
        spent.add(presented);
        const n = spent.size;
        expectAccess = `acc-${n}`;
        return Response.json({ access_token: expectAccess, refresh_token: `ref-${n}`, expires_in: 3600 });
      }
      if (u.pathname === '/connect/revoke') return Response.json({});
      return new Response('', { status: 404 });
    });
  });

  // ── Accept / Dismiss ─────────────────────────────────────────────────────

  it('Accept tells the app first (its own feed’s decision URL, with the link’s token), then adds a tagave-only wantlist entry', async () => {
    const l = await link(person);
    const id = await suggestion(person, l, 'neu-75');
    const list = (await wantlistOf(person)).json();
    expect(list.available).toBe(true);
    expect(list.suggestions).toMatchObject([{ id, service: 'review-gatherer', artist: 'Neu!', title: 'Neu! 75', reason: '<b>You</b> rate Neu! highly', decision: null }]);

    const res = await decide(person, id, 'accepted');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, decision: 'accepted' });
    const post = seen.find((s) => s.method === 'POST')!;
    const origin = (await sql<Array<{ remote_url: string }>>`select remote_url from mc_links where id = ${l}`)[0]!.remote_url;
    expect(post).toMatchObject({ url: `${origin}/mc/v1/wantlist-suggestions/neu-75/decision`, auth: 'Bearer acc' });
    expect(JSON.parse(post.body)).toEqual({ decision: 'accepted' });

    const [w] = await sql`select w.title, w.artist, w.discogs_release_id, w.origin, cs.provider
                            from wantlist_items w join collection_sources cs on cs.id = w.collection_source_id where w.library_id = ${libraryId}`;
    expect(w).toEqual({ title: 'Neu! 75', artist: 'Neu!', discogs_release_id: 12345, origin: `mc:${l}`, provider: 'tagave' });
    const after = (await wantlistOf(person)).json();
    expect(after.wantlist).toMatchObject([{ title: 'Neu! 75', artist: 'Neu!', discogsReleaseId: 12345 }]);
    // tagave's own source is not a collection the Discogs side lists
    const sources = (await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/collection-sources`, headers: { cookie: owner.cookie } }));
    if (sources.statusCode === 200) expect(JSON.stringify(sources.json())).not.toContain('"tagave"');
    // decided once only
    expect((await decide(person, id, 'dismissed')).statusCode).toBe(409);
  });

  it('an accepted album joins the caller’s library’s wantlist; another library’s list does not show it', async () => {
    const [other] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Second', '{}') returning id::text as id`;
    const l = await link(person);
    const id = await suggestion(person, l, 'second-lib');
    expect((await decide(person, id, 'accepted', other!.id)).statusCode).toBe(200);
    expect((await sql`select library_id::text as lib from wantlist_items where origin = ${`mc:${l}`}`)[0]!['lib']).toBe(other!.id);
    expect(JSON.stringify((await wantlistOf(person, other!.id)).json().wantlist)).toContain('Neu! 75');
    expect((await wantlistOf(person)).json().wantlist.some((e: { id: string }) => e.id === id)).toBe(false);
    expect((await wantlistOf(person, randomUUID())).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/wantlist', headers: { cookie: person.cookie } })).statusCode).toBe(400);
    expect((await decide(person, await suggestion(person, l, 'nolib'), 'accepted', randomUUID())).statusCode).toBe(404);
  });

  it('a 403 or a 404 from the app is said in the answer; nothing is kept', async () => {
    const l = await link(person);
    const id = await suggestion(person, l, 'refused');
    decisionStatus = 403;
    const forbidden = await decide(person, id, 'dismissed');
    expect(forbidden.statusCode).toBe(502);
    expect(forbidden.json().detail).toMatch(/review-gatherer refused the decision \(403\)/);
    decisionStatus = 404;
    const gone = await decide(person, id, 'accepted');
    expect(gone.statusCode).toBe(502);
    expect(gone.json().detail).toMatch(/no longer has this suggestion \(404\)/);
    expect((await sql`select decision from mc_wantlist_suggestions where id = ${id}`)[0]!['decision']).toBeNull();
    expect((await sql`select 1 from wantlist_items where origin = ${`mc:${l}`}`).length).toBe(0);
  });

  it('without the write scope nothing is sent; another person’s suggestion is not found', async () => {
    const l = await link(person, ['wantlist-suggestions:read']);
    const id = await suggestion(person, l, 'noscope');
    const res = await decide(person, id, 'dismissed');
    expect(res.statusCode).toBe(403);
    expect(seen.filter((s) => s.method === 'POST')).toEqual([]);
    expect((await decide(owner, id, 'dismissed')).statusCode).toBe(404);
  });

  it('two decisions at once with a stale token refresh once: the second takes the first one’s new pair', async () => {
    const l = await link(person, undefined, true);
    const a = await suggestion(person, l, 'two-a');
    const b = await suggestion(person, l, 'two-b');
    const [ra, rb] = await Promise.all([decide(person, a, 'dismissed'), decide(person, b, 'dismissed')]);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    expect(seen.filter((s) => s.url.endsWith('/connect/token'))).toHaveLength(1);
    expect(familyDead).toBe(false);
    const decided = seen.filter((s) => s.url.endsWith('/decision'));
    expect(decided.every((s) => s.auth === 'Bearer acc-1')).toBe(true);
  });

  // ── revoke ───────────────────────────────────────────────────────────────

  it('revoking a link deletes exactly its rows; another link’s and accepted wantlist entries stay', async () => {
    const a = await link(person);
    const b = await link(person);
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Tago Mago') returning id::text as id`;
    for (const l of [a, b]) {
      await sql`insert into mc_critic_scores (link_id, user_id, key, release_group_id, album, data, remote_updated_at)
                values (${l}, ${person.userId}, 'k', ${rg!.id}, '{}'::jsonb, '{}'::jsonb, now())`;
    }
    const accepted = await suggestion(person, a, 'acc');
    expect((await decide(person, accepted, 'accepted')).statusCode).toBe(200);
    await suggestion(person, a, 'open');
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/me/connections/${a}`, headers: as(person) });
    expect(res.statusCode).toBe(200);
    expect((await sql`select 1 from mc_critic_scores where link_id = ${a}`).length).toBe(0);
    expect((await sql`select 1 from mc_wantlist_suggestions where link_id = ${a}`).length).toBe(0);
    expect((await sql`select 1 from mc_critic_scores where link_id = ${b}`).length).toBe(1);
    expect((await sql`select 1 from wantlist_items where origin = ${`mc:${a}`}`).length).toBe(1);
  });

  // ── the review panel ─────────────────────────────────────────────────────

  it('the review panel reads the critic-scores facet: CritiqueBrainz and each linked app, labelled; the app’s go when the module is off', async () => {
    const l = await link(person);
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Neu! 75') returning id::text as id`;
    await sql`insert into external_reviews (release_group_id, source, source_id, url, rating_normalized, license, body_text)
              values (${rg!.id}, 'critiquebrainz', 'cb1', 'https://critiquebrainz.org/review/1', 80, 'CC BY-SA 3.0', 'text')`;
    await sql`insert into mc_critic_scores (link_id, user_id, key, release_group_id, album, data, remote_updated_at)
              values (${l}, ${person.userId}, 'k', ${rg!.id}, '{}'::jsonb, ${sql.json({
                aggregate: { score: 8.7, tier: 'A', review_count: 2 },
                reviews: [{ source: 'Pitchfork', score: 9.1, score_raw: '9.1', url: 'https://pitchfork.com/r/1', published_at: null }],
                critic_ratings: [{ outlet: 'Metacritic', score: 8.6, score_raw: '86' }],
              } as never)}, now())`;
    const got = await criticScoresFor(sql, { userId: person.userId, libraryId }, rg!.id);
    expect(got.available).toBe(true);
    expect(got.values.map((v) => v.source.label)).toEqual(['CritiqueBrainz', 'review-gatherer']);
    const mc = got.values[1]!;
    expect(mc.reviews).toEqual([{ label: 'Pitchfork (via review-gatherer)', score: 9.1, scoreRaw: '9.1', url: 'https://pitchfork.com/r/1', publishedAt: null }]);
    expect(mc.criticRatings[0]!.label).toBe('Metacritic (via review-gatherer)');
    expect(got.values[0]).toMatchObject({ aggregate: { score: 8 }, reviews: [{ label: 'CritiqueBrainz' }] });
    // another person sees CritiqueBrainz only
    expect((await criticScoresFor(sql, { userId: owner.userId, libraryId }, rg!.id)).values.map((v) => v.source.label)).toEqual(['CritiqueBrainz']);
    await setMcEnabled(sql, false);
    expect((await criticScoresFor(sql, { userId: person.userId, libraryId }, rg!.id)).values.map((v) => v.source.label)).toEqual(['CritiqueBrainz']);
  });

  // ── the echo rule ────────────────────────────────────────────────────────

  it('an MBID a link filled goes out on the identity feed as provenance auto, never as stronger evidence', async () => {
    const l = await link(owner);
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, discogs_master_id, title) values (null, 4242, 'Filled') returning id::text as id`;
    const [rel] = await sql<Array<{ id: string }>>`insert into releases (release_group_id, title, discogs_release_id) values (${rg!.id}, 'Filled', 4243) returning id::text as id`;
    const [la] = await sql<Array<{ id: string }>>`insert into local_albums (library_id, cluster_key, state, release_group_id, release_id) values (${libraryId}, 'filled', 'matched', ${rg!.id}, ${rel!.id}) returning id::text as id`;
    await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_at)
              values (${libraryId}, ${la!.id}, ${rel!.id}, 0, 'confirmed', 'user', now() - interval '1 day')`;
    const before = await readFeed(sql, 'identity', { userId: owner.userId, libraryId }, null, 500);
    expect((before.filter((r) => r.key === rg!.id).at(-1)!.data as { provenance: string }).provenance).toBe('manual');
    const m = randomUUID();
    expect(await fillAlbumMbid(sql, rg!.id, m, { module: 'mc', sourceRef: l, actorUserId: owner.userId })).toBe('filled');
    const after = await readFeed(sql, 'identity', { userId: owner.userId, libraryId }, null, 500);
    const item = after.filter((r) => r.key === rg!.id).at(-1)!.data as { provenance: string; album: { rg_mbid: string } };
    expect(item.album.rg_mbid).toBe(m);
    expect(item.provenance).toBe('auto');
  });

  // ── the module switch ────────────────────────────────────────────────────

  it('off: the manifest and feeds answer 404, new links are refused, the facets say unavailable; the data stays', async () => {
    const l = await link(person);
    await suggestion(person, l, 'stays');
    const on = (await app.inject({ method: 'GET', url: '/api/v1/facets', headers: { cookie: person.cookie } })).json();
    expect(on.facets.find((f: { id: string }) => f.id === 'album.wantlist-suggestion@1').available).toBe(true);
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/music-connections', headers: as(owner), payload: { enabled: false } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: false });
    expect((await app.inject({ method: 'GET', url: '/.well-known/music-connections' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/mc/v1/identity' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/connections', headers: as(person), payload: { url: RG } })).statusCode).toBe(409);
    const offFacets = (await app.inject({ method: 'GET', url: '/api/v1/facets', headers: { cookie: person.cookie } })).json();
    expect(offFacets.facets.find((f: { id: string }) => f.id === 'album.wantlist-suggestion@1').available).toBe(false);
    expect(offFacets.modules.find((m: { id: string }) => m.id === 'mc').enabled).toBe(false);
    expect((await wantlistOf(person)).json()).toMatchObject({ available: false, suggestions: [] });
    expect((await sql`select 1 from mc_wantlist_suggestions where link_id = ${l}`).length).toBe(1);
    // a listener may not switch it
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/music-connections', headers: as(person), payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/music-connections', headers: as(owner), payload: { enabled: true } })).json()).toMatchObject({ enabled: true });
    expect((await app.inject({ method: 'GET', url: '/.well-known/music-connections' })).statusCode).toBe(200);
  });

  it('remove data revokes every link at its app and deletes the module’s rows, then leaves it off', async () => {
    const l = await link(person);
    await suggestion(person, l, 'bye');
    const res = await app.inject({ method: 'POST', url: '/api/v1/settings/music-connections/remove-data', headers: as(owner), payload: { keepFills: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, links: 0, landed: 0 });
    expect(seen.some((s) => s.url.endsWith('/connect/revoke'))).toBe(true);
    expect((await sql`select 1 from mc_links`).length).toBe(0);
    expect((await sql`select 1 from mc_wantlist_suggestions`).length).toBe(0);
    // what a person accepted earlier stays
    expect((await sql`select 1 from wantlist_items`).length).toBeGreaterThan(0);
  });

  // ── manifests and the schema ─────────────────────────────────────────────

  it('the drizzle schema has every column 0050 made (landing tables, the ledger, the link)', async () => {
    const tables = { identity_fills: identityFills, mc_critic_scores: mcCriticScores, mc_identity: mcIdentity, mc_wantlist_suggestions: mcWantlistSuggestions, mc_links: mcLinks, wantlist_items: wantlistItems };
    for (const [name, table] of Object.entries(tables)) {
      const inDb = (await sql<Array<{ c: string }>>`select column_name as c from information_schema.columns where table_name = ${name}`).map((r) => r.c).sort();
      const inSchema = Object.values(getTableColumns(table)).map((c) => c.name).sort();
      expect(inSchema, name).toEqual(inDb);
    }
  });

  it('every mc_ and player_ table is listed in its module’s manifest, and every listed table exists', async () => {
    const tables = (await sql<Array<{ t: string }>>`select table_name as t from information_schema.tables where table_schema = 'public'`).map((r) => r.t);
    for (const m of MODULES.filter((x) => x.prefix)) {
      const prefixed = tables.filter((t) => t.startsWith(m.prefix!)).sort();
      expect([...m.tables].filter((t) => t.startsWith(m.prefix!)).sort()).toEqual(prefixed);
      for (const t of m.tables) expect(tables).toContain(t);
    }
  });
});
