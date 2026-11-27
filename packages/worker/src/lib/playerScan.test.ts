import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { libraries, makeDb, scanRoots, users } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { onlineAgain } from './folderWatch/watch.js';
import { afterReturn, requestPlayerRescan, rootFolderOf, scanFoldersOf, PLAYER_SCAN_QUEUE } from './playerScan.js';

describe('player scan folders', () => {
  const f = (libraryId: string, scanRootPath: string, relPath: string) => ({ libraryId, fileId: relPath, scanRootPath, relPath });

  it('names each written folder once, relative to the music root', () => {
    const out = scanFoldersOf([
      f('L', '/mnt/music', 'B/Album/01.flac'),
      f('L', '/mnt/music', 'B/Album/02.flac'),
      f('L', '/mnt/music/Jazz', 'A/Album/CD1/01.flac'),
    ], '/mnt/music');
    expect(out.get('L')).toEqual(['B/Album', 'Jazz/A/Album/CD1']);
  });

  it('falls back to the whole library for a file outside the music root', () => {
    const out = scanFoldersOf([f('L', '/srv/elsewhere', 'X/01.flac'), f('L', '/mnt/music', 'B/01.flac'), f('M', '/mnt/music', '01.flac')], '/mnt/music');
    expect(out.get('L')).toEqual(['']);
    expect(out.get('M')).toEqual(['']);
  });

  it('names a root by its folder under the music root', () => {
    expect(rootFolderOf('/mnt/music', '/mnt/music')).toBe('');
    expect(rootFolderOf('/mnt/music/Jazz/', '/mnt/music')).toBe('Jazz');
    expect(rootFolderOf('/srv/elsewhere', '/mnt/music')).toBe('');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('player.scan around an outage (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  const sent: Array<{ name: string; data: unknown }> = [];
  // this library's (the shared test database may hold another suite's requests)
  const playerScans = () => sent.filter((s) => s.name === PLAYER_SCAN_QUEUE && (s.data as { libraryId: string }).libraryId === libraryId).map((s) => s.data);
  const requested = async () =>
    ((await client`select folder from player_scan_requests where library_id = ${libraryId} order by folder`) as Array<{ folder: string }>).map((r) => r.folder);

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    const boss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return randomUUID(); } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };
    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `robin-${userId}@example.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Robin', ownerUserId: userId, settings: {} });
    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/mnt/music/Robin', displayName: 'Robin', validationStatus: 'ok', reach: 'offline' });
  });

  afterAll(async () => {
    await client`delete from player_scan_requests where library_id = ${libraryId}`;
    await client`delete from scan_roots where id = ${rootId}`; // cascades scans
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('player.scan waits while a root is offline, and goes once after the return scan', async () => {
    // a tag write while the root is offline: the folders are kept, nothing is sent
    await requestPlayerRescan(ctx, [{ libraryId, fileId: randomUUID(), scanRootPath: '/mnt/music/Robin', relPath: 'A/Album/01.flac' }]);
    expect(playerScans()).toEqual([]);
    expect(await requested()).toEqual(['Robin/A/Album']);

    // the return: the watch writes online, then sends the root's work and its scan
    await client`update scan_roots set reach = 'online', reach_since = now() - interval '5 minutes' where id = ${rootId}`;
    await onlineAgain(ctx)(rootId, 'offline');
    expect(sent.map((s) => s.name)).toEqual(['scan.root']);
    expect(sent[0]!.data).toEqual({ scanRootId: rootId, mode: 'quick' });
    expect(playerScans()).toEqual([]);
    expect(await requested()).toEqual(['Robin', 'Robin/A/Album']);

    // a return scan the folder cut short again: still nothing
    await client`insert into scans (scan_root_id, status, started_at, finished_at, stats)
                 values (${rootId}, 'aborted', now() - interval '2 minutes', now() - interval '2 minutes', ${JSON.stringify({ mode: 'quick', offline: true })}::jsonb)`;
    expect(await afterReturn(ctx, rootId)).toBe(false);
    expect(playerScans()).toEqual([]);

    // the return scan finishes: one player.scan
    await client`insert into scans (scan_root_id, status, started_at, finished_at, stats)
                 values (${rootId}, 'completed', now() - interval '1 minute', now(), ${JSON.stringify({ mode: 'quick' })}::jsonb)`;
    expect(await afterReturn(ctx, rootId)).toBe(true);
    expect(playerScans()).toEqual([{ libraryId }]);

    // a later whole scan is not the return scan: nothing more goes from here
    await client`insert into scans (scan_root_id, status, started_at, finished_at, stats)
                 values (${rootId}, 'completed', now(), now(), ${JSON.stringify({ mode: 'quick' })}::jsonb)`;
    expect(await afterReturn(ctx, rootId)).toBe(false);
    expect(playerScans()).toEqual([{ libraryId }]);
  });
});
