/**
 * similarArtists.fetch against the test database, with a fake ListenBrainz
 * and a fake Last.fm (no network): the switch gates it, only the artist's
 * MBID is asked for, the list is stored best first with its sources, a
 * recent list is not fetched again, Last.fm joins only with a key, a failure
 * keeps the list from before, and the daily sweep takes week-old lists.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb, setSimilarArtistsEnabled, similarArtistsEnabled, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import { SimilarArtistsClient } from '@tagave/core/similar-artists';
import { similarArtistsFetchJob } from './similarArtistsFetch.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('similarArtists.fetch (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let was = true;
  const tag = randomUUID().slice(0, 8);
  const user = randomUUID();
  const libraryId = randomUUID();
  const artistId = randomUUID();
  const artistMbid = randomUUID();
  const other = randomUUID();
  const otherMbid = randomUUID();
  const noMbid = randomUUID();
  const sim1 = randomUUID();
  const sim2 = randomUUID();
  const calls: Array<{ url: URL; ua: string | null }> = [];
  let lbStatus = 200;
  let uaSeen: string | null = null;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, ua: new Headers(init?.headers).get('user-agent') });
    if (url.host === 'lb.test') {
      if (lbStatus !== 200) return new Response('{}', { status: lbStatus });
      return Response.json([
        { artist_mbid: sim1, name: 'First Similar', comment: 'UK band', score: 400, reference_mbid: url.searchParams.get('artist_mbids') },
        { artist_mbid: sim2, name: 'Second Similar', comment: '', score: 100, reference_mbid: url.searchParams.get('artist_mbids') },
      ]);
    }
    return Response.json({ similarartists: { artist: [{ name: 'second similar', mbid: '', match: '1' }, { name: 'Only On Lastfm', mbid: '', match: '0.5' }] } });
  }) as typeof fetch;
  const factory = (ua: string) => {
    uaSeen = ua;
    return new SimilarArtistsClient({ userAgent: ua, fetchImpl, listenbrainzUrl: 'https://lb.test/similar-artists/json', lastfmUrl: 'https://fm.test/2.0/' });
  };
  const run = (data: Parameters<typeof similarArtistsFetchJob>[1]) => similarArtistsFetchJob(ctx, data, factory, {});
  const list = async (id = artistId) => sql`select position, similar_mbid::text as mbid, name, comment, score, sources from similar_artists where artist_id = ${id} order by position`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql, boss: {} as any, logger: pino({ level: 'silent' }) };
    await syncInstalledModules(sql, ledgerEntries());
    was = await similarArtistsEnabled(sql);
    await sql`insert into users (id, email) values (${user}, ${`similar-${tag}@example.test`})`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${user}, 'similar test', ${JSON.stringify({ contactString: 'owner@example.com' })}::jsonb)`;
    await sql`insert into artists (id, mbid, name) values (${artistId}, ${artistMbid}, ${`Similar Artist ${tag}`}), (${other}, ${otherMbid}, ${`Other ${tag}`})`;
    await sql`insert into artists (id, name) values (${noMbid}, ${`No MBID ${tag}`})`;
  });

  beforeEach(async () => {
    calls.length = 0;
    lbStatus = 200;
    await sql`delete from similar_artists where artist_id in (${artistId}, ${other}, ${noMbid})`;
    await sql`delete from similar_artist_checks where artist_id in (${artistId}, ${other}, ${noMbid})`;
    await sql`update libraries set settings = settings - 'lastfmApiKey' where id = ${libraryId}`;
    await setSimilarArtistsEnabled(sql, true);
  });

  afterAll(async () => {
    await setSimilarArtistsEnabled(sql, was);
    await sql`delete from artists where id in (${artistId}, ${other}, ${noMbid})`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${user}`;
    await sql.end({ timeout: 2 });
  });

  it('is on from the start (defaultEnabled); off, it skips and asks nothing', async () => {
    expect(ledgerEntries().find((e) => e.id === 'similar-artists')).toMatchObject({ kind: 'in-process', defaultEnabled: true });
    await setSimilarArtistsEnabled(sql, false);
    expect(await run({ artistId })).toEqual({ skipped: 'similar artists is off' });
    expect(calls).toEqual([]);
  });

  it('ListenBrainz alone: asks by the MBID with the install UA, stores the list best first', async () => {
    expect(await run({ artistId })).toEqual({ artists: 1, similar: 2, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get('artist_mbids')).toBe(artistMbid);
    expect([...calls[0]!.url.searchParams.keys()].sort()).toEqual(['algorithm', 'artist_mbids']);
    expect(calls[0]!.ua).toBe(uaSeen);
    expect(uaSeen).toMatch(/^tagave\/0\.1 \(\+.+\)$/);
    expect(await list()).toEqual([
      { position: 0, mbid: sim1, name: 'First Similar', comment: 'UK band', score: 1, sources: ['listenbrainz'] },
      { position: 1, mbid: sim2, name: 'Second Similar', comment: null, score: 0.25, sources: ['listenbrainz'] },
    ]);
    const [check] = await sql`select sources, found, error from similar_artist_checks where artist_id = ${artistId}`;
    expect(check).toEqual({ sources: ['listenbrainz'], found: 2, error: null });
    // fetched lately: not again, unless forced
    calls.length = 0;
    expect(await run({ artistId })).toEqual({ artists: 0, similar: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(await run({ artistId, force: true })).toMatchObject({ artists: 1 });
  });

  it('with the install’s Last.fm key: Last.fm by the same MBID, merged by name, scores blended', async () => {
    await sql`update libraries set settings = settings || '{"lastfmApiKey":"plain-key"}'::jsonb where id = ${libraryId}`;
    await run({ artistId });
    const fm = calls.find((c) => c.url.host === 'fm.test')!;
    expect(fm.url.searchParams.get('mbid')).toBe(artistMbid);
    expect(fm.url.searchParams.get('api_key')).toBe('plain-key');
    expect(fm.url.searchParams.has('artist')).toBe(false);
    expect(await list()).toEqual([
      { position: 0, mbid: sim1, name: 'First Similar', comment: 'UK band', score: 0.6, sources: ['listenbrainz'] },
      { position: 1, mbid: sim2, name: 'Second Similar', comment: null, score: 0.55, sources: ['lastfm', 'listenbrainz'] },
      { position: 2, mbid: null, name: 'Only On Lastfm', comment: null, score: 0.2, sources: ['lastfm'] },
    ]);
    expect((await sql`select sources from similar_artist_checks where artist_id = ${artistId}`)[0].sources).toEqual(['lastfm', 'listenbrainz']);
  });

  it('a ListenBrainz failure keeps the list from before and records the error', async () => {
    await run({ artistId });
    lbStatus = 503;
    expect(await run({ artistId, force: true })).toEqual({ artists: 0, similar: 0, failed: 1 });
    expect(await list()).toHaveLength(2);
    expect((await sql`select error from similar_artist_checks where artist_id = ${artistId}`)[0].error).toMatch(/503/);
  });

  it('an artist without an MBID asks nothing', async () => {
    expect(await run({ artistId: noMbid })).toEqual({ artists: 0, similar: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it('the sweep fetches again the lists a week old, not the recent ones', async () => {
    await run({ artistId });
    await run({ artistId: other });
    await sql`update similar_artist_checks set fetched_at = now() - interval '8 days' where artist_id = ${other}`;
    calls.length = 0;
    const out = await run({ sweep: true });
    expect(out).toMatchObject({ failed: 0 });
    const asked = calls.map((c) => c.url.searchParams.get('artist_mbids'));
    expect(asked).toContain(otherMbid);
    expect(asked).not.toContain(artistMbid);
  });
});
