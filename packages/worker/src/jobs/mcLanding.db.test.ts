/**
 * Landing what connections.pull brings in, against the test database and a
 * fake remote (no live network): critic scores, identity and wantlist
 * suggestions in their own link-scoped tables; the identity rules (fill a
 * gap, conflict, suggest, never overwrite, owners only, tombstones withdraw);
 * parked items attaching once their album is matched; the landing version
 * forcing a fresh snapshot that sweeps what was not resent; revoke deleting
 * exactly a link's rows; the module switch; and the plug → use → unplug
 * round trip leaving core rows as they were.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import pino from 'pino';
import { confirmFill, makeDb, mcEnabled, removeMcData, setMcEnabled, unplugLink } from '@tagave/db';
import { sealTokens, setRemoteFetch } from '@tagave/core/mc';
import type { FeedItem } from 'music-connections';
import type { WorkerContext } from '../lib/context.js';
import { connectionsPullJob, runLinkPull, type HandlerContext } from './connectionsPull.js';
import { LANDING_VERSION, attachParked, capParked, criticScoresHandler, identityHandler, wantlistHandler, type LandingDeps } from './mcLanding.js';
import { unplugLinkTx } from '@tagave/db';

const SECRET = 'd'.repeat(64);
const RG_ORIGIN = 'http://192.168.2.60:8080';
const now = '2026-10-01T00:00:00.000Z';

type Page = { items: unknown[]; next: string; more: boolean };

describe.skipIf(!process.env.TEST_DATABASE_URL)('music connections landing (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  const tag = randomUUID().slice(0, 8);
  const owner = randomUUID();
  const listener = randomUUID();
  const libraryId = randomUUID();
  const sourceId = randomUUID();
  let pages: Record<string, Page[]> = {};
  const seen: string[] = [];
  const opts = (landing: LandingDeps = {}) => ({ appSecret: SECRET, sleep: async () => undefined, landing });

  const uuid = () => randomUUID();
  const mbid = () => randomUUID();
  let masterSeq = 900_000_000 + Math.floor(Math.random() * 50_000_000);
  const nextMaster = () => ++masterSeq;
  let linkSeq = 0;

  async function link(userId: string, scopes = ['critic-scores:read', 'identity:read', 'wantlist-suggestions:read']) {
    const id = uuid();
    const manifest = {
      protocol: 'music-connections/1', service: 'review-gatherer', version: '0.4.0',
      auth: { authorize: '/connect/authorize', token: '/connect/token', register: '/connect/register' },
      provides: { 'critic-scores': '/mc/v1/critic-scores', identity: '/mc/v1/identity', 'wantlist-suggestions': '/mc/v1/wantlist-suggestions' },
      consumes: ['ratings'],
    };
    const tokens = sealTokens({ access_token: 'acc', refresh_token: 'ref', client_secret: 'sec', access_expires_at: new Date(Date.now() + 3600_000).toISOString() }, SECRET);
    // one link per person and address: a second link of one person uses another port
    const origin = `http://192.168.2.60:${8000 + ++linkSeq}`;
    await client`insert into mc_links (id, user_id, remote_url, manifest, client_id, sealed_tokens, scopes, requested_scopes, state)
                 values (${id}, ${userId}, ${origin}, ${JSON.stringify(manifest)}::text::jsonb, 'cid', ${tokens}, ${scopes}, ${scopes}, 'active')`;
    return id;
  }
  const hctx = async (linkId: string, capability: 'critic-scores' | 'identity' | 'wantlist-suggestions'): Promise<HandlerContext> => {
    const [l] = await client`select user_id, remote_url from mc_links where id = ${linkId}`;
    return { sql: ctx.sql, logger: ctx.logger, capability, link: { id: linkId, userId: l.user_id, remoteUrl: l.remote_url, service: 'review-gatherer' } };
  };

  const album = (over: Record<string, unknown> = {}) => ({ rg_mbid: null as string | null, artist: 'Can', title: 'Tago Mago', ...over });
  const critic = (key: string, a: Record<string, unknown>, score = 8.4, extra: Record<string, unknown> = {}): FeedItem => ({
    key, op: 'upsert', updated_at: now,
    data: { album: a, aggregate: { score, tier: 'A', review_count: 1 }, reviews: [{ source: 'Pitchfork', score, score_raw: String(score), url: '/reviews/1', published_at: null }], critic_ratings: [], ...extra },
  });
  const ident = (key: string, a: Record<string, unknown>, provenance = 'manual', confidence = 1): FeedItem => ({
    key, op: 'upsert', updated_at: now, data: { album: a, local_key: key, provenance, confidence },
  });
  const want = (key: string, a: Record<string, unknown>): FeedItem => ({ key, op: 'upsert', updated_at: now, data: { album: a, reason: 'You rate Neu! highly', score: 8, suggested_at: now } });
  const tomb = (key: string): FeedItem => ({ key, op: 'delete', updated_at: now, data: null });

  async function releaseGroup(over: { mbid?: string | null; master?: number | null; release?: number | null } = {}) {
    const id = uuid();
    const m = over.mbid === undefined ? mbid() : over.mbid;
    const master = over.master === undefined ? (m === null ? nextMaster() : null) : over.master;
    await client`insert into release_groups (id, mbid, discogs_master_id, discogs_release_id, title) values (${id}, ${m}, ${master}, ${over.release ?? null}, ${`rg ${tag}`})`;
    return { id, mbid: m, master };
  }
  async function release(rgId: string, m: string = mbid()) {
    const id = uuid();
    await client`insert into releases (id, release_group_id, mbid, title) values (${id}, ${rgId}, ${m}, 'r')`;
    return { id, mbid: m };
  }
  async function localAlbum(rgId: string | null, releaseId: string | null = null) {
    const id = uuid();
    await client`insert into local_albums (id, library_id, cluster_key, state, release_group_id, release_id, title_guess)
                 values (${id}, ${libraryId}, ${`k-${id}`}, ${rgId ? 'matched' : 'pending'}, ${rgId}, ${releaseId}, 'Tago Mago')`;
    return id;
  }
  const rgRow = async (id: string) => (await client`select mbid from release_groups where id = ${id}`)[0];

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => 'job' } as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email, role) values (${owner}, ${`own-${tag}@example.test`}, 'owner'), (${listener}, ${`lis-${tag}@example.test`}, 'listener')`;
    await client`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${owner}, ${`landing ${tag}`})`;
    await client`insert into collection_sources (id, library_id, provider) values (${sourceId}, ${libraryId}, 'tagave')`;
  });

  afterAll(async () => {
    setRemoteFetch(undefined);
    await client`delete from match_candidates where source like 'mc:%' and local_album_id in (select id from local_albums where library_id = ${libraryId})`;
    await client`delete from users where id in (${owner}, ${listener})`.catch(() => undefined);
    await client`delete from libraries where id = ${libraryId}`.catch(() => undefined);
    await client`delete from release_groups where title = ${`rg ${tag}`}`;
    await client`delete from audit_log where actor_user_id in (${owner}, ${listener})`;
    await client.end({ timeout: 5 });
  });

  beforeEach(() => {
    pages = {};
    seen.length = 0;
    setRemoteFetch(async (url, init) => {
      const u = new URL(url);
      seen.push(u.pathname + u.search);
      if (new Headers(init?.headers).get('authorization') !== 'Bearer acc') return new Response('', { status: 401 });
      const cap = u.pathname.replace('/mc/v1/', '');
      const ps = pages[cap] ?? [];
      const since = u.searchParams.get('since');
      const i = since ? ps.findIndex((p, n) => n > 0 && ps[n - 1]!.next === since) : 0;
      return Response.json(ps[i < 0 ? ps.length - 1 : i] ?? { items: [], next: since ?? '', more: false });
    });
  });

  // ── critic-scores ────────────────────────────────────────────────────────

  it('critic scores land per link and person, on the album; no prose is kept and review URLs are absolute http(s)', async () => {
    const rg = await releaseGroup();
    const a = await link(owner);
    pages['critic-scores'] = [{ items: [critic('k1', album({ rg_mbid: rg.mbid }), 8.4, { body: 'long prose', text: 'more prose' })], next: 'c1', more: false }];
    const res = await runLinkPull(ctx, a, opts());
    expect(res.status).toBe('ok');
    const [row] = await client`select user_id, release_group_id, data from mc_critic_scores where link_id = ${a}`;
    expect(row).toMatchObject({ user_id: owner, release_group_id: rg.id });
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    expect(JSON.stringify(data)).not.toContain('prose');
    expect(data).not.toHaveProperty('album');
    expect(data.reviews[0].url).toMatch(/^http:\/\/192\.168\.2\.60:\d+\/reviews\/1$/);
  });

  it('a critic-scores tombstone removes only that link’s row for that key: another link’s and CritiqueBrainz’s stay', async () => {
    const rg = await releaseGroup();
    const a = await link(owner);
    const b = await link(owner);
    await client`insert into external_reviews (release_group_id, source, source_id, rating_normalized, license, body_text)
                 values (${rg.id}, 'critiquebrainz', ${`cb-${tag}`}, 80, 'CC BY-SA 3.0', 'text')`;
    await criticScoresHandler.apply([critic('same', album({ rg_mbid: rg.mbid })), critic('other', album({ rg_mbid: rg.mbid }))], await hctx(a, 'critic-scores'));
    await criticScoresHandler.apply([critic('same', album({ rg_mbid: rg.mbid }))], await hctx(b, 'critic-scores'));
    await criticScoresHandler.apply([tomb('same')], await hctx(a, 'critic-scores'));
    expect((await client`select key from mc_critic_scores where link_id = ${a}`).map((r: { key: string }) => r.key)).toEqual(['other']);
    expect((await client`select key from mc_critic_scores where link_id = ${b}`).map((r: { key: string }) => r.key)).toEqual(['same']);
    expect((await client`select 1 from external_reviews where release_group_id = ${rg.id} and source = 'critiquebrainz'`).length).toBe(1);
  });

  it('an item with no album here is parked and attaches once the album is matched (D4)', async () => {
    const a = await link(owner);
    const futureMbid = mbid();
    const master = nextMaster();
    await criticScoresHandler.apply([critic('p1', album({ rg_mbid: futureMbid }))], await hctx(a, 'critic-scores'));
    await wantlistHandler.apply([want('w1', album({ rg_mbid: null, discogs_master_id: master }))], await hctx(a, 'wantlist-suggestions'));
    expect((await client`select release_group_id from mc_critic_scores where link_id = ${a}`)[0].release_group_id).toBeNull();
    // an identify run brings the album in
    const rg = await releaseGroup({ mbid: futureMbid });
    const byDiscogs = await releaseGroup({ mbid: null, master });
    expect(await attachParked(ctx.sql, { linkId: a })).toBe(2);
    expect((await client`select release_group_id from mc_critic_scores where link_id = ${a}`)[0].release_group_id).toBe(rg.id);
    expect((await client`select release_group_id from mc_wantlist_suggestions where link_id = ${a}`)[0].release_group_id).toBe(byDiscogs.id);
  });

  it('parked rows that keep failing never starve the others: the longest-untried go first', async () => {
    const a = await link(owner);
    const mbids: Record<string, string> = { 'p-a': mbid(), 'p-b': mbid(), 'p-c': mbid() };
    await criticScoresHandler.apply(Object.entries(mbids).map(([k, m]) => critic(k, album({ rg_mbid: m }))), await hctx(a, 'critic-scores'));
    // a try of two: two are stamped, one has never been tried
    expect(await attachParked(ctx.sql, { linkId: a, batch: 2 })).toBe(0);
    const untried = await client`select key from mc_critic_scores where link_id = ${a} and last_tried_at is null`;
    expect(untried).toHaveLength(1);
    const key = untried[0].key as string;
    // its album arrives: the next try of one takes it, before the two that failed
    await releaseGroup({ mbid: mbids[key]! });
    expect(await attachParked(ctx.sql, { linkId: a, batch: 1 })).toBe(1);
    expect((await client`select release_group_id from mc_critic_scores where link_id = ${a} and key = ${key}`)[0].release_group_id).not.toBeNull();
  });

  it('a link keeps a bounded number of parked rows; the oldest go and are counted on the link', async () => {
    const a = await link(owner);
    for (const k of ['o1', 'o2', 'o3', 'o4']) await criticScoresHandler.apply([critic(k, album({ rg_mbid: mbid() }))], await hctx(a, 'critic-scores'));
    await wantlistHandler.apply([want('kept', album({ rg_mbid: mbid() })), want('open', album({ rg_mbid: mbid() }))], await hctx(a, 'wantlist-suggestions'));
    await client`update mc_wantlist_suggestions set decision = 'accepted', decided_at = now(), updated_at = now() - interval '1 day' where link_id = ${a} and key = 'kept'`;
    expect(await capParked(ctx.sql, a, 2)).toBe(2);
    expect((await client`select key from mc_critic_scores where link_id = ${a} order by key`).map((r: { key: string }) => r.key)).toEqual(['o3', 'o4']);
    expect((await client`select key from mc_wantlist_suggestions where link_id = ${a} order by key`).map((r: { key: string }) => r.key)).toEqual(['kept', 'open']);
    expect((await client`select parked_dropped from mc_links where id = ${a}`)[0].parked_dropped).toBe(2);
  });

  it('a revoke during a slow page waits for it, then deletes what it landed; the next page lands nothing', async () => {
    const rgA = await releaseGroup({ mbid: null });
    const rgB = await releaseGroup({ mbid: null });
    const a = await link(owner);
    pages['identity'] = [
      { items: [ident('slow', album({ rg_mbid: mbid(), discogs_master_id: rgA.master }))], next: 'p1', more: true },
      { items: [ident('after', album({ rg_mbid: mbid(), discogs_master_id: rgB.master }))], next: 'p2', more: false },
    ];
    let started!: () => void;
    const inPage = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = identityHandler();
    let first = true;
    const slow = { ...real, apply: async (items: FeedItem[], h: HandlerContext) => {
      const x = await real.apply(items, h);
      if (first) { first = false; started(); await gate; }
      return x;
    } };
    const pulling = runLinkPull(ctx, a, { ...opts(), handlers: { identity: slow } });
    await inPage;
    // the route's revoke: the link row for update, then its rows, in one transaction
    let revoked = false;
    const revoking = ctx.sql.begin(async (tx) => {
      await tx`with old as (select id from mc_links where id = ${a} for update)
               update mc_links m set state = 'revoked', sealed_tokens = '' from old where m.id = old.id`;
      await unplugLinkTx(tx, a, owner);
      revoked = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(revoked).toBe(false); // it waits for the page in flight
    release();
    await revoking;
    const res = await pulling;
    expect(res.status).toBe('error');
    expect((await client`select 1 from mc_identity where link_id = ${a}`).length).toBe(0);
    expect((await client`select 1 from identity_fills where source_ref = ${a}`).length).toBe(0);
    expect((await rgRow(rgA.id)).mbid).toBeNull();
    expect((await rgRow(rgB.id)).mbid).toBeNull();
  });

  it('the landing version forces a fresh snapshot (stub cursors are dropped), and what the snapshot did not resend is swept', async () => {
    expect(LANDING_VERSION).toBeGreaterThan(0);
    const rg = await releaseGroup();
    const a = await link(owner);
    // rows and a cursor from before (the count-only stubs advanced cursors under version 0)
    await criticScoresHandler.apply([critic('gone', album({ rg_mbid: rg.mbid })), critic('kept', album({ rg_mbid: rg.mbid }))], await hctx(a, 'critic-scores'));
    await client`update mc_links set cursors = '{"critic-scores":"stub-cursor"}'::jsonb, handler_versions = '{"critic-scores":0}'::jsonb where id = ${a}`;
    pages['critic-scores'] = [{ items: [critic('kept', album({ rg_mbid: rg.mbid }), 9)], next: 's1', more: false }];
    expect((await runLinkPull(ctx, a, opts())).status).toBe('ok');
    expect(seen.find((s) => s.startsWith('/mc/v1/critic-scores'))).not.toContain('since=');
    const [l] = await client`select cursors, handler_versions, snapshot_since from mc_links where id = ${a}`;
    expect(l).toMatchObject({ cursors: { 'critic-scores': 's1' }, handler_versions: { 'critic-scores': LANDING_VERSION } });
    expect(l.snapshot_since).not.toHaveProperty('critic-scores');
    expect((await client`select key from mc_critic_scores where link_id = ${a}`).map((r: { key: string }) => r.key)).toEqual(['kept']);
    // the next pull resumes from the cursor: no sweep
    seen.length = 0;
    expect((await runLinkPull(ctx, a, opts())).status).toBe('ok');
    expect(seen.find((s) => s.startsWith('/mc/v1/critic-scores'))).toContain('since=s1');
    expect((await client`select key from mc_critic_scores where link_id = ${a}`).length).toBe(1);
  });

  // ── identity ─────────────────────────────────────────────────────────────

  it('fills a gap: an owner’s link, manual and sure, an empty release group, the MBID nobody has', async () => {
    const rg = await releaseGroup({ mbid: null });
    const a = await link(owner);
    const m = mbid();
    await identityHandler().apply([ident('i1', album({ rg_mbid: m, discogs_master_id: rg.master }))], await hctx(a, 'identity'));
    expect((await rgRow(rg.id)).mbid).toBe(m);
    expect(await client`select module, source_ref, value, confirmed_at from identity_fills where entity_id = ${rg.id}`)
      .toEqual([{ module: 'mc', source_ref: a, value: m, confirmed_at: null }]);
    expect((await client`select state from mc_identity where link_id = ${a}`)[0].state).toBe('filled');
    expect((await client`select action from audit_log where subject_id = ${rg.id}`).map((r: { action: string }) => r.action)).toEqual(['identity.fill']);
  });

  it('only an owner’s link fills shared identity (D3); another person’s link suggests', async () => {
    const rg = await releaseGroup({ mbid: null });
    const other = await releaseGroup();
    const rel = await release(other.id);
    const la = await localAlbum(rg.id);
    const l = await link(listener);
    const m = other.mbid!;
    // the MBID is the other group's here: use a fresh one, and name a release tagave has
    const fresh = mbid();
    await identityHandler().apply([ident('d3', album({ rg_mbid: fresh, discogs_master_id: rg.master, release_mbid: rel.mbid }))], await hctx(l, 'identity'));
    expect((await rgRow(rg.id)).mbid).toBeNull();
    expect((await client`select 1 from identity_fills where entity_id = ${rg.id}`).length).toBe(0);
    expect((await client`select state from mc_identity where link_id = ${l}`)[0].state).toBe('suggested');
    const cands = await client`select local_album_id, release_id, source, breakdown->'mc'->>'key' as key from match_candidates where source = ${`mc:${l}`}`;
    expect(cands).toEqual([{ local_album_id: la, release_id: rel.id, source: `mc:${l}`, key: 'd3' }]);
    expect(m).not.toBe(fresh);
  });

  it('an MBID another release group already has is a conflict, never a fill', async () => {
    const holder = await releaseGroup();
    const rg = await releaseGroup({ mbid: null });
    const a = await link(owner);
    await identityHandler().apply([ident('c1', album({ rg_mbid: holder.mbid, discogs_master_id: rg.master }))], await hctx(a, 'identity'));
    expect((await rgRow(rg.id)).mbid).toBeNull();
    expect((await client`select state from mc_identity where link_id = ${a}`)[0].state).toBe('conflict');
  });

  it('disagreeing with a confirmed match becomes a candidate; the match and the MBID are never overwritten', async () => {
    const mine = await releaseGroup({ master: nextMaster() });
    const myRelease = await release(mine.id);
    const la = await localAlbum(mine.id, myRelease.id);
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by)
                 values (${libraryId}, ${la}, ${myRelease.id}, 0.01, 'confirmed', 'user')`;
    const theirs = await releaseGroup();
    const theirRelease = await release(theirs.id);
    const a = await link(owner);
    const before = await client`select release_id, status, decided_by from album_matches where local_album_id = ${la}`;
    await identityHandler().apply([ident('x1', album({ rg_mbid: theirs.mbid, discogs_master_id: mine.master, release_mbid: theirRelease.mbid }))], await hctx(a, 'identity'));
    expect(await client`select release_id, status, decided_by from album_matches where local_album_id = ${la}`).toEqual(before);
    expect((await rgRow(mine.id)).mbid).toBe(mine.mbid);
    expect((await client`select state from mc_identity where link_id = ${a}`)[0].state).toBe('suggested');
    expect((await client`select release_id from match_candidates where local_album_id = ${la} and source = ${`mc:${a}`}`)[0].release_id).toBe(theirRelease.id);
  });

  it('a weak identity waits for its release, fetched the identify way, then becomes a candidate', async () => {
    const rg = await releaseGroup({ mbid: null });
    const la = await localAlbum(rg.id);
    const a = await link(owner);
    const relMbid = mbid();
    const fetched: string[] = [];
    const deps: LandingDeps = {
      fetchRelease: async (m) => {
        fetched.push(m);
        const target = await releaseGroup();
        return (await release(target.id, m)).id;
      },
    };
    const h = identityHandler(deps);
    await h.apply([ident('w1', album({ rg_mbid: mbid(), discogs_master_id: rg.master, release_mbid: relMbid }), 'auto', 0.7)], await hctx(a, 'identity'));
    expect((await client`select state from mc_identity where link_id = ${a}`)[0].state).toBe('awaiting_release');
    await h.after!(await hctx(a, 'identity'));
    expect(fetched).toEqual([relMbid]);
    expect((await client`select state from mc_identity where link_id = ${a}`)[0].state).toBe('suggested');
    expect((await client`select distance::text as d from match_candidates where local_album_id = ${la} and source = ${`mc:${a}`}`)[0].d).toBe('0.3000');
    expect((await rgRow(rg.id)).mbid).toBeNull();
  });

  it('an identity tombstone withdraws its fill (unconfirmed) and its candidates', async () => {
    const rg = await releaseGroup({ mbid: null });
    const a = await link(owner);
    const h = identityHandler();
    await h.apply([ident('t1', album({ rg_mbid: mbid(), discogs_master_id: rg.master }))], await hctx(a, 'identity'));
    expect((await rgRow(rg.id)).mbid).not.toBeNull();
    // the same fact again changes nothing (a snapshot resends it)
    await h.apply([ident('t1', album({ rg_mbid: (await rgRow(rg.id)).mbid, discogs_master_id: rg.master }))], await hctx(a, 'identity'));
    expect((await client`select action from audit_log where subject_id = ${rg.id}`).length).toBe(1);
    await h.apply([tomb('t1')], await hctx(a, 'identity'));
    expect((await rgRow(rg.id)).mbid).toBeNull();
    expect((await client`select 1 from mc_identity where link_id = ${a}`).length).toBe(0);
  });

  // ── wantlist-suggestions ─────────────────────────────────────────────────

  it('wantlist suggestions land; a tombstone removes an undecided one and leaves a decided one', async () => {
    const a = await link(owner);
    pages['wantlist-suggestions'] = [{ items: [want('s1', album({ rg_mbid: mbid() })), want('s2', album({ rg_mbid: mbid() }))], next: 'w1', more: false }];
    expect((await runLinkPull(ctx, a, opts())).status).toBe('ok');
    await client`update mc_wantlist_suggestions set decision = 'dismissed', decided_at = now() where link_id = ${a} and key = 's2'`;
    await wantlistHandler.apply([tomb('s1'), tomb('s2')], await hctx(a, 'wantlist-suggestions'));
    expect(await client`select key, decision from mc_wantlist_suggestions where link_id = ${a}`).toEqual([{ key: 's2', decision: 'dismissed' }]);
  });

  // ── unplug ───────────────────────────────────────────────────────────────

  it('revoking a link deletes exactly its rows, reverts its unconfirmed fills, keeps confirmed and person-changed values', async () => {
    const a = await link(owner);
    const b = await link(owner);
    const rgFill = await releaseGroup({ mbid: null });
    const rgKeep = await releaseGroup({ mbid: null });
    const rgChanged = await releaseGroup({ mbid: null });
    const h = identityHandler();
    await h.apply([
      ident('f1', album({ rg_mbid: mbid(), discogs_master_id: rgFill.master })),
      ident('f2', album({ rg_mbid: mbid(), discogs_master_id: rgKeep.master })),
      ident('f3', album({ rg_mbid: mbid(), discogs_master_id: rgChanged.master })),
    ], await hctx(a, 'identity'));
    const [keep] = await client`select id from identity_fills where entity_id = ${rgKeep.id}`;
    await confirmFill(ctx.sql, keep.id, owner);
    const personSet = mbid();
    await client`update release_groups set mbid = ${personSet} where id = ${rgChanged.id}`;
    const rg = await releaseGroup();
    await criticScoresHandler.apply([critic('k', album({ rg_mbid: rg.mbid }))], await hctx(a, 'critic-scores'));
    await criticScoresHandler.apply([critic('k', album({ rg_mbid: rg.mbid }))], await hctx(b, 'critic-scores'));
    await wantlistHandler.apply([want('s', album({ rg_mbid: rg.mbid }))], await hctx(a, 'wantlist-suggestions'));

    const counts = await unplugLink(ctx.sql, a, owner);
    expect(counts).toMatchObject({ fillsReverted: 1, fillsKept: 2 });
    expect((await rgRow(rgFill.id)).mbid).toBeNull();
    expect((await rgRow(rgKeep.id)).mbid).not.toBeNull();
    expect((await rgRow(rgChanged.id)).mbid).toBe(personSet);
    for (const t of ['mc_critic_scores', 'mc_identity', 'mc_wantlist_suggestions']) {
      expect((await client`select 1 from ${client(t)} where link_id = ${a}`).length).toBe(0);
    }
    expect((await client`select 1 from mc_critic_scores where link_id = ${b}`).length).toBe(1);
  });

  it('revoking keeps a candidate a person accepted and deletes the undecided ones (identify.withdraw)', async () => {
    const theirs = await releaseGroup();
    const accepted = await release(theirs.id);
    const open = await release(theirs.id);
    const mine = await releaseGroup({ master: nextMaster() });
    const la1 = await localAlbum(mine.id);
    const la2 = await localAlbum(mine.id);
    const a = await link(owner);
    await identityHandler().apply([ident('acc', album({ rg_mbid: theirs.mbid, discogs_master_id: mine.master, release_mbid: accepted.mbid }))], await hctx(a, 'identity'));
    // a person takes the suggestion for the first album (queue accept: decided_by user)
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by)
                 values (${libraryId}, ${la1}, ${accepted.id}, 0, 'confirmed', 'user')`;
    await identityHandler().apply([ident('open', album({ rg_mbid: theirs.mbid, discogs_master_id: mine.master, release_mbid: open.mbid }))], await hctx(a, 'identity'));
    expect((await client`select 1 from match_candidates where source = ${`mc:${a}`}`).length).toBe(4);
    await unplugLink(ctx.sql, a, owner);
    const left = await client`select local_album_id, release_id from match_candidates where source = ${`mc:${a}`}`;
    expect(left).toEqual([{ local_album_id: la1, release_id: accepted.id }]);
    void la2;
  });

  it('turned off: no pull runs, nothing is queued, and the data stays', async () => {
    const a = await link(owner);
    await criticScoresHandler.apply([critic('stay', album({ rg_mbid: mbid() }))], await hctx(a, 'critic-scores'));
    const was = await mcEnabled(ctx.sql);
    await setMcEnabled(ctx.sql, false);
    try {
      expect(await mcEnabled(ctx.sql)).toBe(false);
      expect(await connectionsPullJob(ctx, { linkId: a }, opts())).toEqual({ skipped: 'music connections is off' });
      expect(await connectionsPullJob(ctx, {}, opts())).toEqual({ skipped: 'music connections is off' });
      expect(seen).toEqual([]);
      expect((await client`select 1 from mc_critic_scores where link_id = ${a}`).length).toBe(1);
    } finally {
      await setMcEnabled(ctx.sql, was);
    }
  });

  // ── the round trip (Module Composition Principle rule 5) ────────────────

  /** A hash of the core and built-in tables, row by row in primary-key order, this test's library and albums only. */
  async function coreSnapshot(skip: { wantlistOrigin?: boolean; mbidOf?: string[] } = {}): Promise<Record<string, string>> {
    const q: Record<string, Promise<unknown[]>> = {
      release_groups: client`select id, ${skip.mbidOf?.length ? client`case when id = any(${skip.mbidOf}::uuid[]) then null else mbid end` : client`mbid`} as mbid,
                                    discogs_master_id, discogs_release_id, title from release_groups where title = ${`rg ${tag}`} order by id`,
      releases: client`select r.* from releases r join release_groups g on g.id = r.release_group_id where g.title = ${`rg ${tag}`} order by r.id`,
      local_albums: client`select id, state, release_group_id, release_id from local_albums where library_id = ${libraryId} order by id`,
      album_matches: client`select * from album_matches where library_id = ${libraryId} order by id`,
      match_candidates: client`select c.* from match_candidates c join local_albums la on la.id = c.local_album_id where la.library_id = ${libraryId} order by c.id`,
      external_reviews: client`select e.* from external_reviews e join release_groups g on g.id = e.release_group_id where g.title = ${`rg ${tag}`} order by e.id`,
      wantlist_items: client`select * from wantlist_items where library_id = ${libraryId} ${skip.wantlistOrigin ? client`and origin is null` : client``} order by id`,
      collection_items: client`select * from collection_items where library_id = ${libraryId} order by id`,
      collection_sources: client`select * from collection_sources where library_id = ${libraryId} order by id`,
      user_reviews: client`select * from user_reviews where library_id = ${libraryId} order by id`,
      listens: client`select * from listens where library_id = ${libraryId} order by id`,
      field_locks: client`select * from field_locks where library_id = ${libraryId} order by id`,
      identity_fills: client`select f.* from identity_fills f join release_groups g on g.id = f.entity_id where g.title = ${`rg ${tag}`} and f.confirmed_at is null order by f.id`,
    };
    const out: Record<string, string> = {};
    for (const [k, p] of Object.entries(q)) out[k] = createHash('sha256').update(JSON.stringify(await p)).digest('hex');
    return out;
  }

  it('plug → use → unplug leaves core rows as they were, apart from what a person decided', async () => {
    // core as it is: an empty group, a matched album with a confirmed match, a review
    const empty = await releaseGroup({ mbid: null });
    const mine = await releaseGroup({ master: nextMaster() });
    const myRelease = await release(mine.id);
    const la = await localAlbum(mine.id, myRelease.id);
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by)
                 values (${libraryId}, ${la}, ${myRelease.id}, 0.02, 'confirmed', 'user')`;
    const theirs = await releaseGroup();
    const theirRelease = await release(theirs.id);
    const before = await coreSnapshot();

    // plug in and use: a fill, a conflict suggestion, a tombstone, an accepted suggestion
    const a = await link(owner);
    pages['identity'] = [{ items: [
      ident('fill', album({ rg_mbid: mbid(), discogs_master_id: empty.master })),
      ident('conflict', album({ rg_mbid: theirs.mbid, discogs_master_id: mine.master, release_mbid: theirRelease.mbid })),
    ], next: 'i1', more: false }];
    pages['critic-scores'] = [{ items: [critic('c', album({ rg_mbid: mine.mbid })), critic('t', album({ rg_mbid: mine.mbid })), tomb('t')], next: 'c1', more: false }];
    pages['wantlist-suggestions'] = [{ items: [want('s', album({ rg_mbid: theirs.mbid }))], next: 'w1', more: false }];
    expect((await runLinkPull(ctx, a, opts())).status).toBe('ok');
    expect((await rgRow(empty.id)).mbid).not.toBeNull();
    expect((await client`select 1 from match_candidates where source = ${`mc:${a}`}`).length).toBe(1);
    // the person accepts the suggestion (api › wantlist accept: a tagave-only wantlist entry)
    const [w] = await client`insert into wantlist_items (library_id, collection_source_id, release_group_id, title, artist, origin, date_added)
                             values (${libraryId}, ${sourceId}, ${theirs.id}, 'Tago Mago', 'Can', ${`mc:${a}`}, now()) returning id`;
    await client`update mc_wantlist_suggestions set decision = 'accepted', decided_at = now(), wantlist_item_id = ${w.id} where link_id = ${a}`;
    expect(await coreSnapshot()).not.toEqual(before);

    // unplug: revoke the link
    await unplugLink(ctx.sql, a, owner);
    // the accepted entry is the person's: everything else is as it was
    expect(await coreSnapshot({ wantlistOrigin: true })).toEqual(before);
    expect((await client`select 1 from wantlist_items where id = ${w.id}`).length).toBe(1);
    expect(await client`select key from mc_critic_scores where link_id = ${a}`).toEqual([]);
  });

  it('removing the module’s data with "Keep": core differs only in the MBIDs a person chose to keep', async () => {
    // what the earlier tests left plugged in goes first
    await removeMcData(ctx.sql, { keepFills: false, actorUserId: owner });
    const empty = await releaseGroup({ mbid: null });
    const before = await coreSnapshot();
    const a = await link(owner);
    await identityHandler().apply([ident('k', album({ rg_mbid: mbid(), discogs_master_id: empty.master }))], await hctx(a, 'identity'));
    const filled = (await rgRow(empty.id)).mbid;
    await removeMcData(ctx.sql, { keepFills: true, actorUserId: owner });
    expect((await rgRow(empty.id)).mbid).toBe(filled);
    expect(await coreSnapshot({ mbidOf: [empty.id] })).toEqual(before);
    expect((await client`select 1 from mc_links`).length).toBe(0);
  });
});
