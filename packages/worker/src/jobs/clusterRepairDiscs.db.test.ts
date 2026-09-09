/**
 * cluster.repairDiscs against a real database: the three layouts are found,
 * sibling folders of one album are enqueued once, and the identify phase
 * re-queues the clusters the re-clustering created.
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
      await addFile(`G/God of War/OST/${String(i).padStart(2, '0')}.mp3`, {
        album: 'God of War III', albumartist: 'Various', track: { no: i }, disk: { no: 3 },
      });
    }
    // Layout 3: "n-tt" prefixes inside one folder.
    for (const [disc, track] of [[1, 1], [2, 1], [2, 2]] as const) {
      await addFile(`S/Set/Box/${disc}-0${track} - t.flac`, { album: 'Box', albumartist: 'Set' });
    }
    // Not a candidate: a plain single-disc album.
    for (let i = 1; i <= 3; i += 1) {
      await addFile(`P/Plain/Record/${String(i).padStart(2, '0')} - p.flac`, {
        album: 'Record', albumartist: 'Plain', track: { no: i },
      });
    }
    // Layout 2 is defined against an existing single-folder cluster.
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'G/God of War/OST' });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'P/Plain/Record' });
  };

  it('enqueues one cluster.dir per scope and hands off to the identify phase', async () => {
    await seedLayouts();
    sent.length = 0;

    await clusterRepairDiscsJob(ctx, { libraryId });

    const clusters = sent.filter((s) => s.name === 'cluster.dir');
    const dirs = clusters.map((s) => s.data.dirPath).sort();
    // The two "Album CDn" siblings share a scope and are enqueued once.
    expect(dirs).toHaveLength(3);
    expect(dirs.filter((d: string) => d.startsWith('A/Artist/Album CD'))).toHaveLength(1);
    expect(dirs).toContain('G/God of War/OST');
    expect(dirs).toContain('S/Set/Box');
    expect(dirs).not.toContain('P/Plain/Record');
    expect(clusters[0]!.opts.singletonKey).toBe(`cluster:${rootId}:${clusters[0]!.data.dirPath}`);
    expect(clusters[0]!.data).toMatchObject({ libraryId, scanRootId: rootId });

    const followUp = sent.filter((s) => s.name === 'cluster.repairDiscs');
    expect(followUp).toHaveLength(1);
    expect(followUp[0]!.data.phase).toBe('identify');
    expect(typeof followUp[0]!.data.since).toBe('string');
  });

  it('dryRun reports without enqueueing', async () => {
    await seedLayouts();
    sent.length = 0;
    await clusterRepairDiscsJob(ctx, { libraryId, dryRun: true });
    expect(sent).toHaveLength(0);
  });

  it('identify phase re-queues clusters created since the scan started', async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const [fresh] = await db.insert(localAlbums).values({
      libraryId, clusterKey: `fresh-${randomUUID()}`, dirPaths: ['X/Y'], state: 'pending',
    }).returning({ id: localAlbums.id });
    const [queued] = await db.insert(localAlbums).values({
      libraryId, clusterKey: `queued-${randomUUID()}`, dirPaths: ['X/Z'], state: 'pending',
    }).returning({ id: localAlbums.id });
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data)
                 values (${randomUUID()}, 'identify.album', 'created', 0, ${'identify:' + queued.id}, '{}'::jsonb)`;

    await clusterRepairDiscsJob(ctx, { libraryId, phase: 'identify', since });

    const ids = sent.filter((s) => s.name === 'identify.album').map((s) => s.data.localAlbumId);
    expect(ids).toEqual([fresh.id]);
    expect(sent[0]!.opts).toMatchObject({ singletonKey: `identify:${fresh.id}`, priority: 50 });
    // The one already waiting was raised in place instead of re-sent.
    const [row] = (await client`select priority from pgboss.job where singleton_key = ${'identify:' + queued.id}`) as unknown as Array<{ priority: number }>;
    expect(row!.priority).toBe(50);
  });
});
