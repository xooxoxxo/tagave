/**
 * evidence.backfill: albums identified before evidence was kept get it from
 * their stored candidates, re-scored offline. Albums in review whose release
 * data was never stored are identified again; a hand-decided album never is,
 * and an album matched automatically is left alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { files, libraries, localAlbums, localTracks, scanRoots, users, makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import type { EvidenceBackfillResult } from './evidenceBackfill.js';

// A release titled BOOM makes the evidence builder throw, the way it does on
// an alignment that does not fit the tracklists.
const BOOM = 'Boom Album';
vi.mock('@tagave/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@tagave/core')>();
  return {
    ...core,
    buildCandidateEvidence: (...args: Parameters<typeof core.buildCandidateEvidence>) => {
      if (args[0].title === BOOM) throw new RangeError('evidence: test failure');
      return core.buildCandidateEvidence(...args);
    },
  };
});
const { evidenceBackfillJob } = await import('./evidenceBackfill.js');

const TITLES = ['Ilta', 'Aamu'];
const STALE = '0.9999';

describe.skipIf(!process.env.TEST_DATABASE_URL)('evidence.backfill (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const send = vi.fn();
  const userId = randomUUID();
  const lib = randomUUID();
  const rootId = randomUUID();
  const groups: string[] = [];
  let albumA: string, albumB: string, albumC: string, albumD: string;
  let first: EvidenceBackfillResult;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  // mock call lists as they stood right after the first pass
  let firstSends: unknown[][];
  let firstFetches: number;

  async function album(state: string): Promise<string> {
    const id = randomUUID();
    await db.insert(localAlbums).values({
      id, libraryId: lib, clusterKey: `bf-${id}`, dirPaths: [`bf/${id}`], state,
      titleGuess: 'Backfill Album', titleSource: 'tag', artistGuess: 'Backfill Artist',
      yearGuess: 2012, yearSource: 'tag', trackCount: TITLES.length,
    });
    for (const [i, title] of TITLES.entries()) {
      const fileId = randomUUID();
      await db.insert(files).values({ handler: 'audio', id: fileId, libraryId: lib, scanRootId: rootId, relPath: `${id}/${i}.flac`, sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
      await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, trackNo: i + 1, titleGuess: title, titleSource: 'tag', durationMs: 200_000 });
    }
    return id;
  }
  /** a stored release; `tracks: false` leaves out its tracklist (never stored) */
  async function release(tracks = true): Promise<string> {
    const [rg] = await client`insert into release_groups (mbid, title, artist_credit) values (${randomUUID()}, 'Backfill Album', '["Backfill Artist"]'::jsonb) returning id`;
    groups.push(rg.id);
    const [rel] = await client`insert into releases (release_group_id, mbid, title, status, track_count, labels, source_of_truth)
                               values (${rg.id}, ${randomUUID()}, 'Backfill Album', 'Official', 2, '[{"name":"Label Oy","catalogNumber":"LBL 1"}]'::jsonb, 'musicbrainz')
                               returning id`;
    if (tracks) {
      for (const [i, title] of TITLES.entries()) {
        await client`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values (${rel.id}, 1, ${i + 1}, ${title}, 200000)`;
      }
    }
    return rel.id;
  }
  /** a candidate as identification stored it before evidence existed */
  async function candidate(albumId: string, releaseId: string, source = 'mb_search'): Promise<void> {
    await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source)
                 values (${albumId}, ${releaseId}, ${STALE}, '{}'::jsonb, ${source})`;
  }
  async function liveMatch(albumId: string, releaseId: string, decidedBy: 'user' | 'system'): Promise<void> {
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by)
                 values (${lib}, ${albumId}, ${releaseId}, 0.1, ${decidedBy === 'user' ? 'confirmed' : 'auto'}, ${decidedBy})`;
  }

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    // no contact string in the settings: a provider call would throw
    await db.insert(users).values({ id: userId, email: `bf-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: lib, name: 'Backfill', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId: lib, path: `/bf-${rootId}`, displayName: 'BF', writable: false });

    albumA = await album('needs_review');
    await candidate(albumA, await release());
    albumB = await album('needs_review');
    await candidate(albumB, await release(false));
    albumC = await album('matched');
    const relC = await release();
    await candidate(albumC, relC);
    await liveMatch(albumC, relC, 'user');
    albumD = await album('matched');
    const relD = await release();
    await candidate(albumD, relD);
    await liveMatch(albumD, relD, 'system');

    // spied before the first pass, the one that does the work
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    first = await evidenceBackfillJob(ctx, { libraryId: lib });
    firstSends = send.mock.calls.map((c) => [...c]);
    firstFetches = fetchSpy.mock.calls.length;
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, lib));
    await db.delete(libraries).where(eq(libraries.id, lib));
    await db.delete(users).where(eq(users.id, userId));
    await client`delete from releases where release_group_id = any(${groups}::uuid[])`;
    await client`delete from release_groups where id = any(${groups}::uuid[])`;
    await client.end({ timeout: 5 });
  });

  it('re-scores from stored rows and writes evidence with the distance it scored', async () => {
    expect(first.rescored).toBe(2); // A and C
    const [a] = await client`select evidence, distance::text from match_candidates where local_album_id = ${albumA}`;
    expect(a.evidence.v).toBe(1);
    expect(a.distance).not.toBe(STALE);
    expect(a.evidence.align.map((t: number[]) => [t[0], t[1]])).toEqual([[0, 0], [1, 1]]);
    expect(a.evidence.remote).toMatchObject({ label: 'Label Oy', catalogNumber: 'LBL 1', status: 'Official' });
    expect((await client`select 1 from album_evidence where local_album_id = ${albumA}`)).toHaveLength(1);
    const [c] = await client`select evidence from match_candidates where local_album_id = ${albumC}`;
    expect(c.evidence.v).toBe(1);
  });

  it("re-identifies a review album whose release data is missing, at the sweep's priority", async () => {
    expect(first.reidentify).toBe(1);
    expect(firstSends).toContainEqual(['identify.album', { localAlbumId: albumB, force: true }, { singletonKey: `identify:${albumB}`, priority: 0 }]);
    const [b] = await client`select evidence, distance::text from match_candidates where local_album_id = ${albumB}`;
    expect(b).toEqual({ evidence: null, distance: STALE });
  });

  it('never re-identifies or re-scores an album matched automatically', async () => {
    expect(firstSends.some((c: any) => c[1]?.localAlbumId === albumD)).toBe(false);
    const [d] = await client`select evidence, distance::text from match_candidates where local_album_id = ${albumD}`;
    expect(d).toEqual({ evidence: null, distance: STALE });
  });

  it('makes no network call', () => {
    expect(firstFetches).toBe(0);
  });

  it('is idempotent', async () => {
    const r = await evidenceBackfillJob(ctx, { libraryId: lib });
    expect(r).toMatchObject({ rescored: 0, more: false });
  });

  it('leaves a linked app\'s suggestions as they were', async () => {
    const albumE = await album('needs_review');
    const rel = await release();
    await candidate(albumE, rel);
    const mcSource = `mc:${randomUUID()}`;
    await candidate(albumE, rel, mcSource);
    await evidenceBackfillJob(ctx, { libraryId: lib });
    const rows = await client`select source, evidence, distance::text from match_candidates where local_album_id = ${albumE} order by source`;
    expect(rows.find((r: any) => r.source === mcSource)).toMatchObject({ evidence: null, distance: STALE });
    expect(rows.find((r: any) => r.source === 'mb_search').evidence.v).toBe(1);
  });

  it('a hand-decided album without stored tracks is left, not re-identified', async () => {
    const albumF = await album('matched');
    const rel = await release(false);
    await candidate(albumF, rel);
    await liveMatch(albumF, rel, 'user');
    send.mockClear();
    const r = await evidenceBackfillJob(ctx, { libraryId: lib });
    expect(r.left).toBeGreaterThanOrEqual(1);
    expect(send.mock.calls.some((c) => c[1]?.localAlbumId === albumF)).toBe(false);
  });

  it('walks the library in passes, each sending the next with where it stopped', async () => {
    const ids = [await album('needs_review'), await album('needs_review'), await album('needs_review')];
    for (const id of ids) await candidate(id, await release());
    send.mockClear();
    const r = await evidenceBackfillJob(ctx, { libraryId: lib, limit: 1 });
    expect(r.more).toBe(true);
    const next = send.mock.calls.find((c) => c[0] === 'evidence.backfill');
    expect(next).toBeDefined();
    expect(next![2]).toEqual({ singletonKey: 'evidence.backfill' });
    expect(next![1]).toMatchObject({ libraryId: lib, limit: 1 });
    expect(typeof next![1].afterId).toBe('string');
    // follow the chain to its end: every album ends with evidence, and an
    // album left without it (B re-identified, F hand-decided) is not picked twice
    let data = next![1];
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      send.mockClear();
      const step = await evidenceBackfillJob(ctx, data);
      if (!step.more) break;
      data = send.mock.calls.find((c) => c[0] === 'evidence.backfill')![1];
      seen.push(data.afterId);
    }
    expect(new Set(seen).size).toBe(seen.length);
    const missing = await client`select count(*)::int as n from match_candidates where local_album_id = any(${ids}::uuid[]) and evidence is null`;
    expect(missing[0].n).toBe(0);
  });

  it('an album whose evidence cannot be built fails alone; the pass goes on', async () => {
    const bad = await album('needs_review');
    const good = await album('needs_review');
    const [rg] = await client`insert into release_groups (mbid, title) values (${randomUUID()}, ${BOOM}) returning id`;
    groups.push(rg.id);
    const [rel] = await client`insert into releases (release_group_id, mbid, title, track_count) values (${rg.id}, ${randomUUID()}, ${BOOM}, 2) returning id`;
    await client`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values (${rel.id}, 1, 1, 'Ilta', 200000), (${rel.id}, 1, 2, 'Aamu', 200000)`;
    await candidate(bad, rel.id);
    await candidate(good, await release());
    const r = await evidenceBackfillJob(ctx, { libraryId: lib });
    expect(r.failed).toBe(1);
    expect(r.rescored).toBeGreaterThanOrEqual(1);
    const [g] = await client`select evidence from match_candidates where local_album_id = ${good}`;
    expect(g.evidence.v).toBe(1);
    const [b] = await client`select evidence from match_candidates where local_album_id = ${bad}`;
    expect(b.evidence).toBeNull();
    expect(await client`select 1 from album_evidence where local_album_id = ${bad}`).toHaveLength(0);
  });
});
