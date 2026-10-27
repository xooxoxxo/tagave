/**
 * Match evidence in the database: what identification stores (album evidence
 * once per album, candidate evidence and AcoustID coverage per candidate), and
 * what may be loaded to leave the server (no excluded candidates, no linked-app
 * suggestions).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import {
  buildAlbumEvidence, buildCandidateEvidence, type CanonicalRelease,
} from '@tagave/core';
import { files, libraries, localAlbums, localTracks, scanRoots, users, makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';

const catalogue = new Map<string, CanonicalRelease>();
const notFound = Object.assign(new Error('not found'), { status: 404 });
const fakeProviders = {
  mb: {
    searchReleases: async () => [],
    getRelease: async (id: string) => {
      const r = catalogue.get(id);
      if (!r) throw notFound;
      return r;
    },
  },
  discogs: {
    authenticated: false,
    searchReleases: async () => [],
    getRelease: async () => { throw notFound; },
    getMaster: async () => { throw notFound; },
  },
};

vi.mock('./providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers.js')>()),
  libraryProviderSettings: async () => ({}),
  getProviders: () => fakeProviders,
  mbCall: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  discogsCall: (_ctx: unknown, _p: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./providerCache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerCache.js')>()),
  cached: (_sql: unknown, _provider: unknown, _key: unknown, _ttl: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { upsertAlbumEvidence, loadEvidence, currentEvidenceHash, remoteInputOf } = await import('./evidenceStore.js');
const { identifyAlbumJob } = await import('../jobs/identifyAlbum.js');
const { addEditionJob } = await import('../jobs/addEdition.js');

const TITLES = ['Ilta', 'Aamu'];

function mbRelease(over: Partial<CanonicalRelease> = {}): CanonicalRelease {
  return {
    id: randomUUID(),
    releaseGroupId: randomUUID(),
    title: 'Evidence Album',
    artists: ['Evidence Artist'],
    tracks: TITLES.map((title, i) => ({ title, artists: [], duration: 200_000, position: i + 1, mediumNumber: 1 })),
    year: 2012,
    country: 'FI',
    status: 'Official',
    labels: [{ name: 'Label Oy', catalogNumber: 'LBL 1' }],
    source: 'musicbrainz',
    ...over,
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('match evidence store (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const releaseMbids: string[] = [];

  async function album(): Promise<string> {
    const id = randomUUID();
    await db.insert(localAlbums).values({
      id, libraryId, clusterKey: `ev-${id}`, dirPaths: [`ev/${id}`], state: 'pending',
      titleGuess: 'Evidence Album', titleSource: 'tag', artistGuess: 'Evidence Artist',
      yearGuess: 2012, yearSource: 'tag', trackCount: TITLES.length,
    });
    for (const [i, title] of TITLES.entries()) {
      const fileId = randomUUID();
      await db.insert(files).values({ handler: 'audio', id: fileId, libraryId, scanRootId: rootId, relPath: `${id}/${i}.flac`, sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
      await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, trackNo: i + 1, titleGuess: title, titleSource: 'tag', durationMs: 200_000 });
    }
    return id;
  }
  async function release(): Promise<string> {
    const mbid = randomUUID();
    releaseMbids.push(mbid);
    const [rg] = await client`insert into release_groups (mbid, title) values (${randomUUID()}, 'Evidence Album') returning id`;
    const [rel] = await client`insert into releases (release_group_id, mbid, title, status, track_count) values (${rg.id}, ${mbid}, 'Evidence Album', 'Official', 2) returning id`;
    return rel.id;
  }

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: vi.fn(async () => 'job') } as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: userId, email: `ev-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Evidence', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: `/ev-${rootId}`, displayName: 'EV', writable: false });
  });

  afterAll(async () => {
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    const mbids = [...releaseMbids, ...[...catalogue.values()].map((r) => r.id)];
    await client`delete from release_groups where id in (select release_group_id from releases where mbid = any(${mbids}::text[]))`;
    await client.end({ timeout: 5 });
  });

  describe('stored evidence', () => {
    let albumId: string;
    const albumEv = buildAlbumEvidence({
      artist: 'Evidence Artist', title: 'Evidence Album', titleSource: 'tag', year: 2012, yearSource: 'tag',
      discsKnown: false, discCount: null,
      tracks: TITLES.map((title) => ({ title, titleSource: 'tag' as const, duration: 200 })),
    });
    const candEv = buildCandidateEvidence(
      { source: 'musicbrainz', title: 'Evidence Album', artists: ['Evidence Artist'], tracks: TITLES.map((title) => ({ title, duration: 200 })) },
      { alignment: TITLES.map((title, i) => ({ localIndex: i, canonicalIndex: i, distance: 0, title: { local: title }, duration: { local: 200 } })), missingRemote: [] },
      TITLES.length,
    );

    beforeAll(async () => {
      albumId = await album();
      const searched = await release();
      const excluded = await release();
      const linked = await release();
      const ev = JSON.stringify(candEv);
      await client`insert into match_candidates (local_album_id, release_id, distance, source, evidence, acoustid_coverage)
                   values (${albumId}, ${searched}, 0.1, 'mb_search', ${ev}::text::jsonb, 0.5)`;
      await client`insert into match_candidates (local_album_id, release_id, distance, source, evidence, excluded)
                   values (${albumId}, ${excluded}, 0.2, 'mb_search_excluded', ${ev}::text::jsonb, true)`;
      await client`insert into match_candidates (local_album_id, release_id, distance, source, evidence)
                   values (${albumId}, ${linked}, 0, ${`mc:${randomUUID()}`}, ${ev}::text::jsonb)`;
      await upsertAlbumEvidence(client, albumId, albumEv);
    });

    it('loads only what may be sent: no excluded and no linked-app candidates', async () => {
      const ev = await loadEvidence(client, albumId);
      expect(ev!.candidates.map((c) => c.source)).toEqual(['mb_search']);
      expect(ev!.album.tracks).toHaveLength(2);
    });

    it('reads numbers back as numbers and the album as it was stored', async () => {
      const ev = (await loadEvidence(client, albumId))!;
      expect(ev.album).toEqual(albumEv);
      expect(ev.libraryId).toBe(libraryId);
      expect(ev.state).toBe('pending');
      expect(ev.lastIdentifyAt).toBeNull();
      const [c] = ev.candidates;
      expect(c!.distance).toBe(0.1);
      expect(c!.acoustidCoverage).toBe(0.5);
      expect(c!.provider).toBe('musicbrainz');
      expect(c!.status).toBe('Official');
      expect(c!.evidence).toEqual(candEv);
    });

    it('a second upsert replaces the album evidence', async () => {
      const other = { ...albumEv, title: 'Renamed' };
      await upsertAlbumEvidence(client, albumId, other);
      expect((await loadEvidence(client, albumId))!.album.title).toBe('Renamed');
      await upsertAlbumEvidence(client, albumId, albumEv);
      const rows = await client`select count(*)::int as n from album_evidence where local_album_id = ${albumId}`;
      expect(rows[0].n).toBe(1);
    });

    it('the hash moves when the owner excludes a candidate', async () => {
      const before = await currentEvidenceHash(client, albumId);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      await client`update match_candidates set excluded = true where local_album_id = ${albumId} and source = 'mb_search'`;
      expect(await currentEvidenceHash(client, albumId)).not.toBe(before);
      await client`update match_candidates set excluded = false where local_album_id = ${albumId} and source = 'mb_search'`;
      expect(await currentEvidenceHash(client, albumId)).toBe(before);
    });

    it('no album evidence, no hash', async () => {
      expect(await currentEvidenceHash(client, randomUUID())).toBeNull();
      expect(await loadEvidence(client, randomUUID())).toBeNull();
    });
  });

  describe('remoteInputOf', () => {
    it('reads label and catalog number from the first label, durations in seconds, media numbers', () => {
      const r = mbRelease({ tracks: [{ title: 'A', artists: [], duration: 61_500, position: 1, mediumNumber: 2 }] });
      const input = remoteInputOf(r, null);
      expect(input).toMatchObject({
        source: 'musicbrainz', label: 'Label Oy', catalogNumber: 'LBL 1', status: 'Official', year: 2012, country: 'FI', mediumCount: 2,
        tracks: [{ title: 'A', duration: 61.5, medium: 2 }],
      });
    });
    it('falls back to the stored status and leaves unknown fields out', () => {
      const r = mbRelease({ status: undefined, labels: undefined, year: undefined, country: undefined, tracks: [] });
      const input = remoteInputOf(r, 'Bootleg');
      expect(input.status).toBe('Bootleg');
      expect('label' in input).toBe(false);
      expect('year' in input).toBe(false);
      expect('mediumCount' in input).toBe(false);
    });
  });

  describe('identification', () => {
    it('stores candidate evidence, AcoustID coverage and the album evidence', async () => {
      const r = mbRelease();
      catalogue.set(r.id, r);
      const albumId = await album();
      await identifyAlbumJob(ctx, { localAlbumId: albumId, acoustidMbids: [r.id], acoustidCoverage: { [r.id]: 0.5 } });

      const rows = await client`select evidence, acoustid_coverage::float as cov from match_candidates where local_album_id = ${albumId}`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: any) => r.evidence?.v === 1)).toBe(true);
      expect(rows.find((r: any) => r.cov !== null)?.cov).toBe(0.5);
      const [ae] = await client`select v, evidence from album_evidence where local_album_id = ${albumId}`;
      expect(ae.v).toBe(1);
      expect(ae.evidence.tracks.map((t: any) => t.titleSource)).toEqual(['tag', 'tag']);
      expect(ae.evidence.titleSource).toBe('tag');
      expect(ae.evidence.yearSource).toBe('tag');

      const ev = (await loadEvidence(client, albumId))!;
      const [c] = ev.candidates;
      expect(c!.evidence!.remote).toMatchObject({ provider: 'musicbrainz', label: 'Label Oy', catalogNumber: 'LBL 1', status: 'Official' });
      expect(c!.evidence!.align.map((t) => [t[0], t[1]])).toEqual([[0, 0], [1, 1]]);
      expect(c!.evidence!.tracks).toEqual([[1, 'Ilta', 200], [1, 'Aamu', 200]]);
    });

    it('a pasted edition stores its evidence, and pasting it again refreshes it', async () => {
      const albumId = await album();
      const pasted = mbRelease({ title: 'Evidence Album (Deluxe)' });
      catalogue.set(pasted.id, pasted);
      const res = await addEditionJob(ctx, { localAlbumId: albumId, target: { source: 'musicbrainz', mbid: pasted.id } });
      expect(res).toMatchObject({ ok: true, added: true });
      const [first] = await client`select evidence, acoustid_coverage from match_candidates where local_album_id = ${albumId}`;
      expect(first.evidence.v).toBe(1);
      expect(first.evidence.remote.title).toBe('Evidence Album (Deluxe)');
      expect(first.acoustid_coverage).toBeNull();
      expect((await client`select 1 from album_evidence where local_album_id = ${albumId}`).length).toBe(1);

      // the provider now lists the release under another title: the refresh rewrites the evidence
      catalogue.set(pasted.id, { ...pasted, title: 'Evidence Album (Remaster)' });
      await client`update match_candidates set evidence = null where local_album_id = ${albumId}`;
      const again = await addEditionJob(ctx, { localAlbumId: albumId, target: { source: 'musicbrainz', mbid: pasted.id } });
      expect(again).toMatchObject({ ok: true, added: false });
      const [second] = await client`select evidence from match_candidates where local_album_id = ${albumId}`;
      expect(second.evidence.remote.title).toBe('Evidence Album (Remaster)');
    });
  });
});
