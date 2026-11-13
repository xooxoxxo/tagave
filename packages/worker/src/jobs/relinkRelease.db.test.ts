/**
 * Relinking a Discogs-only release onto its MusicBrainz release, against a
 * real database: it locks the albums it re-points before the releases, in
 * the order every match accept takes them, so an accept running at the same
 * time waits instead of deadlocking.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { acceptInTx, libraries, releaseGroups, releases, users, makeDb } from '@tagave/db';
import { relinkRelease } from './enrichRelease.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('relinkRelease (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const oldRg = randomUUID();
  const newRg = randomUUID();
  const oldRelease = randomUUID();
  const newRelease = randomUUID();
  const albumId = randomUUID();
  const discogsId = 900_000_000 + Math.floor(Math.random() * 99_000_000);

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: userId, email: `rl-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Relink', ownerUserId: userId, settings: {} });
    await db.insert(releaseGroups).values([
      { id: oldRg, discogsReleaseId: discogsId, title: 'Kosmonument', artistCredit: ['Oranssi Pazuzu'] },
      { id: newRg, mbid: randomUUID(), title: 'Kosmonument', artistCredit: ['Oranssi Pazuzu'] },
    ]);
    await db.insert(releases).values([
      { id: oldRelease, releaseGroupId: oldRg, discogsReleaseId: discogsId, title: 'Kosmonument', trackCount: 3, sourceOfTruth: 'discogs' },
      { id: newRelease, releaseGroupId: newRg, mbid: randomUUID(), title: 'Kosmonument', trackCount: 3, sourceOfTruth: 'musicbrainz' },
    ]);
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, state, release_id, release_group_id, track_count)
                 values (${albumId}, ${libraryId}, ${`k-${albumId}`}, ${[`x/${albumId}`]}, 'Kosmonument', 'matched', ${oldRelease}, ${oldRg}, 3)`;
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, reason, decided_kind)
                 values (${libraryId}, ${albumId}, ${oldRelease}, 0.0500, 'auto', 'system', 'auto-accept: distance 0.0500 (discogs)', 'system')`;
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades albums and matches
    await db.delete(releases).where(inArray(releases.id, [oldRelease, newRelease]));
    await db.delete(releaseGroups).where(inArray(releaseGroups.id, [oldRg, newRg]));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('waits for an accept holding the album instead of deadlocking with it', async () => {
    let relinked = false;
    let relink: Promise<unknown> | undefined;
    // Re-identify the album onto the old release. Right after the accept has
    // locked the album, the relink starts on another connection and runs
    // until it waits on a lock; then the accept goes on to the release.
    const res = await client.begin(async (tx: any) => {
      await tx`set local lock_timeout = '5s'`;
      const spy = (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const q = tx(strings, ...vals);
        if (!strings.join('?').includes('from local_albums')) return q;
        return q.then(async (rows: unknown) => {
          relink = client.begin((rtx: any) => relinkRelease(rtx, { id: oldRelease, discogsReleaseId: discogsId, releaseGroupId: oldRg }, { releaseId: newRelease, releaseGroupId: newRg }))
            .then(() => { relinked = true; });
          relink!.catch(() => {});
          for (let i = 0; i < 100 && !relinked; i++) {
            const waiting = await client`select 1 from pg_stat_activity
                                          where wait_event_type = 'Lock' and query like '%local_albums%'
                                            and query not like '%library_id =%' and query not like '%pg_stat_activity%'`;
            if (waiting.length > 0) break;
            await new Promise((r) => setTimeout(r, 20));
          }
          return rows;
        });
      };
      return acceptInTx(spy as any, {
        libraryId, albumId, releaseId: oldRelease, distance: 0.04, source: 'discogs_search', reason: 'r',
        status: 'auto', decidedBy: 'system', decidedKind: 'system', fromStates: null,
      });
    });
    expect(relinked).toBe(false);
    expect(res.ok).toBe(true);
    await relink;
    expect(relinked).toBe(true);
    const [a] = await client`select release_id, release_group_id from local_albums where id = ${albumId}`;
    expect(a).toMatchObject({ release_id: newRelease, release_group_id: newRg });
    const live = await client`select release_id from album_matches where local_album_id = ${albumId} and status in ('auto', 'confirmed')`;
    expect(live.map((r: any) => r.release_id)).toEqual([newRelease]);
    expect(await client`select 1 from releases where id = ${oldRelease}`).toHaveLength(0);
  });
});
