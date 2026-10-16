/**
 * connections.pull against the test database and a fake remote (no live
 * network: the checked requests are carried by a test transport). Covered:
 * paging with a cursor saved per page and per capability, the handler
 * interface (invalid items skipped and counted), silent refresh with the
 * rotated tokens kept sealed, a refused refresh → needs_reapproval with the
 * cursors kept while another link keeps pulling, backoff 1 → 5 → 15 → 60
 * with a retry queued, a new handler version re-pulling from a snapshot, a
 * feed moved off the origin refused, and the tick (due links queued, the
 * daily manifest re-read, new capabilities recorded).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import { openTokens, sealTokens, setRemoteFetch } from '@tagave/core/mc';
import type { FeedItem } from 'music-connections';
import type { WorkerContext } from '../lib/context.js';
import { LANDING_VERSION } from './mcLanding.js';
import { BACKOFF_MINUTES, STUB_HANDLERS, backoffMinutes, connectionsTick, refreshLinkManifest, runLinkPull, type PullHandlers } from './connectionsPull.js';

const SECRET = 'c'.repeat(64);
const RG = 'http://192.168.2.50:8080';
const OTHER = 'http://192.168.2.51:8080';
const MBID = '11111111-2222-4333-8444-555555555555';

const album = { rg_mbid: MBID, artist: 'Can', title: 'Tago Mago' };
const critic = (key: string) => ({ key, op: 'upsert', updated_at: '2026-10-01T00:00:00.000Z',
  data: { album, aggregate: { score: 8.4, tier: 'A', review_count: 3 }, reviews: [], critic_ratings: [] } });
const tombstone = (key: string) => ({ key, op: 'delete', updated_at: '2026-10-02T00:00:00.000Z', data: null });
const ident = (key: string) => ({ key, op: 'upsert', updated_at: '2026-10-01T00:00:00.000Z', data: { album, local_key: key, provenance: 'manual', confidence: 1 } });

interface Remote {
  origin: string;
  pages: Record<string, Array<{ items: unknown[]; next: string; more: boolean }>>;
  /** status per request path, consumed in order */
  status: Record<string, number[]>;
  tokenStatus: number;
  manifest: Record<string, unknown>;
  seen: Array<{ url: string; auth: string | undefined; body: string }>;
  access: string;
}

