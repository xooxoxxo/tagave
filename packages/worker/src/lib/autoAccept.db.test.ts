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
  albumMatches, files, autoAcceptRules, jobRuns, libraries, localAlbums, localTracks, matchCandidates,
  releaseGroups, releases, scanRoots, users, makeDb,
} from '@tagave/db';
import { AUTO_ACCEPT_REASON_PREFIX } from '@tagave/shared';
import type { WorkerContext } from './context.js';
import { acceptByRules, buildRulesBatch, loadRules } from './autoAccept.js';
import { runAcceptBatch } from '../jobs/deciderAccept.js';
import { queueAutoAcceptJob } from '../jobs/queueAutoAccept.js';
import { runUndoBatch } from '../jobs/deciderUndo.js';

/** set to make the queue.autoaccept Activity write fail */
const progressFault = vi.hoisted(() => ({ on: false }));
vi.mock('../jobs/progress.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../jobs/progress.js')>();
  return {
    ...real,
    reportProgress: (async (...args: Parameters<typeof real.reportProgress>) => {
      if (progressFault.on && args[2]?.type === 'queue.autoaccept') throw new Error('activity unavailable');
      return real.reportProgress(...args);
    }) as typeof real.reportProgress,
  };
});

const albumEvidence = (title: string) => ({
  v: 1, artist: 'Oranssi Pazuzu', title, discsKnown: true, discCount: 1,
  tracks: [1, 2, 3].map((n, i) => ({ i, disc: 1, title: `Track ${n}`, durS: 200 })),
});
const candidateEvidence = {
  v: 1, remote: { provider: 'musicbrainz', title: 'Kosmonument', artists: ['Oranssi Pazuzu'], year: 2011 },
  tracks: [[1, 'Track 1', 200], [1, 'Track 2', 200], [1, 'Track 3', 200]], align: [[0, 0, 0], [1, 1, 0], [2, 2, 0]],
  unmatchedLocal: [], missingRemote: [], capped: false,
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('auto-accept rules (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const send = vi.fn(async (..._args: unknown[]) => 'job-id');
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
      await db.insert(files).values({ handler: 'audio', id: fileId, libraryId, scanRootId: rootId, relPath: `${id}/${i}.flac`, sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
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

  /** stored evidence for an album and its candidates, as identification writes it */
  async function withEvidence(id: string) {
    await client`insert into album_evidence (local_album_id, v, evidence) values (${id}, 1, ${JSON.stringify(albumEvidence('Kosmonument'))}::text::jsonb)`;
    await client`update match_candidates set evidence = ${JSON.stringify(candidateEvidence)}::text::jsonb where local_album_id = ${id}`;
  }

  beforeEach(async () => {
    send.mockClear();
    progressFault.on = false;
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await client`delete from decider_batches where library_id = ${libraryId}`;
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

  it('a job queued before the upgrade without a mode runs the rules, never the chip rule', async () => {
    await setRules({ enabled: false, minMatch: 99 });
    // passes the old chip rule (no red, 3 or more green) but not minMatch 99
    const id = await album([{ releaseId: await release(), distance: '0.0500', breakdown: { album: 0, artist: 0, tracks: 0, trackTitle: 0.1 } }]);
    await queueAutoAcceptJob(ctx, { libraryId });
    expect((await stateOf(id)).state).toBe('needs_review');
  });

  it('rule accepts are kind rule, and the decision they replace keeps its reason', async () => {
    await setRules({});
    const id = await album([{ releaseId: await release(), distance: '0.0200' }]);
    const old = await release();
    await db.insert(albumMatches).values({ libraryId, localAlbumId: id, releaseId: old, distance: '0.0500', status: 'auto', decidedBy: 'system', reason: 'auto-accept: distance 0.0500 (musicbrainz)', decidedKind: 'system' });
    await acceptByRules(ctx, libraryId, { requireEnabled: true });
    const rows = await db.select().from(albumMatches).where(eq(albumMatches.localAlbumId, id));
    expect(rows.find((r: any) => r.status === 'rejected')?.reason).toBe('auto-accept: distance 0.0500 (musicbrainz)');
    expect(rows.find((r: any) => r.status === 'auto')?.decidedKind).toBe('rule');
  });

  it('"Accept N now" is one undoable batch of the owner\'s rules', async () => {
    await setRules({});
    const a = await album([{ releaseId: await release(), distance: '0.0200' }]);
    const b = await album([{ releaseId: await release(), distance: '0.0200' }]);
    await queueAutoAcceptJob(ctx, { libraryId, mode: 'rules', requestedByUserId: userId });
    const [batch] = await client`select id, decider_id, decided_kind, decider_version, started_by_user_id, state from decider_batches where library_id = ${libraryId}`;
    expect(batch).toMatchObject({ decider_id: 'rules', decided_kind: 'rule', started_by_user_id: userId, state: 'accepted' });
    expect(batch.decider_version).toMatch(/^rules@[0-9a-f]{8}$/);
    const m = await client`select decided_kind, batch_id, reason from album_matches where local_album_id in (${a}, ${b}) and status = 'auto'`;
    expect(m).toHaveLength(2);
    expect(m.every((x: any) => x.decided_kind === 'rule' && x.batch_id === batch.id && x.reason.startsWith(AUTO_ACCEPT_REASON_PREFIX))).toBe(true);
    await runUndoBatch(ctx, batch.id);
    expect((await stateOf(a)).state).toBe('needs_review');
    expect((await stateOf(b)).state).toBe('needs_review');
    const [after] = await client`select state from decider_batches where id = ${batch.id}`;
    expect(after.state).toBe('undone');
    expect(await client`select 1 from album_matches where local_album_id in (${a}, ${b}) and status in ('auto', 'confirmed')`).toHaveLength(0);
  });

  it('a rules batch that stops is left failed and the job ends, so a retry never makes a second batch', async () => {
    await setRules({});
    const a = await album([{ releaseId: await release(), distance: '0.0200' }]);
    // the accept fails after taking the album, when it queues the gaps recompute
    send.mockImplementation(async (queue: unknown) => {
      if (queue === 'gaps.recompute') throw new Error('queue unavailable');
      return 'job-id';
    });
    try {
      await expect(queueAutoAcceptJob(ctx, { libraryId, mode: 'rules', requestedByUserId: userId })).resolves.toBeUndefined();
    } finally {
      send.mockImplementation(async () => 'job-id');
    }
    const batches = await client`select id, state, message from decider_batches where library_id = ${libraryId}`;
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('failed');
    expect(batches[0].message).toMatch(/^Accept stopped/);
    // what it took stays taken until the owner undoes it
    expect((await stateOf(a)).state).toBe('matched');
    const runs = await db.select().from(jobRuns).where(and(eq(jobRuns.libraryId, libraryId), eq(jobRuns.type, 'queue.autoaccept')));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'failed' });
    expect(runs[0].error).toMatch(/^Accept stopped/);
  });

  it('the identify-time hook accepts one album without a batch', async () => {
    await setRules({});
    const a = await album([{ releaseId: await release(), distance: '0.0200' }]);
    await acceptByRules(ctx, libraryId, { albumIds: [a], requireEnabled: true });
    expect(await client`select 1 from decider_batches where library_id = ${libraryId}`).toHaveLength(0);
    const [m] = await client`select decided_kind, batch_id from album_matches where local_album_id = ${a} and status = 'auto'`;
    expect(m).toMatchObject({ decided_kind: 'rule', batch_id: null });
  });

  it('no album the rules accept: no empty batch', async () => {
    await setRules({ minMatch: 100 });
    await album([{ releaseId: await release(), distance: '0.0200' }]);
    await queueAutoAcceptJob(ctx, { libraryId, mode: 'rules' });
    expect(await client`select 1 from decider_batches where library_id = ${libraryId}`).toHaveLength(0);
  });

  it('a rules run without a person (an older queued job) records no runner', async () => {
    await setRules({});
    const a = await album([{ releaseId: await release(), distance: '0.0200' }]);
    const run = await acceptByRules(ctx, libraryId, { requireEnabled: false, viaBatch: true });
    expect(run).toMatchObject({ considered: 1, accepted: 1 });
    expect(run.acceptedAlbums.map((x) => x.albumId)).toEqual([a]);
    const [batch] = await client`select id, started_by_user_id from decider_batches where library_id = ${libraryId}`;
    expect(run.batchId).toBe(batch.id);
    expect(batch.started_by_user_id).toBeNull();
    // who decided stays empty on the match: the run's starter is on the batch
    const [m] = await client`select decided_by_user_id from album_matches where local_album_id = ${a} and status = 'auto'`;
    expect(m.decided_by_user_id).toBeNull();
  });

  it('a rules batch pins the evidence: an album re-scored before its turn is skipped, the others accepted', async () => {
    await setRules({});
    const a = await album([{ releaseId: await release(), distance: '0.0200' }]);
    const b = await album([{ releaseId: await release(), distance: '0.0200' }]);
    const bare = await album([{ releaseId: await release(), distance: '0.0200' }]); // no evidence yet
    await withEvidence(a);
    await withEvidence(b);
    const built = await buildRulesBatch(ctx, libraryId, await loadRules(ctx, libraryId), {});
    expect(built).toMatchObject({ considered: 3 });
    const items = await client`select local_album_id, evidence_hash from decider_batch_items where batch_id = ${built.batchId}`;
    const hashOf = new Map(items.map((i: any) => [i.local_album_id, i.evidence_hash]));
    expect(hashOf.get(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf.get(bare)).toBeNull();
    // the evidence rebuild re-scored b meanwhile
    await client`update match_candidates set distance = 0.0250 where local_album_id = ${b}`;
    const run = await runAcceptBatch(ctx, built.batchId!);
    expect(run).toMatchObject({ accepted: 2, skipped: { evidence_changed: 1 } });
    expect((await stateOf(a)).state).toBe('matched');
    expect((await stateOf(bare)).state).toBe('matched');
    expect((await stateOf(b)).state).toBe('needs_review');
  });

  it('an Activity write that fails after the batch is accepted never fails the job (no second batch on retry)', async () => {
    await setRules({});
    const a = await album([{ releaseId: await release(), distance: '0.0200' }]);
    progressFault.on = true;
    await expect(queueAutoAcceptJob(ctx, { libraryId, mode: 'rules' })).resolves.toBeUndefined();
    const batches = await client`select state from decider_batches where library_id = ${libraryId}`;
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('accepted');
    expect((await stateOf(a)).state).toBe('matched');
  });
});
