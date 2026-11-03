/**
 * lidarr.poll and lidarr.get against the test database and a fake Lidarr
 * on the loopback (no other network): the states follow Lidarr's queue and
 * statistics, an import is scanned where it landed, an import outside every
 * music folder is flagged, a local album of the release group closes the
 * request, and Get all missing walks an artist's missing albums.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { lidarrEnabled, makeDb, moduleSettings, setLidarrEnabled, setModuleSettings, syncInstalledModules, upsertLidarrRequest } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import { sealSecret } from '@tagave/core';
import { LIDARR_NOT_FOUND_AFTER_MS } from '@tagave/core/lidarr';
import { startFakeLidarr, type FakeLidarr } from '@tagave/core/lidarr-fake';
import { lidarrGetJob, lidarrPollJob } from './lidarr.js';
import type { WorkerContext } from '../lib/context.js';

const KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'worker-test-app-secret-0123456789';

describe.skipIf(!process.env.TEST_DATABASE_URL)('lidarr.poll and lidarr.get (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let lidarr: FakeLidarr;
  let wasOn = false;
  let wasSettings: Record<string, unknown> = {};
  let savedSecret: string | undefined;
  const sent: Array<{ name: string; data: any }> = [];
  const tag = randomUUID().slice(0, 8);
  const user = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const artistId = randomUUID();
  const artistMbid = randomUUID();
  const rg = [randomUUID(), randomUUID(), randomUUID()];
  const rgMbid = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    savedSecret = process.env['APP_SECRET'];
    process.env['APP_SECRET'] = SECRET;
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql, boss: { send: async (name: string, data: any) => { sent.push({ name, data }); return 'job'; } } as any, logger: pino({ level: 'silent' }) };
    await syncInstalledModules(sql, ledgerEntries());
    wasOn = await lidarrEnabled(sql);
    wasSettings = await moduleSettings(sql, 'lidarr');
    lidarr = await startFakeLidarr({ apiKey: KEY, rootFolders: [`/music-${tag}`] });
    await sql`insert into users (id, email) values (${user}, ${`lidarr-${tag}@example.test`})`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${user}, 'lidarr test', '{}'::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, ${`/music-${tag}`}, 'Music')`;
    await sql`insert into artists (id, mbid, name) values (${artistId}, ${artistMbid}, ${`Lidarr Band ${tag}`})`;
    for (let i = 0; i < 3; i++) {
      await sql`insert into release_groups (id, mbid, title) values (${rg[i]}, ${rgMbid[i]}, ${`Album ${i}`})`;
      await sql`insert into release_group_artists (release_group_id, artist_id, position) values (${rg[i]}, ${artistId}, 0)`;
      await sql`insert into gaps (library_id, kind, subject_type, subject_id) values (${libraryId}, 'missing_album', 'release_group', ${rg[i]})`;
      lidarr.catalog.set(rgMbid[i]!, { title: `Album ${i}`, artistMbid, artistName: 'Lidarr Band' });
    }
    await setModuleSettings(sql, 'lidarr', { url: lidarr.url, apiKey: sealSecret(KEY, SECRET), rootFolderPath: `/music-${tag}`, qualityProfileId: 1, metadataProfileId: 1 });
  });

  afterAll(async () => {
    await sql`delete from lidarr_requests where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from release_groups where id = any(${rg}::uuid[])`;
    await sql`delete from artists where id = ${artistId}`;
    await sql`delete from users where id = ${user}`;
    await setModuleSettings(sql, 'lidarr', { url: null, apiKey: null, rootFolderPath: null, qualityProfileId: null, metadataProfileId: null, version: null, ...wasSettings });
    await setLidarrEnabled(sql, wasOn);
    await lidarr.close();
    await sql.end({ timeout: 2 });
    if (savedSecret === undefined) delete process.env['APP_SECRET'];
    else process.env['APP_SECRET'] = savedSecret;
  });

  it('off: both skip and nothing is asked of Lidarr', async () => {
    await setLidarrEnabled(sql, false);
    expect(await lidarrPollJob(ctx)).toEqual({ skipped: 'off' });
    expect(await lidarrGetJob(ctx, { libraryId, artistId, userId: user })).toEqual({ skipped: 'off' });
    expect(lidarr.calls).toHaveLength(0);
    await setLidarrEnabled(sql, true);
    expect(await lidarrPollJob(ctx)).toEqual({ skipped: 'nothing open' });
    expect(lidarr.calls).toHaveLength(0);
  });

  it('Get all missing asks for each missing album once, one after another', async () => {
    const out = await lidarrGetJob(ctx, { libraryId, artistId, userId: user });
    expect(out).toEqual({ asked: 3, failed: 0, stopped: null });
    expect(lidarr.albums.map((a) => a.foreignAlbumId).sort()).toEqual([...rgMbid].sort());
    expect(lidarr.artists).toHaveLength(1);
    expect(lidarr.commands).toHaveLength(3);
    expect(await sql`select 1 from lidarr_requests where library_id = ${libraryId} and state = 'wanted'`).toHaveLength(3);
    // again: nothing new to ask for
    expect(await lidarrGetJob(ctx, { libraryId, artistId, userId: user })).toEqual({ asked: 0, failed: 0, stopped: null });
  });

  it('Downloading with progress, then Importing with a scan of its folder, then done once tagave holds it', async () => {
    const a0 = lidarr.albums.find((a) => a.foreignAlbumId === rgMbid[0])!;
    const a1 = lidarr.albums.find((a) => a.foreignAlbumId === rgMbid[1])!;
    lidarr.download(a0.id, 1000, 250);
    await lidarrPollJob(ctx);
    const state = async (i: number) => (await sql`select state, progress, outside_roots, lidarr_path from lidarr_requests where release_group_id = ${rg[i]}`)[0];
    expect(await state(0)).toMatchObject({ state: 'downloading', progress: 75 });
    expect(await state(1)).toMatchObject({ state: 'wanted', progress: null });

    lidarr.importAlbum(a0.id, [`/music-${tag}/Lidarr Band/Album 0 (2001)/01.flac`, `/music-${tag}/Lidarr Band/Album 0 (2001)/02.flac`]);
    lidarr.importAlbum(a1.id, ['/downloads/Lidarr Band/Album 1/01.flac']);
    sent.length = 0;
    await lidarrPollJob(ctx);
    expect(await state(0)).toMatchObject({ state: 'imported', outside_roots: false, lidarr_path: `/music-${tag}/Lidarr Band/Album 0 (2001)` });
    expect(sent).toEqual([{ name: 'scan.dir', data: { scanRootId: rootId, dirPath: 'Lidarr Band/Album 0 (2001)', reason: 'lidarr' } }]);
    expect(await state(1)).toMatchObject({ state: 'imported', outside_roots: true });
    // not scanned twice while it waits for tagave
    sent.length = 0;
    await lidarrPollJob(ctx);
    expect(sent).toEqual([]);

    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Album 0', 'Lidarr Band', 'matched', ${rg[0]})`;
    expect(await lidarrPollJob(ctx)).toMatchObject({ done: 1 });
    expect(await state(0)).toMatchObject({ state: 'done' });
  });

  it('a search that finds nothing for three days is Not found; Lidarr down skips the run', async () => {
    const now = Date.now() + LIDARR_NOT_FOUND_AFTER_MS + 60_000;
    await lidarrPollJob(ctx, { now });
    expect((await sql`select state from lidarr_requests where release_group_id = ${rg[2]}`)[0]).toMatchObject({ state: 'not_found' });
    lidarr.failWith = 503;
    expect(await lidarrPollJob(ctx)).toMatchObject({ skipped: 'fake failure' });
    lidarr.failWith = null;
  });

  it('a request whose album Lidarr did not have yet is looked up, monitored and searched', async () => {
    const extra = randomUUID();
    const extraMbid = randomUUID();
    await sql`insert into release_groups (id, mbid, title) values (${extra}, ${extraMbid}, 'Late')`;
    rg.push(extra);
    await upsertLidarrRequest(sql, { libraryId, releaseGroupId: extra, lidarrAlbumId: null, lidarrArtistId: null, requestedBy: user });
    lidarr.albums.push({ id: 999, foreignAlbumId: extraMbid, title: 'Late', monitored: false, artistId: lidarr.artists[0]!.id, trackCount: 8, trackFileCount: 0 });
    await lidarrPollJob(ctx);
    expect((await sql`select lidarr_album_id, state from lidarr_requests where release_group_id = ${extra}`)[0]).toMatchObject({ lidarr_album_id: 999, state: 'wanted' });
    expect(lidarr.albums.find((a) => a.id === 999)!.monitored).toBe(true);
    expect(lidarr.commands.at(-1)).toEqual({ name: 'AlbumSearch', albumIds: [999] });
    expect(lidarr.calls.every((c) => c.keyOk)).toBe(true);
  });
});
