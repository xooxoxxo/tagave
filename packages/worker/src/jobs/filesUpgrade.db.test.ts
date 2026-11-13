import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { sealSecret } from '@tagave/core';
import { ledgerEntries } from '@tagave/core/facets';
import { makeDb, lidarrEnabled, moduleSettings, restartMaintenanceTask, saveMaintenanceTask, setLidarrEnabled, setModuleSettings, syncInstalledModules, type MaintenanceRow } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { fileDigest, fileStat } from '../lib/fileRecovery.js';
import { clusterKey, normKey } from '../lib/helpers.js';
import type { UpgradeSwap } from './flacUpgradeFiles.js';
import { ensureTrashDir } from '../lib/deletions.js';
import { filesUpgradeJob } from './filesUpgrade.js';
import { scanDirJob, type ScanDirJobData } from './scanDir.js';
import { scanParseJob } from './scanParse.js';
import { clusterDirJob } from './clusterDir.js';

const python = process.env.TAGAVE_TAGWRITER_PYTHON;
const enabled = !!process.env.TEST_DATABASE_URL && !!python;
const secret = 'test-upgrade-secret-for-fixture';
const artistName = 'Fixture Artist';
const albumTitle = 'Fixture Album';
const albumDir = 'Artist/Album';
const titles = ['Opening', 'Closing'];

