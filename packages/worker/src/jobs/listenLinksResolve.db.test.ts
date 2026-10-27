/**
 * listenLinks.resolve against the test database, with a fake resolver (no
 * network): the switch and the picked platforms gate it, what it finds is
 * stored per album and artist with its source, a recent lookup is not done
 * again, a newly picked platform and an incomplete lookup are, and the
 * nightly sweep takes open missing-album gaps.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { listenLinksEnabled, makeDb, setListenLinksEnabled, setListenPrefs } from '@tagave/db';
import type { ListenLinkResolver, ResolveResult } from '@tagave/core/listen-links';
import type { ListenPlatform } from '@tagave/shared';
import { listenLinksResolveJob } from './listenLinksResolve.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('listenLinks.resolve (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let was = false;
  const tag = randomUUID().slice(0, 8);
  const user = randomUUID();
  const libraryId = randomUUID();
  const artistId = randomUUID();
  const artistMbid = randomUUID();
  const rgMissing = randomUUID();
  const rgMissingMbid = randomUUID();
  const rgOther = randomUUID();
  const rgNoMbid = randomUUID();
  const calls: Array<{ kind: 'album' | 'artist'; mbid: string; platforms: string[] }> = [];
  let albumAnswer: ResolveResult = { links: [], incomplete: false };

  const fake = (() => ({
    album: async (rg: { mbid: string }, platforms: readonly ListenPlatform[]) => {
      calls.push({ kind: 'album', mbid: rg.mbid, platforms: [...platforms] });
      return albumAnswer;
    },
    artist: async (mbid: string, platforms: readonly ListenPlatform[]) => {
      calls.push({ kind: 'artist', mbid, platforms: [...platforms] });
      return { links: [{ platform: 'qobuz', url: 'https://play.qobuz.com/artist/1', source: 'mb-artist' }], incomplete: false };
    },
  }) as unknown as ListenLinkResolver);
  const run = (data: Parameters<typeof listenLinksResolveJob>[1]) => listenLinksResolveJob(ctx, data, fake);

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql, boss: {} as any, logger: pino({ level: 'silent' }) };
    was = await listenLinksEnabled(sql);
    await sql`insert into users (id, email) values (${user}, ${`listen-${tag}@example.test`})`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${user}, 'listen test', ${JSON.stringify({ contactString: 'owner@example.test' })}::jsonb)`;
    await sql`insert into artists (id, mbid, name, sort_name) values (${artistId}, ${artistMbid}, ${`Listen Artist ${tag}`}, 'Listen Artist')`;
    await sql`insert into release_groups (id, mbid, title) values (${rgMissing}, ${rgMissingMbid}, 'Missing One'), (${rgOther}, ${randomUUID()}, 'Owned One')`;
    await sql`insert into release_groups (id, discogs_master_id, title) values (${rgNoMbid}, ${Math.floor(Math.random() * 1e9)}, 'No MBID')`;
    await sql`insert into release_group_artists (release_group_id, artist_id, position) values (${rgMissing}, ${artistId}, 0), (${rgOther}, ${artistId}, 0), (${rgNoMbid}, ${artistId}, 0)`;
    await sql`insert into gaps (library_id, kind, subject_type, subject_id) values (${libraryId}, 'missing_album', 'release_group', ${rgMissing}), (${libraryId}, 'missing_album', 'release_group', ${rgNoMbid})`;
  });

  beforeEach(async () => {
    calls.length = 0;
    albumAnswer = { links: [], incomplete: false };
    await sql`delete from listen_prefs`;
    await sql`delete from listen_album_checks where release_group_id in (${rgMissing}, ${rgOther}, ${rgNoMbid})`;
    await sql`delete from listen_artist_checks where artist_id = ${artistId}`;
    await sql`delete from listen_links where release_group_id in (${rgMissing}, ${rgOther})`;
    await sql`delete from listen_artist_links where artist_id = ${artistId}`;
    await setListenLinksEnabled(sql, true);
  });

  afterAll(async () => {
    await setListenLinksEnabled(sql, was);
    await sql`delete from gaps where library_id = ${libraryId}`;
    await sql`delete from release_groups where id in (${rgMissing}, ${rgOther}, ${rgNoMbid})`;
    await sql`delete from artists where id = ${artistId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${user}`;
    await sql.end({ timeout: 2 });
  });

  it('skips while the module is off, and while nobody picked a platform', async () => {
    await setListenLinksEnabled(sql, false);
    await setListenPrefs(sql, user, ['qobuz']);
    expect(await run({ artistId })).toEqual({ skipped: 'listen elsewhere is off' });
    await setListenLinksEnabled(sql, true);
    await setListenPrefs(sql, user, []);
    expect(await run({ artistId })).toEqual({ skipped: 'nobody picked a platform' });
    expect(calls).toEqual([]);
  });

  it('looks up the artist and the albums it is missing, for the picked platforms, and stores them with their source', async () => {
    await setListenPrefs(sql, user, ['spotify', 'qobuz']);
    albumAnswer = { links: [{ platform: 'spotify', url: 'https://open.spotify.com/album/abc', source: 'mb-release' }], incomplete: false };
    expect(await run({ artistId })).toEqual({ albums: 1, artists: 1, links: 2 });
    // the album without an MBID and the owned one are not looked up
    expect(calls).toEqual([
      { kind: 'artist', mbid: artistMbid, platforms: ['qobuz', 'spotify'] },
      { kind: 'album', mbid: rgMissingMbid, platforms: ['qobuz', 'spotify'] },
    ]);
    expect(await sql`select platform, url, source from listen_links where release_group_id = ${rgMissing}`).toEqual([
      { platform: 'spotify', url: 'https://open.spotify.com/album/abc', source: 'mb-release' },
    ]);
    expect(await sql`select platform, source from listen_artist_links where artist_id = ${artistId}`).toEqual([{ platform: 'qobuz', source: 'mb-artist' }]);
    const [check] = await sql`select platforms, found from listen_album_checks where release_group_id = ${rgMissing}`;
    expect(check).toEqual({ platforms: ['qobuz', 'spotify'], found: 1 });

    // fresh: nothing is asked again
    calls.length = 0;
    expect(await run({ artistId })).toEqual({ albums: 0, artists: 0, links: 0 });
    expect(calls).toEqual([]);

    // a platform someone picks later is looked up at once
    await setListenPrefs(sql, user, ['spotify', 'qobuz', 'tidal']);
    expect((await run({ artistId }) as { albums: number }).albums).toBe(1);
    expect(calls.map((c) => c.platforms)).toEqual([['qobuz', 'spotify', 'tidal'], ['qobuz', 'spotify', 'tidal']]);
    // a link no longer found goes
    expect(await sql`select platform from listen_links where release_group_id = ${rgMissing}`).toEqual([{ platform: 'spotify' }]);
    albumAnswer = { links: [], incomplete: false };
    expect((await run({ releaseGroupId: rgMissing, force: true }) as { albums: number }).albums).toBe(1);
    expect(await sql`select platform from listen_links where release_group_id = ${rgMissing}`).toEqual([]);
  });

  it('asks again soon after an incomplete lookup', async () => {
    await setListenPrefs(sql, user, ['apple']);
    albumAnswer = { links: [], incomplete: true };
    await run({ releaseGroupId: rgMissing });
    expect(await sql`select platforms from listen_album_checks where release_group_id = ${rgMissing}`).toEqual([{ platforms: [] }]);
    calls.length = 0;
    await run({ releaseGroupId: rgMissing });
    expect(calls.filter((c) => c.kind === 'album')).toHaveLength(1);
  });

  it('sweeps open missing-album gaps that were not looked up, and their artists', async () => {
    await setListenPrefs(sql, user, ['qobuz']);
    const out = await run({ sweep: true });
    expect(calls.some((c) => c.kind === 'album' && c.mbid === rgMissingMbid)).toBe(true);
    expect(calls.some((c) => c.kind === 'artist' && c.mbid === artistMbid)).toBe(true);
    expect((out as { albums: number }).albums).toBeGreaterThanOrEqual(1);
  });

  it('a core row going takes its links with it (ON DELETE CASCADE)', async () => {
    const rg = randomUUID();
    await sql`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'Gone')`;
    await sql`insert into listen_links (release_group_id, platform, url, source) values (${rg}, 'qobuz', 'https://play.qobuz.com/album/1', 'mb-release')`;
    await sql`insert into listen_album_checks (release_group_id) values (${rg})`;
    await sql`delete from release_groups where id = ${rg}`;
    expect(await sql`select 1 from listen_links where release_group_id = ${rg}`).toEqual([]);
    expect(await sql`select 1 from listen_album_checks where release_group_id = ${rg}`).toEqual([]);
  });
});
