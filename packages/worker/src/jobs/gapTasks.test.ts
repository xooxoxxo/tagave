/**
 * Gap decisions through gaps.recompute (0032): a gap the owner took on as a
 * task stays on the list while it holds, and the recompute that finds it
 * fixed marks it resolved instead of deleting it (accepted_at stays, so the
 * Tasks list shows it crossed out). Quality gaps are one row per flag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import {
  users, libraries, releaseGroups, releases, canonicalTracks, localAlbums, localTracks,
  audioFiles, scanRoots, images, gaps, makeDb,
} from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { gapsRecomputeJob } from './gapsRecompute.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('gaps.recompute keeps tasks until fixed (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: { end: () => Promise<void> };
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const albumId = randomUUID();
  const TITLES = ['Sound of Soul', 'Change', 'Sensibility', 'Benevolent Smile', 'Five', 'Six'];

  const incomplete = async () =>
    (await db.select().from(gaps).where(and(eq(gaps.libraryId, libraryId), eq(gaps.kind, 'incomplete_album'))))[0];
  const quality = async () =>
    db.select().from(gaps).where(and(eq(gaps.libraryId, libraryId), eq(gaps.kind, 'quality')));
  const run = () => gapsRecomputeJob(ctx, { libraryId });

  /** local copies of tracks 1..n of the release (the album starts with 5 and 6 only) */
  async function addTracks(positions: number[]) {
    for (const position of positions) {
      const fileId = randomUUID();
      await db.insert(audioFiles).values({ id: fileId, libraryId, scanRootId: rootId, relPath: `Transformation/${position}.flac`, lossless: true });
      await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: fileId, discNo: 1, trackNo: position });
    }
    const [row] = await ctx.sql`select count(*)::int as n from local_tracks where local_album_id = ${albumId}` as unknown as { n: number }[];
    await db.update(localAlbums).set({ trackCount: row?.n ?? 0 }).where(eq(localAlbums.id, albumId));
  }

  beforeAll(async () => {
    const conn = await makeDb(process.env.TEST_DATABASE_URL!);
    db = conn.db;
    client = conn.client as unknown as { end: () => Promise<void> };
    ctx = { db: conn.db, sql: conn.client, boss: null as any, logger: pino({ level: 'silent' }) };

    await db.insert(users).values({ id: userId, email: `tasks-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Tasks test', ownerUserId: userId });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/music', displayName: 'Music', validationStatus: 'ok' });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Transformation', primaryType: 'Album' });
    await db.insert(releases).values({ id: releaseId, releaseGroupId: rgId, mbid: randomUUID(), title: 'Transformation', trackCount: 6 });
    await db.insert(canonicalTracks).values(TITLES.map((title, i) => ({ releaseId, mediumNo: 1, position: i + 1, title })));
    await db.insert(localAlbums).values({
      id: albumId, libraryId, clusterKey: `tasks-${albumId}`, dirPaths: ['Transformation'], titleGuess: 'Transformation',
      state: 'matched', releaseId, releaseGroupId: rgId, trackCount: 0,
    });
    await addTracks([5, 6]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades gaps, albums, files, roots
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId)); // cascades the release and its tracks
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it('opens an incomplete gap listing the missing tracks', async () => {
    await run();
    const gap = await incomplete();
    expect(gap.state).toBe('open');
    expect(gap.flag).toBe('');
    const details = gap.details as { have: number; want: number; missing: { position: number; title: string }[] };
    expect(details.have).toBe(2);
    expect(details.want).toBe(6);
    expect(details.missing.map((m) => m.title)).toEqual(TITLES.slice(0, 4));
  });

  it('keeps an accepted task through recomputes while tracks are still missing, updating what is missing', async () => {
    const gap = await incomplete();
    await db.update(gaps).set({ state: 'todo', acceptedAt: new Date(), note: 'check the old CD-R' }).where(eq(gaps.id, gap.id));
    await addTracks([1, 2]);
    await run();
    const after = await incomplete();
    expect(after.id).toBe(gap.id);
    expect(after.state).toBe('todo');
    expect(after.acceptedAt).not.toBeNull();
    expect(after.note).toBe('check the old CD-R');
    expect(after.resolvedAt).toBeNull();
    expect((after.details as { missing: { title: string }[] }).missing.map((m) => m.title)).toEqual(['Sensibility', 'Benevolent Smile']);
  });

  it('marks the task done when the scan finds every track, keeping it as an accepted task', async () => {
    await addTracks([3, 4]);
    await run();
    const done = await incomplete();
    expect(done.state).toBe('resolved');
    expect(done.resolvedAt).not.toBeNull();
    expect(done.acceptedAt).not.toBeNull();
    expect(done.note).toBe('check the old CD-R');
  });

  it('writes one quality row per flag, so each can be decided on its own', async () => {
    const rows = await quality();
    const flags = rows.map((r: { flag: string }) => r.flag).sort();
    expect(flags).toContain('noCover');
    for (const r of rows) {
      expect(Object.keys((r.details as { flags: Record<string, unknown> }).flags)).toEqual([r.flag]);
    }
  });

  it('keeps a quality task and a hidden flag, and resolves only the flag that was fixed', async () => {
    const rows = await quality();
    const noCover = rows.find((r: { flag: string }) => r.flag === 'noCover');
    const other = rows.find((r: { flag: string }) => r.flag !== 'noCover');
    await db.update(gaps).set({ state: 'todo', acceptedAt: new Date() }).where(eq(gaps.id, noCover.id));
    if (other) await db.update(gaps).set({ state: 'dismissed', dismissReason: 'not_interested' }).where(eq(gaps.id, other.id));

    await run();
    let now = await quality();
    expect(now.find((r: { id: string }) => r.id === noCover.id).state).toBe('todo');
    if (other) expect(now.find((r: { id: string }) => r.id === other.id).state).toBe('dismissed');

    await db.insert(images).values({ libraryId, entityType: 'local_album', entityId: albumId, localAlbumId: albumId, kind: 'front', origin: 'owner', licenseNote: 'test' });
    await run();
    now = await quality();
    const fixed = now.find((r: { id: string }) => r.id === noCover.id);
    expect(fixed.state).toBe('resolved');
    expect(fixed.acceptedAt).not.toBeNull();
    if (other) expect(now.find((r: { id: string }) => r.id === other.id).state).toBe('dismissed');
  });

  it('opens a fresh gap, not a task, when a fixed problem comes back', async () => {
    await db.delete(images).where(eq(images.localAlbumId, albumId));
    await run();
    const back = (await quality()).find((r: { flag: string }) => r.flag === 'noCover');
    expect(back.state).toBe('open');
    expect(back.acceptedAt).toBeNull();
    expect(back.resolvedAt).toBeNull();
  });
});