function remote(origin: string): Remote {
  return {
    origin,
    pages: {},
    status: {},
    tokenStatus: 200,
    manifest: {
      protocol: 'music-connections/1', service: 'review-gatherer', version: '0.4.0',
      auth: { authorize: '/connect/authorize', token: '/connect/token', register: '/connect/register' },
      provides: { 'critic-scores': '/mc/v1/critic-scores', identity: '/mc/v1/identity' },
      consumes: ['ratings'],
    },
    seen: [],
    access: 'acc-1',
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('connections.pull (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  const sent: Array<{ name: string; data: unknown; opts: Record<string, unknown> | undefined }> = [];
  const userId = randomUUID();
  let rg: Remote;
  let other: Remote;

  const serve = (r: Remote, url: string, init: RequestInit = {}): Response => {
    const u = new URL(url);
    const auth = new Headers(init.headers).get('authorization') ?? undefined;
    const body = typeof init.body === 'string' ? init.body : '';
    r.seen.push({ url, auth, body });
    if (u.pathname === '/.well-known/music-connections') return Response.json(r.manifest);
    if (u.pathname === '/connect/token') {
      if (r.tokenStatus !== 200) return Response.json({ error: 'invalid_grant' }, { status: r.tokenStatus });
      r.access = `acc-${r.seen.length}`;
      return Response.json({ access_token: r.access, refresh_token: `ref-${r.seen.length}`, expires_in: 3600 });
    }
    if (u.pathname === '/connect/revoke') return Response.json({});
    const forced = r.status[u.pathname]?.shift();
    if (forced) return new Response('', { status: forced });
    if (auth !== `Bearer ${r.access}`) return new Response('', { status: 401 });
    const cap = u.pathname.replace('/mc/v1/', '');
    const pages = r.pages[cap] ?? [];
    const since = u.searchParams.get('since');
    const i = since ? pages.findIndex((p, n) => n > 0 && pages[n - 1]!.next === since) : 0;
    return Response.json(pages[i < 0 ? pages.length - 1 : i] ?? { items: [], next: since ?? '', more: false });
  };

  async function link(origin: string, over: Record<string, unknown> = {}) {
    const id = randomUUID();
    const r = origin === RG ? rg : other;
    const tokens = sealTokens({ access_token: r.access, refresh_token: 'ref-0', client_secret: 'sec', access_expires_at: new Date(Date.now() + 3600_000).toISOString() }, SECRET);
    await client`insert into mc_links (id, user_id, remote_url, manifest, client_id, sealed_tokens, scopes, requested_scopes, state)
                 values (${id}, ${userId}, ${origin}, ${JSON.stringify(r.manifest)}::jsonb, 'cid', ${tokens}, ${['critic-scores:read', 'identity:read']}, ${['critic-scores:read', 'identity:read']}, 'active')`;
    // a stored cursor belongs to the landing version that wrote it (another version re-snapshots)
    if (over['cursors'] && !over['handler_versions']) {
      over = { ...over, handler_versions: JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(over['cursors'] as string)).map((c) => [c, LANDING_VERSION]))) };
    }
    for (const [k, v] of Object.entries(over)) {
      // this client reads and writes timestamps as text (makeDb), json as text too
      const cast = v instanceof Date ? '::text::timestamptz' : k === 'cursors' || k === 'handler_versions' || k === 'manifest' ? '::text::jsonb' : '';
      await client.unsafe(`update mc_links set ${k} = $1${cast} where id = $2`, [(v instanceof Date ? v.toISOString() : v) as never, id]);
    }
    return id;
  }
  const row = async (id: string) => (await client`select * from mc_links where id = ${id}`)[0];
  const opts = { appSecret: SECRET, sleep: async () => undefined };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    const boss = { send: async (name: string, data: unknown, o?: Record<string, unknown>) => { sent.push({ name, data, opts: o }); return 'job'; } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email) values (${userId}, ${`pull-${userId.slice(0, 8)}@example.test`})`;
  });

  afterAll(async () => {
    setRemoteFetch(undefined);
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    rg = remote(RG);
    other = remote(OTHER);
    sent.length = 0;
    setRemoteFetch(async (url, init) => serve(new URL(url).origin === RG ? rg : other, url, init));
    await client`delete from mc_links where user_id = ${userId}`;
  });
  afterEach(async () => { await client`delete from audit_log where actor_user_id = ${userId}`; });

  it('pulls every granted capability page by page, saving each cursor; invalid items are skipped and counted', async () => {
    rg.pages['critic-scores'] = [
      { items: [critic('a'), critic('b'), { key: 'bad', op: 'upsert', updated_at: 'yesterday', data: {} }], next: 'c1', more: true },
      { items: [tombstone('a')], next: 'c2', more: false },
    ];
    rg.pages['identity'] = [{ items: [ident('x')], next: 'i1', more: false }];
    const id = await link(RG);
    const cursorsSeen: unknown[] = [];
    const got: Record<string, FeedItem[]> = {};
    const handlers: PullHandlers = {
      'critic-scores': { version: 0, async apply(items, h) {
        cursorsSeen.push((await row(h.link.id)).cursors);
        (got['critic-scores'] ??= []).push(...items);
        return { applied: items.length, skipped: 0 };
      } },
      identity: STUB_HANDLERS.identity!,
    };
    const res = await runLinkPull(ctx, id, { ...opts, handlers });
    expect(res).toEqual({ status: 'ok', counts: { 'critic-scores': { applied: 3, skipped: 1 }, identity: { applied: 1, skipped: 0 } } });
    expect(got['critic-scores']!.map((i) => `${i.key}:${i.op}`)).toEqual(['a:upsert', 'b:upsert', 'a:delete']);
    // the second page started after the first page's cursor was saved
    expect(cursorsSeen).toEqual([{}, { 'critic-scores': 'c1' }]);
    const r = await row(id);
    expect(r).toMatchObject({ cursors: { 'critic-scores': 'c2', identity: 'i1' }, handler_versions: { 'critic-scores': 0, identity: 0 }, failures: 0, last_error: null, state: 'active' });
    expect(Number.isNaN(Date.parse(r.last_sync_at))).toBe(false);
    expect(r.pull_lease_owner).toBeNull();
    // the next run resumes from the cursors
    rg.seen.length = 0;
    await runLinkPull(ctx, id, { ...opts, handlers });
    expect(rg.seen.map((s) => new URL(s.url).searchParams.get('since'))).toEqual(['c2', 'i1']);
  });

  it('an expired access token is refreshed silently and the rotated pair kept sealed', async () => {
    rg.access = 'acc-new-not-yet';
    rg.pages['identity'] = [{ items: [ident('x')], next: 'i1', more: false }];
    const id = await link(RG);
    rg.access = 'something-else';
    const res = await runLinkPull(ctx, id, opts);
    expect(res.status).toBe('ok');
    const refresh = rg.seen.find((s) => s.url.endsWith('/connect/token'))!;
    expect(new URLSearchParams(refresh.body).get('grant_type')).toBe('refresh_token');
    const r = await row(id);
    const t = openTokens(r.sealed_tokens, SECRET)!;
    expect(t.access_token).toBe(rg.access);
    expect(t.refresh_token).toMatch(/^ref-/);
    expect(r.sealed_tokens).not.toContain(rg.access);
  });

  it('a refused refresh: needs_reapproval, cursors kept, audited once; other links keep pulling', async () => {
    const id = await link(RG, { cursors: JSON.stringify({ 'critic-scores': 'c9' }) });
    other.pages['identity'] = [{ items: [ident('y')], next: 'o1', more: false }];
    const id2 = await link(OTHER);
    rg.access = 'rotated-elsewhere';
    rg.tokenStatus = 400;
    expect((await runLinkPull(ctx, id, opts)).status).toBe('needs_reapproval');
    expect(await row(id)).toMatchObject({ state: 'needs_reapproval', cursors: { 'critic-scores': 'c9' }, last_error: 'needs re-approval' });
    const audits = await client`select action, payload from audit_log where actor_user_id = ${userId}`;
    expect(audits.map((a: { action: string }) => a.action)).toEqual(['mc.consumer.refresh_failed']);
    expect(JSON.stringify(audits)).not.toContain('ref-0');
    // pulls stop for it; the other link is untouched
    rg.seen.length = 0;
    expect((await runLinkPull(ctx, id, opts)).status).toBe('needs_reapproval');
    expect(rg.seen).toEqual([]);
    expect((await runLinkPull(ctx, id2, opts)).status).toBe('ok');
  });

  it('a remote that is down backs off 1, 5, 15, then 60 minutes, cursors unchanged, a retry queued each time', async () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 15, 60]);
    expect([1, 2, 3, 4, 5, 9].map(backoffMinutes)).toEqual([1, 5, 15, 60, 60, 60]);
    const id = await link(RG, { cursors: JSON.stringify({ 'critic-scores': 'c5' }) });
    rg.status['/mc/v1/critic-scores'] = [500, 500, 500, 500, 500];
    const waits: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const before = Date.now();
      const res = await runLinkPull(ctx, id, opts);
      expect(res).toMatchObject({ status: 'error', error: 'feed HTTP 500' });
      const r = await row(id);
      expect(r).toMatchObject({ failures: n, last_error: 'feed HTTP 500', state: 'active', cursors: { 'critic-scores': 'c5' } });
      waits.push(Math.round((Date.parse(r.next_attempt_at) - before) / 60_000));
    }
    expect(waits).toEqual([1, 5, 15, 60, 60]);
    expect(sent.map((s) => s.opts?.['startAfter'])).toEqual([60, 300, 900, 3600, 3600]);
    expect(sent.every((s) => s.name === 'connections.pull' && (s.data as { linkId: string }).linkId === id)).toBe(true);
    // the tick leaves it alone until next_attempt_at
    sent.length = 0;
    await connectionsTick(ctx);
    expect(sent).toEqual([]);
    // the remote comes back: one success clears the backoff
    await client`update mc_links set next_attempt_at = now() - interval '1 second' where id = ${id}`;
    expect((await runLinkPull(ctx, id, opts)).status).toBe('ok');
    expect(await row(id)).toMatchObject({ failures: 0, next_attempt_at: null, last_error: null });
  });

  it('a network failure during a refresh backs off instead of asking for approval again', async () => {
    const id = await link(RG);
    rg.access = 'rotated';
    setRemoteFetch(async (url, init) => {
      if (url.endsWith('/connect/token')) throw new TypeError('fetch failed');
      return serve(rg, url, init);
    });
    const res = await runLinkPull(ctx, id, opts);
    expect(res.status).toBe('error');
    expect(await row(id)).toMatchObject({ state: 'active', failures: 1 });
  });

  it('a new handler version starts its capability afresh from a snapshot', async () => {
    rg.pages['critic-scores'] = [{ items: [critic('a')], next: 'c1', more: false }];
    const id = await link(RG, { cursors: JSON.stringify({ 'critic-scores': 'old' }), handler_versions: JSON.stringify({ 'critic-scores': 0 }) });
    const resnapshots: string[] = [];
    const handlers: PullHandlers = {
      'critic-scores': { version: 1, apply: async (items) => ({ applied: items.length, skipped: 0 }), resnapshot: async (h) => { resnapshots.push(h.capability); } },
    };
    await runLinkPull(ctx, id, { ...opts, handlers });
    expect(resnapshots).toEqual(['critic-scores']);
    expect(new URL(rg.seen.find((s) => s.url.includes('critic-scores'))!.url).searchParams.has('since')).toBe(false);
    expect(await row(id)).toMatchObject({ cursors: { 'critic-scores': 'c1' }, handler_versions: { 'critic-scores': 1 } });
  });

  it('a 410 re-snapshots: the cursor resets and the handler is told', async () => {
    rg.pages['critic-scores'] = [{ items: [critic('a')], next: 'c1', more: false }];
    rg.status['/mc/v1/critic-scores'] = [410];
    const id = await link(RG, { cursors: JSON.stringify({ 'critic-scores': 'ancient' }), handler_versions: JSON.stringify({ 'critic-scores': 0 }) });
    const told: string[] = [];
    await runLinkPull(ctx, id, { ...opts, handlers: { 'critic-scores': { version: 0, apply: async (i) => ({ applied: i.length, skipped: 0 }), resnapshot: async () => { told.push('x'); } } } });
    expect(told).toEqual(['x']);
    expect((await row(id)).cursors).toEqual({ 'critic-scores': 'c1' });
  });

  it('a stored manifest whose feed points at another host is refused; no token is sent anywhere', async () => {
    rg.manifest = { ...rg.manifest, provides: { 'critic-scores': 'http://192.168.2.99/mc/v1/critic-scores' } };
    const id = await link(RG);
    const reached: string[] = [];
    setRemoteFetch(async (url) => { reached.push(url); return new Response('{}'); });
    const res = await runLinkPull(ctx, id, opts);
    expect(res).toMatchObject({ status: 'error', error: 'endpoint on another host' });
    expect(reached).toEqual([]);
  });

  it('a cursor longer than 512 characters is refused and recorded; the stored one stays', async () => {
    rg.pages['critic-scores'] = [{ items: [critic('a')], next: 'x'.repeat(600), more: false }];
    const id = await link(RG, { cursors: JSON.stringify({ 'critic-scores': 'c3' }) });
    const res = await runLinkPull(ctx, id, opts);
    expect(res).toMatchObject({ status: 'error', error: 'feed cursor too long' });
    expect(await row(id)).toMatchObject({ last_error: 'feed cursor too long', failures: 1, cursors: { 'critic-scores': 'c3' } });
  });

  it('only one run at a time per link', async () => {
    const id = await link(RG, { pull_lease_until: new Date(Date.now() + 60_000), pull_lease_owner: 'someone' });
    expect((await runLinkPull(ctx, id, opts)).status).toBe('busy');
  });

  it('the tick queues due links and re-reads stale manifests; a capability offered later is recorded, never granted', async () => {
    const due = await link(RG, { manifest_checked_at: new Date(Date.now() - 25 * 3600_000), last_attempt_at: new Date(Date.now() - 20 * 60_000) });
    const fresh = await link(OTHER, { manifest_checked_at: new Date(), last_attempt_at: new Date(Date.now() - 60_000) });
    rg.manifest = { ...rg.manifest, provides: { ...(rg.manifest['provides'] as object), 'wantlist-suggestions': '/mc/v1/wantlist-suggestions' } };
    const res = await connectionsTick(ctx);
    expect(res).toEqual({ manifests: 1, queued: 1 });
    expect(sent).toEqual([{ name: 'connections.pull', data: { linkId: due }, opts: { singletonKey: `connections.pull:${due}` } }]);
    const r = await row(due);
    expect(Object.keys(r.manifest.provides)).toContain('wantlist-suggestions');
    expect(r.scopes).toEqual(['critic-scores:read', 'identity:read']);
    const audits = await client`select action, payload from audit_log where actor_user_id = ${userId}`;
    expect(audits).toEqual([{ action: 'mc.consumer.capabilities_available', payload: { remote_host: '192.168.2.50:8080', added: ['wantlist-suggestions'] } }]);
    expect(Date.parse((await row(fresh)).manifest_checked_at)).toBeGreaterThan(Date.now() - 10_000);
  });

  it('a re-read manifest from another service is not taken', async () => {
    const id = await link(RG);
    rg.manifest = { ...rg.manifest, service: 'impostor' };
    expect(await refreshLinkManifest(ctx, id)).toBe(false);
    expect((await row(id)).manifest.service).toBe('review-gatherer');
  });
});