describe.skipIf(!enabled)('Upgrade to FLAC with real audio and isolated Lidarr responses', () => {
  let ctx: WorkerContext;
  let root: string;
  let wasOn = false;
  let settings: Record<string, unknown> = {};
  const libraryId = randomUUID();
  const userId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const artistId = randomUUID();
  const artistMbid = randomUUID();
  const releaseId = randomUUID();
  const releaseMbid = randomUUID();
  const groupId = randomUUID();
  const groupMbid = randomUUID();
  const ids: string[] = [];
  const sent: { name: string; data: unknown }[] = [];
  const requests: string[] = [];
  let artistPath = '/music/Library/Artist';
  let importing = true;
  let imported: Array<{ id: number; path: string; dateAdded: string }> = [];
  const media = (ext: string, index: number) => `${albumDir}/0${index + 1}.${ext}`;
  const staged = (index: number) => `Pool/Artist/Album/0${index + 1}.flac`;
  const abs = (rel: string) => path.join(root, rel);
  const task = async () => (await ctx.sql<MaintenanceRow[]>`select * from maintenance_tasks where library_id = ${libraryId}`)[0]!;
  const ask = async () => {
    const current = await task();
    await filesUpgradeJob(ctx, {
      albumId, releaseId, fileIds: ids, userId,
      maintenance: { taskId: current.id, attemptId: current.attempt_id },
    });
    return task();
  };
  const restart = async (restoreOriginal = false) => {
    const current = await task();
    expect(await restartMaintenanceTask(ctx.sql, libraryId, current.id, current.attempt, restoreOriginal)).toBeTruthy();
  };
  const mediaFile = (file: string, index: number, format: 'flac' | 'mp3', edition: string = releaseMbid) => {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${400 + index * 100}:d=${index + 3}`,
      '-c:a', format === 'flac' ? 'flac' : 'libmp3lame', '-metadata', `title=${titles[index]}`,
      '-metadata', `album=${albumTitle}`, '-metadata', `artist=${artistName}`, '-metadata', `albumartist=${artistName}`,
      '-metadata', `track=${index + 1}`, '-metadata', 'disc=1', '-metadata', `MUSICBRAINZ_ALBUMID=${edition}`, abs(file)]);
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    ctx = {
      ...made, sql: made.client,
      logger: pino({ level: 'silent' }),
      boss: { send: async (name: string, data: unknown) => { sent.push({ name, data }); return 'job'; } } as WorkerContext['boss'],
    };
    root = await mkdtemp(path.join(tmpdir(), 'tagave-upgrade-'));
    await mkdir(abs(albumDir), { recursive: true });
    await mkdir(abs('Pool/Artist/Album'), { recursive: true });
    const decoder = abs('flac-check');
    await writeFile(decoder, '#!/bin/sh\nfor audio in "$@"; do :; done\nexec ffmpeg -v error -xerror -i "$audio" -f null -\n', { mode: 0o700 });
    vi.stubEnv('APP_SECRET', secret);
    vi.stubEnv('TAGAVE_FLAC_BIN', decoder);
    const sql = ctx.sql;
    await syncInstalledModules(sql, ledgerEntries());
    wasOn = await lidarrEnabled(sql);
    settings = await moduleSettings(sql, 'lidarr');
    await setLidarrEnabled(sql, true);
    await setModuleSettings(sql, 'lidarr', {
      url: 'http://upgrade-fixture.test', apiKey: sealSecret('fixture-key', secret),
      rootFolderPath: '/music/Pool', qualityProfileId: 1, metadataProfileId: 1,
      useDropPool: true, pathMap: { scanRootId: rootId, lidarrPath: '/music' },
    });
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== 'upgrade-fixture.test') throw new Error('Unexpected network request');
      const endpoint = url.pathname.split('/api/v1')[1]!;
      requests.push(`${init.method} ${endpoint}`);
      if (endpoint === '/artist') return Response.json([{ id: 21, foreignArtistId: artistMbid, path: artistPath, qualityProfileId: 1 }]);
      if (endpoint === '/album') return Response.json([{ id: 31, foreignAlbumId: groupMbid, artistId: 21, monitored: true }]);
      if (endpoint === '/rootfolder') return Response.json([{ id: 1, path: '/music/Pool', accessible: true, freeSpace: 100000 }]);
      if (endpoint === '/qualityprofile/1') return Response.json({ id: 1, name: 'Lossless', items: [{ allowed: true, quality: { name: 'FLAC' } }] });
      if (endpoint === '/trackfile') return Response.json(imported);
      if (endpoint === '/command') return Response.json({ id: 42, name: 'AlbumSearch' });
      if (endpoint === '/queue') return Response.json({
        totalRecords: importing && requests.includes('POST /command') ? 1 : 0,
        records: importing && requests.includes('POST /command') ? [{ id: 90, albumId: 31, size: 100, sizeleft: 25 }] : [],
      });
      throw new Error(`Unexpected fixture request ${endpoint}`);
    });
    await sql`insert into users (id, email) values (${userId}, ${`upgrade-${userId}@example.test`})`;
    await sql`insert into libraries (id, name, owner_user_id, settings)
      values (${libraryId}, 'Upgrade fixture', ${userId}, ${JSON.stringify({ dropPool: { enabled: true, scanRootId: rootId, dirPath: 'Pool' } })}::text::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, writable, probe_writable, validation_status)
      values (${rootId}, ${libraryId}, ${root}, 'Music', true, true, 'ok')`;
    await sql`insert into artists (id, mbid, name) values (${artistId}, ${artistMbid}, ${artistName})`;
    await sql`insert into release_groups (id, mbid, title, artist_credit)
      values (${groupId}, ${groupMbid}, ${albumTitle}, ${JSON.stringify([{ name: artistName, mbid: artistMbid }])}::text::jsonb)`;
    await sql`insert into release_group_artists (release_group_id, artist_id, position) values (${groupId}, ${artistId}, 1)`;
    await sql`insert into releases (id, mbid, title, release_group_id, track_count) values (${releaseId}, ${releaseMbid}, ${albumTitle}, ${groupId}, 2)`;
    const cluster = clusterKey(libraryId, [albumDir], normKey(albumTitle), normKey(artistName));
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, release_id, release_group_id, track_count, dir_paths)
      values (${albumId}, ${libraryId}, ${cluster}, ${albumTitle}, ${artistName}, 'matched', ${releaseId}, ${groupId}, 2, ${[albumDir]})`;
    for (const [index, title] of titles.entries()) {
      const track = randomUUID();
      const file = randomUUID();
      ids.push(file);
      const rel = media('mp3', index);
      mediaFile(rel, index, 'mp3');
      await sql`insert into canonical_tracks (id, release_id, medium_no, position, title, length_ms)
        values (${track}, ${releaseId}, 1, ${index + 1}, ${title}, ${(index + 3) * 1000})`;
      await sql`insert into files (id, library_id, scan_root_id, rel_path, status, handler, container, codec)
        values (${file}, ${libraryId}, ${rootId}, ${rel}, 'present', 'audio', 'MPEG', 'MPEG 1 Layer 3')`;
      await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin, canonical_track_id)
        values (${albumId}, ${file}, ${index + 1}, ${title}, 'file', ${track})`;
    }
    await saveMaintenanceTask(sql, {
      libraryId, kind: 'flac-upgrade', scope: albumId, subjectId: albumId, queue: 'files.upgrade',
      input: { albumId, releaseId, fileIds: ids, userId }, stage: 'FLAC upgrade queued',
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (ctx) {
      await ctx.sql`delete from libraries where id = ${libraryId}`;
      await ctx.sql`delete from releases where id = ${releaseId}`;
      await ctx.sql`delete from release_groups where id = ${groupId}`;
      await ctx.sql`delete from artists where id = ${artistId}`;
      await ctx.sql`delete from users where id = ${userId}`;
      await setLidarrEnabled(ctx.sql, wasOn);
      await setModuleSettings(ctx.sql, 'lidarr', { url: null, apiKey: null, rootFolderPath: null, pathMap: null, useDropPool: null, ...settings });
      await ctx.sql.end({ timeout: 3 });
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('refuses an artist outside the pool and reconnects without issuing a second search', async () => {
    expect(await ask()).toMatchObject({ state: 'failed', error: expect.stringContaining('outside') });
    expect(requests).not.toContain('POST /command');
    artistPath = '/music/Pool/Artist';
    await restart();
    const downloading = await ask();
    expect(downloading).toMatchObject({ state: 'waiting', progress: { done: 75, total: 100 }, checkpoint: { albumId: 31, commandId: 42 } });
    expect(await ask()).toMatchObject({ state: 'waiting', attempt: downloading.attempt });
    expect(requests.filter((request) => request === 'POST /command')).toHaveLength(1);
  });

  it('keeps originals in place through a partial import, wrong edition, and failed tag write', async () => {
    importing = false;
    mediaFile(staged(0), 0, 'flac');
    const [first, second] = titles.map((_, index) => ({ id: 100 + index, path: `/music/${staged(index)}`, dateAdded: '2026-11-08T12:00:00Z' }));
    imported = [first!];
    const current = await task();
    await ctx.sql`update maintenance_tasks set checkpoint = jsonb_set(checkpoint, '{requestedAt}', to_jsonb(${Date.now() - 180_000}::bigint)) where id = ${current.id}`;
    expect(await ask()).toMatchObject({ state: 'review', error: expect.stringContaining('incomplete') });
    expect(await fileStat(abs(media('mp3', 0)))).toBeTruthy();

    imported = [first!, second!];
    mediaFile(staged(1), 1, 'flac', randomUUID());
    await restart();
    expect(await ask()).toMatchObject({ state: 'review', error: expect.stringContaining('different MusicBrainz edition') });

    mediaFile(staged(1), 1, 'flac');
    await restart();
    vi.stubEnv('TAGAVE_TAGWRITER_PYTHON', '/usr/bin/false');
    try {
      expect(await ask()).toMatchObject({ state: 'review' });
    } finally {
      vi.stubEnv('TAGAVE_TAGWRITER_PYTHON', python!);
    }
    expect(await fileStat(abs(media('mp3', 1)))).toBeTruthy();
    expect(await fileStat(abs(media('flac', 1)))).toBeNull();
  });

  it('recovers the published replacement, confirms the real catalog, and retains both originals', async () => {
    const acquisition = (await task()).checkpoint;
    const digests = await Promise.all(titles.map((_, i) => fileDigest(abs(media('mp3', i)))));
    await restart();
    const published = await ask();
    expect(published).toMatchObject({ state: 'waiting', checkpoint: { swap: { phase: 'catalog' } } });
    expect(await fileStat(abs(media('mp3', 0)))).toBeNull();
    expect(await fileStat(abs(media('flac', 0)))).toBeTruthy();

    const { swap } = published.checkpoint as unknown as { swap: UpgradeSwap };
    // Recreate an interruption after publishing just one of the verified tracks.
    for (const file of swap.files) await link(file.holding, file.source);
    await rm(swap.files[1]!.final);
    await ctx.sql`delete from file_deletions where library_id = ${libraryId} and state = 'holding'`;
    await ctx.sql`update maintenance_tasks set checkpoint = jsonb_set(checkpoint, '{swap,phase}', '"publish"'::jsonb)
      where id = ${published.id}`;
    expect(await ask()).toMatchObject({ state: 'waiting', checkpoint: { swap: { phase: 'catalog' } } });
    expect(await fileStat(abs(media('flac', 1)))).toBeTruthy();

    // Simulate a crash before the publish checkpoint advanced.
    await ctx.sql`update maintenance_tasks set checkpoint = jsonb_set(checkpoint, '{swap,phase}', '"publish"'::jsonb)
      where id = ${published.id}`;
    expect(await ask()).toMatchObject({ state: 'waiting', checkpoint: { swap: { phase: 'catalog' } } });

    // The owner can restore from the same interrupted swap.
    await ctx.sql`update maintenance_tasks set state = 'interrupted' where id = ${published.id}`;
    await restart(true);
    expect(await ask()).toMatchObject({ state: 'cancelled', stage: 'Original album restored' });
    expect(await Promise.all(titles.map((_, i) => fileDigest(abs(media('mp3', i)))))).toEqual(digests);
    expect(await fileStat(abs(media('flac', 0)))).toBeNull();

    // Replay the acquisition fixture to verify the other recovery path.
    await ctx.sql`update maintenance_tasks set state = 'interrupted', checkpoint = ${JSON.stringify(acquisition)}::text::jsonb
      where id = ${published.id}`;
    await restart();
    expect(await ask()).toMatchObject({ state: 'waiting', checkpoint: { swap: { phase: 'catalog' } } });
    const scan = sent.filter((job) => job.name === 'scan.dir').at(-1);
    expect(scan).toBeDefined();
    await scanDirJob(ctx, scan!.data as ScanDirJobData);
    for (const job of sent.filter((item) => item.name === 'scan.parse')) {
      await scanParseJob(ctx, job.data as Parameters<typeof scanParseJob>[1]);
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: albumDir });
    const visible = await ctx.sql<{ path: string }[]>`
      select f.rel_path as path from local_tracks lt join files f on f.id = lt.audio_file_id
      where lt.local_album_id = ${albumId} and f.codec = 'FLAC' order by f.rel_path`;
    expect(visible.map((file) => file.path)).toEqual([media('flac', 0), media('flac', 1)]);
    // The first Trash link was made, but the worker stopped before recording it.
    const holding = (await task()).checkpoint as unknown as { swap: UpgradeSwap };
    holding.swap.phase = 'trash';
    holding.swap.replacementAlbumId = albumId;
    await ensureTrashDir(root);
    const first = holding.swap.files[0]!;
    await mkdir(path.dirname(abs(first.trash)), { recursive: true });
    await link(first.holding, abs(first.trash));
    await ctx.sql`update maintenance_tasks set checkpoint = ${JSON.stringify(holding)}::text::jsonb where id = ${published.id}`;
    const finished = await ask();
    expect(finished).toMatchObject({ state: 'done', progress: { done: 2, total: 2 } });
    const originals = await ctx.sql<{ trash: string }[]>`
      select trash_rel_path as trash from file_deletions where library_id = ${libraryId} and state = 'trashed' order by rel_path`;
    expect(await Promise.all(originals.map((file) => fileDigest(abs(file.trash))))).toEqual(digests);
    holding.swap.phase = 'complete';
    await ctx.sql`update maintenance_tasks set state = 'interrupted', checkpoint = ${JSON.stringify(holding)}::text::jsonb
      where id = ${published.id}`;
    await restart();
    expect(await ask()).toMatchObject({ state: 'done' });
    expect(await ctx.sql`select id from audit_log where library_id = ${libraryId} and action = 'album.flac-upgrade'`).toHaveLength(1);
    expect(await readFile(abs(media('flac', 0))).then((bytes) => bytes.subarray(0, 4).toString())).toBe('fLaC');
    expect(requests.filter((request) => request === 'POST /command')).toHaveLength(1);
  });
});
