/**
 * An owner-requested identification records how it ended (identify_runs):
 * the album page reads it instead of guessing from a job that is gone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { libraries, localAlbums, users, makeDb } from '@liner/db';
import type { WorkerContext } from './context.js';
import { identifyAlbumJob } from '../jobs/identifyAlbum.js';
import { recordIdentifyOutcome } from './identifyRuns.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('identify outcome recording (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const runsOf = (albumId: string) => client`
    select job_id, kind, pinned, outcome, message, detail, jsonb_typeof(detail) as detail_type from identify_runs
     where local_album_id = ${albumId} order by finished_at` as Promise<Array<Record<string, any>>>;
  const album = async (state = 'unidentified') => {
    const id = randomUUID();
    await db.insert(localAlbums).values({ id, libraryId, clusterKey: `k-${id}`, dirPaths: ['x'], state, titleGuess: 'T', artistGuess: 'A' });
    return id;
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: quiet as any };
    await db.insert(users).values({ id: userId, email: `runs-${userId}@test.com`, passwordHash: 'x' });
    // no contact string: provider lookups refuse to run (PLT-4)
    await db.insert(libraries).values({ id: libraryId, name: 'Runs', ownerUserId: userId, settings: {} });
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('stores the outcome with its detail, keyed by the job', async () => {
    const albumId = await album();
    const jobId = randomUUID();
    await recordIdentifyOutcome(ctx, { localAlbumId: albumId, force: true, pinnedMbid: '593f3c1a-3529-39e6-92ef-395dd48f840c' }, jobId, {
      outcome: 'release_group',
      message: 'It is a release group — pick one of its releases:',
      detail: { releaseGroup: { mbid: '593f3c1a-3529-39e6-92ef-395dd48f840c', title: 'Hôtel Costes, Volume 11' }, choices: [], moreChoices: 0 },
    });
    const rows = await runsOf(albumId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: jobId, kind: 'mbid', pinned: '593f3c1a-3529-39e6-92ef-395dd48f840c', outcome: 'release_group' });
    expect(rows[0]!.detail_type).toBe('object'); // not a JSON string
    expect(rows[0]!.detail.releaseGroup.title).toBe('Hôtel Costes, Volume 11');
  });

  it('writes nothing for an album that is gone', async () => {
    const gone = randomUUID();
    await recordIdentifyOutcome(ctx, { localAlbumId: gone, force: true }, randomUUID(), { outcome: 'failed', message: 'x' });
    expect(await runsOf(gone)).toHaveLength(0);
  });

  it('a failed manual request records why, then still fails the job for pg-boss', async () => {
    const albumId = await album();
    const jobId = randomUUID();
    await expect(identifyAlbumJob(ctx, { localAlbumId: albumId, force: true, pinnedMbid: 'abc' }, { jobId })).rejects.toThrow();
    const rows = await runsOf(albumId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: jobId, kind: 'mbid', outcome: 'failed' });
    expect(rows[0]!.message).toMatch(/contact email/);
  });

  it('a fingerprint (identify.acoustid) run records nothing, though it is force:true', async () => {
    const albumId = await album();
    await expect(identifyAlbumJob(ctx, {
      localAlbumId: albumId, force: true, acoustidMbids: ['11111111-1111-1111-1111-111111111111'], acoustidCoverage: {},
    }, { jobId: randomUUID() })).rejects.toThrow();
    expect(await runsOf(albumId)).toHaveLength(0);
  });

  it('a disc-repair run (force:true, no marker) records nothing', async () => {
    const albumId = await album();
    await expect(identifyAlbumJob(ctx, { localAlbumId: albumId, force: true }, { jobId: randomUUID() })).rejects.toThrow();
    expect(await runsOf(albumId)).toHaveLength(0);
  });

  it("the owner's Re-identify (requestedBy: owner) is recorded", async () => {
    const albumId = await album();
    await expect(identifyAlbumJob(ctx, { localAlbumId: albumId, force: true, requestedBy: 'owner' }, { jobId: randomUUID() })).rejects.toThrow();
    expect((await runsOf(albumId))[0]).toMatchObject({ kind: 'reidentify', outcome: 'failed' });
  });

  it('the sweep records nothing', async () => {
    const albumId = await album('matched');
    await expect(identifyAlbumJob(ctx, { localAlbumId: albumId }, { jobId: randomUUID() })).resolves.toMatchObject({ outcome: 'skipped' });
    expect(await runsOf(albumId)).toHaveLength(0);
  });

  it('a release-group request is recorded under its own kind', async () => {
    const albumId = await album();
    await recordIdentifyOutcome(ctx, { localAlbumId: albumId, pinnedReleaseGroup: 'rg-1' }, undefined, { outcome: 'not_found', message: 'gone' });
    expect((await runsOf(albumId))[0]).toMatchObject({ kind: 'release_group', pinned: 'rg-1', job_id: null, outcome: 'not_found' });
  });
});
