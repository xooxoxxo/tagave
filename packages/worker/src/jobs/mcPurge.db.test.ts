/**
 * mc.purge against the test database: rows a newer row of the same key
 * supersedes go; tombstones older than 90 days go unless their key has data
 * now (then the key is logged again as an upsert); everything else stays.
 * The provider's ended token families and unused clients go after 30 days;
 * the client side's links stay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb, mcEnabled, setMcEnabled } from '@tagave/db';
import pino from 'pino';
import { mcPurgeJob, pruneOAuth } from './mcPurge.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('mc.purge (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rgLive = randomUUID();
  const tag = randomUUID().slice(0, 8);
  let was = false;

  const row = (key: string, op: 'upsert' | 'delete', age: string) =>
    client`insert into facet_changes (facet, key, op, user_id, library_id, changed_at)
           values ('album.rating@1', ${key}, ${op}, ${userId}, ${libraryId}, now() - ${age}::interval)`;
  const left = async () =>
    (await client`select key, op from facet_changes where library_id = ${libraryId} order by key, changed_at`)
      .map((r: { key: string; op: string }) => `${r.key.replace(`${tag}:`, '')} ${r.op}`)
      .sort();

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email) values (${userId}, ${`purge-${tag}@example.test`})`;
    await client`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${userId}, 'purge test')`;
    // Music Connections is off by default: the purge runs anyway
    was = await mcEnabled(client);
    await setMcEnabled(client, false);
    await client`insert into release_groups (id, mbid, title) values (${rgLive}, ${randomUUID()}, 'purge test')`;
    // a rating that exists (its trigger logs one upsert, removed below)
    await client`insert into user_reviews (library_id, user_id, release_group_id, rating) values (${libraryId}, ${userId}, ${rgLive}, 4)`;
    await client`delete from facet_changes where library_id = ${libraryId}`;

    await row(`${tag}:old-delete`, 'delete', '91 days');
    await row(`${tag}:older-delete`, 'delete', '400 days');
    await row(`${tag}:recent-delete`, 'delete', '89 days');
    await row(`${tag}:old-upsert`, 'upsert', '400 days');
    // three rows of one key: only the newest stays
    await row(`${tag}:busy`, 'upsert', '3 days');
    await row(`${tag}:busy`, 'delete', '2 days');
    await row(`${tag}:busy`, 'upsert', '1 day');
    // a stale delete as the newest row of a key that has data now
    await row(rgLive, 'delete', '120 days');
  });

  afterAll(async () => {
    await setMcEnabled(client, was);
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from release_groups where id = ${rgLive}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('drops superseded rows and old tombstones, never a key that has data', async () => {
    expect(await mcEnabled(client)).toBe(false);
    const result = await mcPurgeJob(ctx, { batchSize: 1 });
    expect(result).toMatchObject({ relogged: 1 });
    expect(result.superseded).toBeGreaterThanOrEqual(3);
    expect(result.tombstones).toBeGreaterThanOrEqual(2);
    expect(await left()).toEqual([
      'busy upsert',
      'old-upsert upsert',
      'recent-delete delete',
      `${rgLive} upsert`,
    ].sort());
  });

  it('compacts superseded rows with Music Connections off', async () => {
    expect(await mcEnabled(client)).toBe(false);
    await row(`${tag}:again`, 'upsert', '5 days');
    await row(`${tag}:again`, 'delete', '4 days');
    await row(`${tag}:again`, 'upsert', '3 days');
    const result = await mcPurgeJob(ctx);
    expect(result.superseded).toBeGreaterThanOrEqual(2);
    expect((await left()).filter((r: string) => r.startsWith('again '))).toEqual(['again upsert']);
  });

  it('a second run changes nothing', async () => {
    const before = await left();
    expect(await mcPurgeJob(ctx)).toMatchObject({ relogged: 0 });
    expect(await left()).toEqual(before);
  });

  describe('the provider’s OAuth records', () => {
    const cid = (n: string) => `mcc_purge_${tag}_${n}`;
    const client_ = (n: string, age: string) =>
      client`insert into mc_oauth_clients (client_id, client_secret_hash, name, redirect_uri, created_at)
             values (${cid(n)}, 'h', ${`purge ${n}`}, 'http://192.168.1.5/cb', now() - ${age}::interval)`;
    /** One token of a family; times relative to now. */
    const token = (c: string, family: string, t: { access: string; refresh?: string | null; rotated?: string; revoked?: string }) =>
      client`insert into mc_oauth_tokens (family_id, client_id, user_id, scopes, access_token_hash, access_expires_at,
                                          refresh_token_hash, refresh_expires_at, rotated_at, revoked_at)
             values (${family}, ${cid(c)}, ${userId}, ${['ratings:read', 'offline_access']}, ${randomUUID()}, now() + ${t.access}::interval,
                     ${t.refresh ? randomUUID() : null}, ${t.refresh ? client`now() + ${t.refresh}::interval` : null},
                     ${t.rotated ? client`now() + ${t.rotated}::interval` : null}, ${t.revoked ? client`now() + ${t.revoked}::interval` : null})`;
    const families = async () =>
      (await client`select distinct family_id::text as f from mc_oauth_tokens where client_id like ${`mcc_purge_${tag}_%`}`).map((r: { f: string }) => r.f).sort();
    const clients = async () =>
      (await client`select client_id from mc_oauth_clients where client_id like ${`mcc_purge_${tag}_%`} order by client_id`).map((r: { client_id: string }) => r.client_id.replace(`mcc_purge_${tag}_`, ''));
    const f = { revokedLong: randomUUID(), revokedRecent: randomUUID(), live: randomUUID(), expiredLong: randomUUID(), rotatedLive: randomUUID() };
    const linkId = randomUUID();

    beforeAll(async () => {
      await client_('revoked', '90 days');
      await client_('recent', '90 days');
      await client_('live', '90 days');
      await client_('pending', '90 days');
      await client_('code', '90 days');
      await client_('young', '5 days');
      await client_('unused', '90 days');
      // revoked 40 days ago (a rotated token and its successor): the family goes, then its client
      await token('revoked', f.revokedLong, { access: '-80 days', refresh: '20 days', rotated: '-80 days', revoked: '-40 days' });
      await token('revoked', f.revokedLong, { access: '-79 days', refresh: '20 days', revoked: '-40 days' });
      // revoked 10 days ago: kept, and so is its client
      await token('recent', f.revokedRecent, { access: '-20 days', refresh: '60 days', revoked: '-10 days' });
      // one live family keeps its client; an ended one of the same client goes
      await token('live', f.live, { access: '-1 day', refresh: '29 days' });
      await token('live', f.expiredLong, { access: '-70 days', refresh: '-40 days' });
      // a rotated token long ago, its successor still usable: the family stays whole
      await token('live', f.rotatedLive, { access: '-60 days', refresh: '30 days', rotated: '-60 days' });
      await token('live', f.rotatedLive, { access: '-59 days', refresh: '31 days' });
      // an authorize request not yet decided, and a code not yet exchanged: in flight
      await client`insert into mc_oauth_requests (id, client_id, redirect_uri, scopes, code_challenge, expires_at)
                   values (${`mcq_${tag}_p`}, ${cid('pending')}, 'http://192.168.1.5/cb', ${['ratings:read']}, 'c', now() + interval '5 minutes')`;
      await client`insert into mc_oauth_requests (id, client_id, redirect_uri, scopes, code_challenge, expires_at, user_id, decided_at, code_hash, code_expires_at)
                   values (${`mcq_${tag}_c`}, ${cid('code')}, 'http://192.168.1.5/cb', ${['ratings:read']}, 'c', now() - interval '1 minute',
                           ${userId}, now() - interval '2 minutes', ${randomUUID()}, now() + interval '3 minutes')`;
      // an expired request does not keep its client
      await client`insert into mc_oauth_requests (id, client_id, redirect_uri, scopes, code_challenge, expires_at)
                   values (${`mcq_${tag}_u`}, ${cid('unused')}, 'http://192.168.1.5/cb', ${['ratings:read']}, 'c', now() - interval '40 days')`;
      // the client side's own link (to a remote whose client id happens to match): never touched
      await client`insert into mc_links (id, user_id, remote_url, manifest, client_id, sealed_tokens, state)
                   values (${linkId}, ${userId}, 'http://192.168.1.9:8080', '{}'::jsonb, ${cid('revoked')}, 'enc:x', 'revoked')`;
    });

    afterAll(async () => {
      await client`delete from mc_links where id = ${linkId}`;
      await client`delete from mc_oauth_clients where client_id like ${`mcc_purge_${tag}_%`}`;
    });

    it('drops families ended over 30 days ago and unused clients; keeps live, recent and in-flight ones; never a link', async () => {
      // one family, then one client, per delete statement: every batch runs
      const result = await mcPurgeJob(ctx, { batchSize: 1 });
      expect(result.families).toBeGreaterThanOrEqual(2);
      expect(result.tokens).toBeGreaterThanOrEqual(3);
      expect(result.clients).toBeGreaterThanOrEqual(2);
      expect(await families()).toEqual([f.revokedRecent, f.live, f.rotatedLive].sort());
      expect(await clients()).toEqual(['code', 'live', 'pending', 'recent', 'young']);
      expect((await client`select 1 from mc_oauth_requests where id = ${`mcq_${tag}_u`}`).length).toBe(0);
      expect((await client`select sealed_tokens from mc_links where id = ${linkId}`)[0]?.sealed_tokens).toBe('enc:x');
      const [audit] = await client`select payload from audit_log where action = 'mc.oauth.prune' order by at desc limit 1`;
      expect(audit.payload).toMatchObject({ families: result.families, tokens: result.tokens, clients: result.clients, keep_days: 30 });
    });

    it('a second run deletes nothing and writes no audit entry', async () => {
      const before = (await client`select count(*)::int as n from audit_log where action = 'mc.oauth.prune'`)[0].n;
      expect(await pruneOAuth(ctx, 30)).toEqual({ families: 0, tokens: 0, clients: 0 });
      expect((await client`select count(*)::int as n from audit_log where action = 'mc.oauth.prune'`)[0].n).toBe(before);
      expect(await clients()).toEqual(['code', 'live', 'pending', 'recent', 'young']);
    });
  });
});
