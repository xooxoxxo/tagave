/**
 * The one transactional accept every accept path goes through, against a
 * real database: what it writes and returns, when it refuses, concurrent
 * accepts on one album, and a model accept's probability.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  acceptInTx, assertAcceptInput, libraries, localAlbums, releaseGroups, releases, users, makeDb, type AcceptInput,
} from '@tagave/db';

describe.skipIf(!process.env.TEST_DATABASE_URL)('acceptInTx (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const otherRelease = randomUUID();
  const batchId = randomUUID();
  let albumId: string;

  const run = (a: Partial<AcceptInput>) => client.begin((tx: any) => acceptInTx(tx, {
    libraryId, albumId, releaseId, distance: 0.02, source: 'mb_search', reason: 'r', status: 'auto', decidedBy: 'system', decidedKind: 'rule', ...a,
  }));

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: userId, email: `am-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'AcceptMatch', ownerUserId: userId, settings: {} });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Kosmonument', artistCredit: ['Oranssi Pazuzu'] });
    for (const id of [releaseId, otherRelease]) {
      await db.insert(releases).values({ id, releaseGroupId: rgId, mbid: randomUUID(), title: 'Kosmonument', date: '2011-03-01', country: 'FI', status: 'Official', trackCount: 3, sourceOfTruth: 'musicbrainz' });
    }
  });

  beforeEach(async () => {
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    albumId = randomUUID();
    await db.insert(localAlbums).values({ id: albumId, libraryId, clusterKey: `k-${albumId}`, dirPaths: [`x/${albumId}`], titleGuess: 'Kosmonument', artistGuess: 'Oranssi Pazuzu', state: 'needs_review', identifyReason: 'close call', trackCount: 3 });
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades albums and matches
    await db.delete(releases).where(inArray(releases.id, [releaseId, otherRelease]));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('moves the album, writes the match with its provenance and returns what it replaced', async () => {
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, reason, decided_kind)
                 values (${libraryId}, ${albumId}, ${otherRelease}, 0.0500, 'auto', 'system', 'auto-accept: distance 0.0500 (musicbrainz)', 'system')`;
    const res = await run({ decidedKind: 'model', deciderId: 'jev', deciderVersion: 'jev-2026-09-15', probability: 0.994, batchId, reason: 'model accept: test' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prior).toMatchObject({ state: 'needs_review', liveMatchStatus: 'auto', liveMatchReason: 'auto-accept: distance 0.0500 (musicbrainz)' });
    const rows = await client`select status, reason, decided_kind, probability::text, batch_id from album_matches where local_album_id = ${albumId} order by created_at`;
    expect(rows.map((r: any) => [r.status, r.reason])).toEqual([['rejected', 'auto-accept: distance 0.0500 (musicbrainz)'], ['auto', 'model accept: test']]);
    expect(rows[1]).toMatchObject({ decided_kind: 'model', probability: '0.9940', batch_id: batchId });
    const [a] = await client`select state, release_id, release_group_id, identify_reason from local_albums where id = ${albumId}`;
    expect(a).toMatchObject({ state: 'matched', release_id: releaseId, release_group_id: rgId, identify_reason: null });
  });

  it('keeps every provenance value it is given and reports the prior album state', async () => {
    const res = await run({ status: 'confirmed', decidedBy: 'user', decidedKind: 'user', decidedByUserId: userId, source: 'user_mbid', reason: 'accepted in review queue', distance: 0.12345 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prior).toEqual({
      state: 'needs_review', identifyReason: 'close call', releaseId: null, releaseGroupId: null, identifiedAt: null,
      liveMatchId: null, liveMatchStatus: null, liveMatchReason: null,
    });
    const [m] = await client`select id, status, decided_by, decided_kind, decided_by_user_id, source, reason, distance::text,
                                    decider_id, decider_version, probability, batch_id
                               from album_matches where local_album_id = ${albumId}`;
    expect(m).toMatchObject({
      id: res.matchId, status: 'confirmed', decided_by: 'user', decided_kind: 'user', decided_by_user_id: userId, source: 'user_mbid',
      reason: 'accepted in review queue', distance: '0.1235', decider_id: null, decider_version: null, probability: null, batch_id: null,
    });
  });

  it('refuses an album that left review, one that is gone, and a release that is gone', async () => {
    await client`update local_albums set state = 'unidentified' where id = ${albumId}`;
    expect(await run({})).toEqual({ ok: false, reason: 'state' });
    expect(await run({ albumId: randomUUID() })).toEqual({ ok: false, reason: 'gone' });
    await client`update local_albums set state = 'needs_review' where id = ${albumId}`;
    expect(await run({ releaseId: randomUUID() })).toEqual({ ok: false, reason: 'release_gone' });
  });

  it('refuses an album of another library as gone', async () => {
    expect(await run({ libraryId: randomUUID() })).toEqual({ ok: false, reason: 'gone' });
  });

  it('fromStates null accepts from any state (a person on the album page)', async () => {
    await client`update local_albums set state = 'matched' where id = ${albumId}`;
    expect((await run({ fromStates: null, status: 'confirmed', decidedBy: 'user', decidedKind: 'user' })).ok).toBe(true);
  });

  it('two accepts racing on one album leave exactly one live match', async () => {
    await Promise.all([run({}), run({ releaseId: otherRelease })]);
    const live = await client`select 1 from album_matches where local_album_id = ${albumId} and status in ('auto', 'confirmed')`;
    expect(live).toHaveLength(1);
  });

  it('two accepts from any state racing on one album still leave exactly one live match', async () => {
    const res = await Promise.all([run({ fromStates: null }), run({ fromStates: null, releaseId: otherRelease })]);
    expect(res.every((r: any) => r.ok)).toBe(true);
    const live = await client`select 1 from album_matches where local_album_id = ${albumId} and status in ('auto', 'confirmed')`;
    expect(live).toHaveLength(1);
  });

  it('a model accept needs a finite probability within 0..1, and nothing is written without one', async () => {
    const model = { decidedKind: 'model' as const, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', reason: 'model accept: jev-2026-09-15' };
    await expect(run(model)).rejects.toBeInstanceOf(RangeError);
    for (const probability of [null, Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
      await expect(run({ ...model, probability })).rejects.toBeInstanceOf(RangeError);
    }
    const rows = await client`select 1 from album_matches where local_album_id = ${albumId}`;
    expect(rows).toHaveLength(0);
    const [a] = await client`select state from local_albums where id = ${albumId}`;
    expect(a.state).toBe('needs_review');
    expect((await run({ ...model, probability: 1 })).ok).toBe(true);
  });

  it("a model accept's reason must say it is the model's, and nothing is written otherwise", async () => {
    const model = { decidedKind: 'model' as const, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', probability: 0.99 };
    for (const reason of ['r', 'accepted in review queue', 'Model accept: x']) {
      await expect(run({ ...model, reason })).rejects.toBeInstanceOf(RangeError);
    }
    expect(() => assertAcceptInput({
      libraryId, albumId, releaseId, distance: 0.02, source: null, reason: 'r', status: 'auto', decidedBy: 'system', ...model,
    })).toThrow(RangeError);
    expect(await client`select 1 from album_matches where local_album_id = ${albumId}`).toHaveLength(0);
    const [a] = await client`select state from local_albums where id = ${albumId}`;
    expect(a.state).toBe('needs_review');
  });

  it('a release cannot be deleted between the check and the insert that references it', async () => {
    const doomed = randomUUID();
    await db.insert(releases).values({ id: doomed, releaseGroupId: rgId, mbid: randomUUID(), title: 'Kosmonument', trackCount: 3, sourceOfTruth: 'musicbrainz' });
    let deleted = false;
    let deletion: Promise<unknown> | undefined;
    // Right after the accept has read the release, a second connection
    // tries to delete it (as relinking a release to a new id does).
    const res = await client.begin(async (tx: any) => {
      const spy = (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const q = tx(strings, ...vals);
        if (!strings.join('?').includes('from releases')) return q;
        return q.then(async (rows: unknown) => {
          deletion = client`delete from releases where id = ${doomed}`.then(() => { deleted = true; });
          // wait until the delete is blocked on a lock (or, without one, done)
          for (let i = 0; i < 100 && !deleted; i++) {
            const waiting = await client`select 1 from pg_stat_activity
                                          where wait_event_type = 'Lock' and query like 'delete from releases where id = %'`;
            if (waiting.length > 0) break;
            await new Promise((r) => setTimeout(r, 20));
          }
          return rows;
        });
      };
      return acceptInTx(spy as any, {
        libraryId, albumId, releaseId: doomed, distance: 0.02, source: 'mb_search', reason: 'r', status: 'auto', decidedBy: 'system', decidedKind: 'rule',
      });
    });
    expect(deleted).toBe(false);
    expect(res.ok).toBe(true);
    await deletion;
    expect(deleted).toBe(true);
  });

  it('any probability given must be within 0..1; other kinds may leave it out', async () => {
    await expect(run({ probability: 2 })).rejects.toBeInstanceOf(RangeError);
    expect((await run({ probability: null })).ok).toBe(true);
  });
});
