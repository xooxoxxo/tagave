/**
 * Review matches end to end through the worker, providers faked:
 * - identify.album leaves an album in review, and the auto-accept hook takes
 *   it right there when the rules are on (and only then);
 * - edition.add scores a pasted release like a searched one and adds it as a
 *   candidate without deciding anything.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import type { CanonicalRelease } from '@tagave/core';
import {
  albumMatches, audioFiles, autoAcceptRules, libraries, localAlbums, localTracks, matchCandidates,
  releases, scanRoots, users, makeDb,
} from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';

const catalogue = new Map<string, CanonicalRelease>();
const notFound = Object.assign(new Error('not found'), { status: 404 });
const fakeProviders = {
  mb: {
    searchReleases: async () => [...catalogue.values()].filter((r) => r.source === 'musicbrainz').map((r) => ({ release: { id: r.id } })),
    getRelease: async (id: string) => {
      const r = catalogue.get(id);
      if (!r) throw notFound;
      return r;
    },
  },
  discogs: {
    authenticated: false,
    searchReleases: async () => [],
    getRelease: async (id: string) => {
      const r = catalogue.get(`dc-${id}`);
      if (!r) throw notFound;
      return r;
    },
    getMaster: async () => { throw notFound; },
  },
};

vi.mock('../lib/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/providers.js')>()),
  libraryProviderSettings: async () => ({}),
  getProviders: () => fakeProviders,
  mbCall: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  discogsCall: (_ctx: unknown, _p: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../lib/providerCache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/providerCache.js')>()),
  cached: (_sql: unknown, _provider: unknown, _key: unknown, _ttl: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { identifyAlbumJob } = await import('./identifyAlbum.js');
const { addEditionJob } = await import('./addEdition.js');
const { queueAutoAcceptJob } = await import('./queueAutoAccept.js');

const TITLES = ['Kiertää', 'Kuuhun', 'Tyhjä', 'Valo'];

function mbRelease(over: Partial<CanonicalRelease> = {}): CanonicalRelease {
  const id = randomUUID();
  return {
    id,
    releaseGroupId: randomUUID(),
    title: 'Hook Album',
    artists: ['Hook Artist'],
    tracks: TITLES.map((title, i) => ({ title, artists: [], duration: 200_000, position: i + 1, mediumNumber: 1 })),
    year: 2011,
    date: '2011-03-01',
    country: 'FI',
    status: 'Official',
    source: 'musicbrainz',
    ...over,
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('review matches through the worker (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();

  async function album(state = 'pending'): Promise<string> {
    const id = randomUUID();
    await db.insert(localAlbums).values({ id, libraryId, clusterKey: `k-${id}`, dirPaths: [`h/${id}`], titleGuess: 'Hook Album', artistGuess: 'Hook Artist', yearGuess: 2011, state, trackCount: TITLES.length });
    for (const [i, title] of TITLES.entries()) {
      const fileId = randomUUID();
      await db.insert(audioFiles).values({ id: fileId, libraryId, scanRootId: rootId, relPath: `${id}/${i}.flac`, sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
      await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, trackNo: i + 1, titleGuess: title, durationMs: 200_000 });
    }
    return id;
  }
  const stateOf = async (id: string) => (await db.select().from(localAlbums).where(eq(localAlbums.id, id)))[0];
  async function setRules(over: Record<string, unknown>) {
    const values = { enabled: true, minMatch: 70, allChecksAgree: false, clearWinnerGap: 0, preferSource: 'either', officialOnly: true, ...over };
    await db.insert(autoAcceptRules).values({ libraryId, ...values }).onConflictDoUpdate({ target: autoAcceptRules.libraryId, set: values });
  }

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: vi.fn(async () => 'job') } as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: userId, email: `rm-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'ReviewMatches', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: `/rm-${rootId}`, displayName: 'RM', writable: false });
  });

  beforeEach(async () => {
    catalogue.clear();
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(autoAcceptRules).where(eq(autoAcceptRules.libraryId, libraryId));
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  // The one edition credits another artist: in the review band (the other
  // fields agree) but with a red component, so the matcher's own rules hold
  // it for review instead of accepting it.
  const heldForReview = () => {
    const r = mbRelease({ artists: ['Zzyzx Quartet'] });
    catalogue.set(r.id, r);
    return r;
  };

  it('without rules the album waits in review', async () => {
    heldForReview();
    const id = await album();
    const outcome = await identifyAlbumJob(ctx, { localAlbumId: id });
    expect(outcome).toMatchObject({ outcome: 'needs_review' });
    expect((await stateOf(id)).state).toBe('needs_review');
  });

  it('with the rules on, the hook accepts it the moment it lands in review', async () => {
    const r = heldForReview();
    await setRules({});
    const id = await album();
    const outcome = await identifyAlbumJob(ctx, { localAlbumId: id });
    expect(outcome).toMatchObject({ outcome: 'matched' });
    expect(outcome?.message).toContain('by your auto-accept rules');
    const a = await stateOf(id);
    expect(a.state).toBe('matched');
    const rel = (await db.select().from(releases).where(eq(releases.mbid, r.id)))[0];
    expect(a.releaseId).toBe(rel.id);
    const live = await db.select().from(albumMatches).where(and(eq(albumMatches.localAlbumId, id), inArray(albumMatches.status, ['auto', 'confirmed'])));
    expect(live).toHaveLength(1);
    expect(live[0].reason).toMatch(/^auto-accept rules: \d+% match, official \(MusicBrainz\)$/);
  });

  it('rules that the edition does not pass leave it in review', async () => {
    heldForReview();
    await setRules({ allChecksAgree: true });
    const id = await album();
    await identifyAlbumJob(ctx, { localAlbumId: id });
    expect((await stateOf(id)).state).toBe('needs_review');
  });

  it('a linked app’s suggestion is never auto-accepted: not by the rules on a re-identify, not by the queue sweep', async () => {
    heldForReview();
    const id = await album();
    expect(await identifyAlbumJob(ctx, { localAlbumId: id })).toMatchObject({ outcome: 'needs_review' });
    // an mc:<link> candidate as sure as can be: distance 0, an official release
    const [rg] = await client`insert into release_groups (mbid, title) values (${randomUUID()}, 'Hook Album') returning id`;
    const [rel] = await client`insert into releases (release_group_id, mbid, title, status, track_count) values (${rg.id}, ${randomUUID()}, 'Hook Album', 'Official', ${TITLES.length}) returning id`;
    await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source)
                 values (${id}, ${rel.id}, 0, ${JSON.stringify({ mc: { key: 'k', confidence: 1 } })}::text::jsonb, ${`mc:${randomUUID()}`})`;
    // rules strict enough that the searched edition fails them; before the fix the mc candidate passed
    await setRules({ minMatch: 99 });
    const outcome = await identifyAlbumJob(ctx, { localAlbumId: id, force: true });
    expect(outcome).toMatchObject({ outcome: 'needs_review' });
    expect(await db.select().from(albumMatches).where(eq(albumMatches.localAlbumId, id))).toEqual([]);
    // the mc candidate survived the re-identify, still waiting for a person
    expect((await client`select 1 from match_candidates where local_album_id = ${id} and source like 'mc:%'`).length).toBe(1);
    // the chip-rule sweep: whatever it takes, never the mc candidate
    await queueAutoAcceptJob(ctx, { libraryId });
    await queueAutoAcceptJob(ctx, { libraryId, mode: 'rules' });
    const taken = await db.select().from(albumMatches).where(eq(albumMatches.localAlbumId, id));
    expect(taken.filter((m: { releaseId: string }) => m.releaseId === rel.id)).toEqual([]);
  });

  it('edition.add scores a pasted release like a searched one and only adds it', async () => {
    const searched = heldForReview();
    const id = await album();
    await identifyAlbumJob(ctx, { localAlbumId: id });
    const before = await db.select().from(matchCandidates).where(eq(matchCandidates.localAlbumId, id));
    expect(before).toHaveLength(1);

    const pasted = mbRelease();
    catalogue.set(pasted.id, pasted);
    const res = await addEditionJob(ctx, { localAlbumId: id, target: { source: 'musicbrainz', mbid: pasted.id } });
    expect(res).toMatchObject({ ok: true, added: true });
    const cands = await db.select().from(matchCandidates).where(eq(matchCandidates.localAlbumId, id));
    expect(cands).toHaveLength(2);
    const added = cands.find((c: { id: string }) => res.ok && c.id === res.candidateId);
    expect(added.source).toBe('user_mbid');
    // a clean edition scores better than the searched one with the wrong artist
    expect(Number(added.distance)).toBeLessThan(Number(before[0].distance));
    expect((await stateOf(id)).state).toBe('needs_review');

    // pasting it again refreshes the same candidate instead of adding a twin
    const again = await addEditionJob(ctx, { localAlbumId: id, target: { source: 'musicbrainz', mbid: pasted.id } });
    expect(again).toMatchObject({ ok: true, added: false, candidateId: res.ok ? res.candidateId : '' });
    void searched;
  });

  it('edition.add never rewrites a linked app’s suggestion of the same release: the owner’s evidence goes beside it', async () => {
    heldForReview();
    const id = await album();
    await identifyAlbumJob(ctx, { localAlbumId: id });
    const pasted = mbRelease();
    catalogue.set(pasted.id, pasted);
    const first = await addEditionJob(ctx, { localAlbumId: id, target: { source: 'musicbrainz', mbid: pasted.id } });
    if (!first.ok) throw new Error('paste failed');
    // the linked app suggests that release; the owner's own candidate is gone (say, never pasted)
    await client`delete from match_candidates where id = ${first.candidateId}`;
    const mcBreakdown = { mc: { key: 'rg-key', service: 'review-gatherer', confidence: 0.9 } };
    const [mc] = await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source)
                              values (${id}, ${first.releaseId}, 0.1, ${JSON.stringify(mcBreakdown)}::text::jsonb, ${`mc:${randomUUID()}`}) returning id`;
    const res = await addEditionJob(ctx, { localAlbumId: id, target: { source: 'musicbrainz', mbid: pasted.id } });
    expect(res).toMatchObject({ ok: true, added: true, releaseId: first.releaseId });
    expect(res.ok && res.candidateId).not.toBe(mc.id);
    const [kept] = await client`select breakdown, distance::text as distance, source from match_candidates where id = ${mc.id}`;
    expect(typeof kept.breakdown === 'string' ? JSON.parse(kept.breakdown) : kept.breakdown).toEqual(mcBreakdown);
    expect(Number(kept.distance)).toBe(0.1);
    const own = await client`select source from match_candidates where local_album_id = ${id} and release_id = ${first.releaseId} order by source`;
    expect(own.map((r: { source: string }) => r.source.startsWith('mc:') ? 'mc' : r.source)).toEqual(['mc', 'user_mbid']);
    // pasting again refreshes the owner's candidate, still not the module's
    expect(await addEditionJob(ctx, { localAlbumId: id, target: { source: 'musicbrainz', mbid: pasted.id } }))
      .toMatchObject({ ok: true, added: false, candidateId: res.ok ? res.candidateId : '' });
  });

  it('edition.add explains an id the provider does not know', async () => {
    const id = await album('needs_review');
    expect(await addEditionJob(ctx, { localAlbumId: id, target: { source: 'musicbrainz', mbid: randomUUID() } }))
      .toEqual({ ok: false, message: 'MusicBrainz has no release with this ID. If it is a release group, open it and paste one of its releases.' });
    expect(await addEditionJob(ctx, { localAlbumId: id, target: { source: 'discogs', kind: 'release', id: 99 } }))
      .toEqual({ ok: false, message: 'Discogs has no release with this ID (99).' });
    expect(await addEditionJob(ctx, { localAlbumId: randomUUID(), target: { source: 'discogs', kind: 'release', id: 99 } }))
      .toMatchObject({ ok: false });
  });
});
