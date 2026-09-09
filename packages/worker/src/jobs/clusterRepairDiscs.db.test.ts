/**
 * cluster.repairDiscs against a real database: the three layouts are found,
 * sibling folders of one album are enqueued once, a dry run touches nothing,
 * and the identify phase re-queues every cluster the re-clustering changed —
 * including the layout-2 albums it updates in place rather than recreating.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { audioFiles, libraries, localAlbums, scanRoots, users, makeDb } from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from '../lib/context.js';
import { clusterDirJob } from './clusterDir.js';
import { clusterRepairDiscsJob } from './clusterRepairDiscs.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('clusterRepairDiscsJob (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  const sent: Array<{ name: string; data: any; opts: any }> = [];

  const addFile = async (relPath: string, common: Record<string, unknown>) => {
    await db.insert(audioFiles).values({
      id: randomUUID(), libraryId, scanRootId: rootId, relPath,
      status: 'present', durationMs: 200_000, tagsRaw: { common },
    });
  };

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    const boss = {
      send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return randomUUID(); },
    };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };

    // The identify phase raises an already-queued identify.album in place;
    // pg-boss never runs in tests, so stand in a table with the columns it reads.
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `repair-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Repair', ownerUserId: userId, settings: {} });
    rootId = randomUUID();
    await db.insert(scanRoots).values({
      id: rootId, libraryId, path: '/tmp/liner-repair-root', displayName: 'repair',
      validationStatus: 'ok', pollIntervalS: 3600,
    });
  });

  beforeEach(async () => {
    sent.length = 0;
    await db.delete(audioFiles).where(eq(audioFiles.scanRootId, rootId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await client`delete from pgboss.job`;
  });

  afterAll(async () => {
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client`drop table if exists pgboss.job`;
    await client.end({ timeout: 5 });
  });

  const ost = 'G/God of War/OST';
  const seedLayouts = async () => {
    // Layout 1: a disc token on two sibling folders of the same album.
    for (const disc of [1, 2]) {
      for (let i = 1; i <= 2; i += 1) {
        await addFile(`A/Artist/Album CD${disc}/${String(i).padStart(2, '0')} - s.flac`, {
          album: 'Album', albumartist: 'Artist', track: { no: i },
        });
      }
    }
    // Layout 2: no folder or filename marker at all, disk.no 3 in the tags.
    for (let i = 1; i <= 3; i += 1) {
      await addFile(`${ost}/${String(i).padStart(2, '0')}.mp3`, {
        album: 'God of War III', albumartist: 'Various', track: { no: i }, disk: { no: 3 },
      });
    }
    // Layout 3: "n-tt" prefixes inside one folder — a real two-disc shape,
    // each disc numbered from track 1.
    for (const [disc, track] of [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3]] as const) {
      await addFile(`S/Set/Box/${disc}-0${track} - t.flac`, { album: 'Box', albumartist: 'Set' });
    }
    // Not a candidate: a plain single-disc album.
    for (let i = 1; i <= 3; i += 1) {
      await addFile(`P/Plain/Record/${String(i).padStart(2, '0')} - p.flac`, {
        album: 'Record', albumartist: 'Plain', track: { no: i },
      });
    }
    // Not a candidate: "n-nn" filenames that only repeat the track number.
    await addFile("A/Angels & Airwaves/2006 - We Don't Need To Whisper/01 - a.mp3", { album: 'Whisper', albumartist: 'AVA' });
    for (const n of [2, 3, 4]) {
      await addFile(`A/Angels & Airwaves/2006 - We Don't Need To Whisper/${n}-0${n} - a.mp3`, { album: 'Whisper', albumartist: 'AVA' });
    }
    // Layout 2 is defined against an existing single-folder cluster.
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: ost });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'P/Plain/Record' });
  };

  it('enqueues one cluster.dir per scope and hands off to the identify phase', async () => {
    await seedLayouts();
    sent.length = 0;

    const result = await clusterRepairDiscsJob(ctx, { libraryId });

    const clusters = sent.filter((s) => s.name === 'cluster.dir');
    const dirs = clusters.map((s) => s.data.dirPath).sort();
    // The two "Album CDn" siblings share a scope and are enqueued once.
    expect(dirs).toHaveLength(3);
    expect(dirs.filter((d: string) => d.startsWith('A/Artist/Album CD'))).toHaveLength(1);
    expect(dirs).toContain(ost);
    expect(dirs).toContain('S/Set/Box');
    expect(dirs).not.toContain('P/Plain/Record');
    expect(dirs.some((d: string) => d.includes('Angels'))).toBe(false);
    // The singleton key is the resolved scope, so a job for the other sibling
    // collapses onto this one instead of racing it into a duplicate album.
    const sibling = clusters.find((s) => String(s.data.dirPath).startsWith('A/Artist/Album CD'))!;
    expect(sibling.opts.singletonKey).toBe(`cluster:${rootId}:A/Artist\nalbum`);
    expect(clusters[0]!.data).toMatchObject({ libraryId, scanRootId: rootId });
    expect(result).toMatchObject({
      phase: 'scan', dryRun: false, scopes: 3, enqueued: 3,
      counts: { 'folder-token': 1, 'disc-subdir': 0, 'tag-disc': 1, 'filename-prefix': 1 },
    });

    const followUp = sent.filter((s) => s.name === 'cluster.repairDiscs');
    expect(followUp).toHaveLength(1);
    expect(followUp[0]!.data.phase).toBe('identify');
    expect(typeof followUp[0]!.data.since).toBe('string');
    expect([...followUp[0]!.data.dirPaths].sort()).toEqual(dirs);
  });

  it('dryRun reports the per-layout counts and enqueues nothing', async () => {
    await seedLayouts();
    sent.length = 0;
    const before = (await client`select count(*)::int n from local_albums where library_id = ${libraryId}`)[0].n;

    const result = await clusterRepairDiscsJob(ctx, { libraryId, dryRun: true });

    expect(sent).toHaveLength(0);
    expect(result).toEqual({
      phase: 'scan',
      dryRun: true,
      scopes: 3,
      counts: { 'folder-token': 1, 'disc-subdir': 0, 'tag-disc': 1, 'filename-prefix': 1 },
      enqueued: 0,
    });
    const after = (await client`select count(*)::int n from local_albums where library_id = ${libraryId}`)[0].n;
    expect(after).toBe(before);
  });

  it('takes `since` from the database clock, not the worker', async () => {
    await seedLayouts();
    sent.length = 0;
    await clusterRepairDiscsJob(ctx, { libraryId });
    const since = sent.find((s) => s.name === 'cluster.repairDiscs')!.data.since as string;
    const [row] = await client`select ${since}::timestamptz <= now() as past, ${since}::timestamptz > now() - interval '1 minute' as recent`;
    expect(row.past).toBe(true);
    expect(row.recent).toBe(true);
  });

  it('identify phase re-queues an in-place layout-2 album', async () => {
    await seedLayouts();
    // The state the disc bug left behind: matched against a one-disc release.
    const [before] = await client`select id, cluster_key, updated_at from local_albums
                                  where library_id = ${libraryId} and dir_paths @> ARRAY[${ost}]::text[]`;
    await client`update local_albums set state = 'matched' where id = ${before.id}`;
    sent.length = 0;

    await clusterRepairDiscsJob(ctx, { libraryId });
    const scan = sent.find((s) => s.name === 'cluster.repairDiscs')!.data;
    // Run the cluster.dir jobs the scan phase queued.
    for (const s of sent.filter((x) => x.name === 'cluster.dir')) await clusterDirJob(ctx, s.data);
    sent.length = 0;

    // Same row, updated in place: no new cluster_key, so created_at never moved.
    const [after] = await client`select id, cluster_key, created_at, updated_at from local_albums where id = ${before.id}`;
    expect(after.cluster_key).toBe(before.cluster_key);
    expect(new Date(after.created_at).getTime()).toBeLessThan(new Date(scan.since).getTime());

    await clusterRepairDiscsJob(ctx, { ...scan });

    const ids = sent.filter((s) => s.name === 'identify.album').map((s) => s.data.localAlbumId);
    expect(ids).toContain(before.id);
    expect(sent.find((s) => s.data.localAlbumId === before.id)!.opts)
      .toMatchObject({ singletonKey: `identify:${before.id}`, priority: 50 });
    expect(sent.find((s) => s.data.localAlbumId === before.id)!.data.force).toBe(true);
  });

  it('identify phase ignores albums outside the repaired scopes', async () => {
    const [outside] = await db.insert(localAlbums).values({
      libraryId, clusterKey: `outside-${randomUUID()}`, dirPaths: ['Q/Elsewhere'], state: 'pending',
    }).returning({ id: localAlbums.id });
    const [inside] = await db.insert(localAlbums).values({
      libraryId, clusterKey: `inside-${randomUUID()}`, dirPaths: ['X/Y'], state: 'pending',
    }).returning({ id: localAlbums.id });
    const since = new Date(Date.now() - 60_000).toISOString();

    const result = await clusterRepairDiscsJob(ctx, { libraryId, phase: 'identify', since, dirPaths: ['X/Y'] });

    const ids = sent.filter((s) => s.name === 'identify.album').map((s) => s.data.localAlbumId);
    expect(ids).toEqual([inside.id]);
    expect(ids).not.toContain(outside.id);
    expect(result).toMatchObject({ phase: 'identify', albums: 1, sent: 1, raised: 0 });
  });

  it('identify phase raises a waiting job instead of sending a duplicate', async () => {
    const [fresh] = await db.insert(localAlbums).values({
      libraryId, clusterKey: `fresh-${randomUUID()}`, dirPaths: ['X/Y'], state: 'pending',
    }).returning({ id: localAlbums.id });
    const [queued] = await db.insert(localAlbums).values({
      libraryId, clusterKey: `queued-${randomUUID()}`, dirPaths: ['X/Z'], state: 'pending',
    }).returning({ id: localAlbums.id });
    const [retrying] = await db.insert(localAlbums).values({
      libraryId, clusterKey: `retry-${randomUUID()}`, dirPaths: ['X/W'], state: 'unidentified',
    }).returning({ id: localAlbums.id });
    for (const [id, state] of [[queued.id, 'created'], [retrying.id, 'retry']] as const) {
      await client`insert into pgboss.job (id, name, state, priority, singleton_key, data)
                   values (${randomUUID()}, 'identify.album', ${state}, 0, ${'identify:' + id}, '{}'::jsonb)`;
    }
    const since = new Date(Date.now() - 60_000).toISOString();

    await clusterRepairDiscsJob(ctx, {
      libraryId, phase: 'identify', since, dirPaths: ['X/Y', 'X/Z', 'X/W'],
    });

    const ids = sent.filter((s) => s.name === 'identify.album').map((s) => s.data.localAlbumId);
    expect(ids).toEqual([fresh.id]);
    // Both the waiting job and the retrying one were raised in place. 'retry'
    // used to be missed, so a second job was sent and pg-boss dropped it.
    const rows = (await client`select singleton_key, priority from pgboss.job order by singleton_key`) as Array<{ singleton_key: string; priority: number }>;
    expect(rows.every((r) => r.priority === 50)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('never enqueues the scan root itself', async () => {
    // Files loose at the top of a root have relDirname '', which cluster.dir
    // reads as "the whole root is one scope". Layout 2 used to hand it over.
    for (let i = 1; i <= 3; i += 1) {
      await addFile(`0${i} - top.flac`, { album: 'Top', albumartist: 'Someone', track: { no: i }, disk: { no: 2 } });
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: '' });
    const [album] = await client`select disc_count, dir_paths from local_albums where library_id = ${libraryId}`;
    expect(album.disc_count).toBe(1);
    expect(album.dir_paths).toEqual(['']);
    sent.length = 0;

    const result = await clusterRepairDiscsJob(ctx, { libraryId });

    expect(sent.filter((s) => s.name === 'cluster.dir')).toHaveLength(0);
    expect(result.scopes).toBe(0);
  });
});
