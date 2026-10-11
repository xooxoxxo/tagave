/**
 * Review matches › Auto-accept against a real database: the rules over the
 * queue (what the API's dry run reads, what "Accept N now" and the identify
 * hook write), idempotence, the master switch, and the queue.autoaccept job
 * in rules mode leaving an Activity entry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import {
  albumMatches, audioFiles, autoAcceptRules, jobRuns, libraries, localAlbums, localTracks, matchCandidates,
  releaseGroups, releases, scanRoots, users, makeDb,
} from '@liner/db';
import { AUTO_ACCEPT_REASON_PREFIX } from '@liner/shared';
import type { WorkerContext } from './context.js';
import { acceptByRules } from './autoAccept.js';
import { queueAutoAcceptJob } from '../jobs/queueAutoAccept.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('auto-accept rules (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const send = vi.fn(async () => 'job-id');
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const rgId = randomUUID();
  const releaseIds: string[] = [];

  async function release(over: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    releaseIds.push(id);
    await db.insert(releases).values({ id, releaseGroupId: rgId, mbid: randomUUID(), title: 'Kosmonument', date: '2011-03-01', country: 'FI', status: 'Official', trackCount: 3, sourceOfTruth: 'musicbrainz', ...over });
    return id;
  }

  /** A needs_review album with three tracks and the given candidates. */
  async function album(cands: Array<{ releaseId: string; distance: string; breakdown?: Record<string, number> }>, state = 'needs_review'): Promise<string> {
    const id = randomUUID();
    await db.insert(localAlbums).values({ id, libraryId, clusterKey: `k-${id}`, dirPaths: [`x/${id}`], titleGuess: 'Kosmonument', artistGuess: 'Oranssi Pazuzu', yearGuess: 2011, state, trackCount: 3 });
    for (let i = 1; i <= 3; i++) {
      const fileId = randomUUID();
      await db.insert(audioFiles).values({ id: fileId, libraryId, scanRootId: rootId, relPath: `${id}/${i}.flac`, sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
      await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, trackNo: i, titleGuess: `Track ${i}`, durationMs: 200_000 });
    }
    for (const c of cands) {
      await db.insert(matchCandidates).values({ localAlbumId: id, releaseId: c.releaseId, distance: c.distance, breakdown: c.breakdown ?? { album: 0, artist: 0, tracks: 0, trackTitle: 0, year: 0 }, source: 'mb_search' });
    }
    return id;
  }

  async function setRules(over: Record<string, unknown>) {
    const values = { enabled: true, minMatch: 95, allChecksAgree: true, clearWinnerGap: 5, preferSource: 'either', officialOnly: true, ...over };
    await db.insert(autoAcceptRules).values({ libraryId, ...values }).onConflictDoUpdate({ target: autoAcceptRules.libraryId, set: values });
  }

  const stateOf = async (id: string) => (await db.select().from(localAlbums).where(eq(localAlbums.id, id)))[0];
  const liveMatches = async (id: string) => db.select().from(albumMatches)
    .where(and(eq(albumMatches.localAlbumId, id), inArray(albumMatches.status, ['auto', 'confirmed'])));

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: userId, email: `aa-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'AutoAccept', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: `/aa-${rootId}`, displayName: 'AA', writable: false });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Kosmonument', artistCredit: ['Oranssi Pazuzu'] });
  });

  beforeEach(async () => {
    send.mockClear();
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(jobRuns).where(eq(jobRuns.libraryId, libraryId));
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades albums, files, roots, rules, matches
    if (releaseIds.length) await db.delete(releases).where(inArray(releases.id, releaseIds));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('accepts the albums the rules pass, leaves the rest in review, and writes the audit row', async () => {
    await setRules({});
    const good = await album([{ releaseId: await release(), distance: '0.0200' }]);
    const offCount = await album([{ releaseId: await release({ trackCount: 12 }), distance: '0.0200' }]);
    const tooClose = await album([{ releaseId: await release(), distance: '0.0200' }, { releaseId: await release(), distance: '0.0300' }]);

    const run = await acceptByRules(ctx, libraryId, { requireEnabled: true });
    expect(run).toMatchObject({ considered: 3, accepted: 1 });

    const g = await stateOf(good);
    expect(g.state).toBe('matched');
    expect(g.identifiedAt).not.toBeNull();
    const live = await liveMatches(good);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'auto', decidedBy: 'system', source: 'mb_search' });
    expect(live[0].reason).toBe(`${AUTO_ACCEPT_REASON_PREFIX}: 98% match, every check agrees, official, only edition (MusicBrainz)`);
    expect(send).toHaveBeenCalledWith('enrich.release', { releaseId: live[0].releaseId }, expect.anything());

    expect((await stateOf(offCount)).state).toBe('needs_review');
    expect((await stateOf(tooClose)).state).toBe('needs_review');
  });

  it('is idempotent: a second run accepts nothing and writes nothing', async () => {
    await setRules({});
    const id = await album([{ releaseId: await release(), distance: '0.0100' }]);
    expect((await acceptByRules(ctx, libraryId, { requireEnabled: true })).accepted).toBe(1);
    expect((await acceptByRules(ctx, libraryId, { requireEnabled: true })).accepted).toBe(0);
    const rows = await db.select().from(albumMatches).where(eq(albumMatches.localAlbumId, id));
    expect(rows).toHaveLength(1);
  });

  it('never takes an album the owner decided meanwhile', async () => {
    await setRules({});
    const id = await album([{ releaseId: await release(), distance: '0.0100' }], 'as_is');
    expect((await acceptByRules(ctx, libraryId, { requireEnabled: false, albumIds: [id] })).accepted).toBe(0);
    expect((await stateOf(id)).state).toBe('as_is');
  });

  it('does nothing for new matches while the switch is off, without saved rules too', async () => {
    await db.delete(autoAcceptRules).where(eq(autoAcceptRules.libraryId, libraryId));
    const id = await album([{ releaseId: await release(), distance: '0.0100' }]);
    expect((await acceptByRules(ctx, libraryId, { requireEnabled: true })).considered).toBe(0); // no row: defaults, off
    await setRules({ enabled: false });
    expect((await acceptByRules(ctx, libraryId, { requireEnabled: true })).accepted).toBe(0);
    expect((await stateOf(id)).state).toBe('needs_review');
  });

  it('"Accept N now" (queue.autoaccept, rules mode) runs the saved rules even while off and logs to Activity', async () => {
    await setRules({ enabled: false, minMatch: 90 });
    const a = await album([{ releaseId: await release(), distance: '0.0500' }]);
    const b = await album([{ releaseId: await release({ status: 'Bootleg' }), distance: '0.0100' }]);
    await queueAutoAcceptJob(ctx, { libraryId, mode: 'rules' });
    expect((await stateOf(a)).state).toBe('matched');
    expect((await stateOf(b)).state).toBe('needs_review');
    const runs = await db.select().from(jobRuns).where(and(eq(jobRuns.libraryId, libraryId), eq(jobRuns.type, 'queue.autoaccept')));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'completed' });
    expect(runs[0].progress).toMatchObject({ done: 1, total: 2, message: '1/2 needs_review albums accepted by the auto-accept rules' });
  });
});
