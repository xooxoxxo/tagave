/**
 * Review matches routes: auto-accept rules (read, save, validate), the dry
 * run behind "N of M albums in the queue would be accepted now", what the
 * rules accepted lately, and the paste field's input checks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import {
  albumMatches, libraries, localAlbums, localTracks, matchCandidates, releaseGroups, releases, users, files, scanRoots,
} from '@tagave/db';
import { DEFAULT_AUTO_ACCEPT_RULES } from '@tagave/shared';

describe.skipIf(!process.env.TEST_DATABASE_URL)('review matches routes', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const rgId = randomUUID();
  const releaseIds: string[] = [];
  const albumIds: string[] = [];

  const req = (method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown, as = ownerId) =>
    app.inject({ method, url, headers: { 'x-test-user': as }, ...(body !== undefined ? { payload: body as object } : {}) });

  async function release(over: Record<string, unknown> = {}) {
    const id = randomUUID();
    releaseIds.push(id);
    await db.insert(releases).values({ id, releaseGroupId: rgId, mbid: randomUUID(), title: 'Kosmonument', date: '2011-03-01', country: 'FI', status: 'Official', trackCount: 2, sourceOfTruth: 'musicbrainz', ...over });
    return id;
  }
  async function album(cands: Array<{ releaseId: string; distance: string }>, state = 'needs_review') {
    const id = randomUUID();
    albumIds.push(id);
    await db.insert(localAlbums).values({ id, libraryId, clusterKey: `k-${id}`, dirPaths: [`x/${id}`], titleGuess: 'Kosmonument', artistGuess: 'Oranssi Pazuzu', yearGuess: 2011, state, trackCount: 2 });
    for (let i = 1; i <= 2; i++) {
      const fileId = randomUUID();
      await db.insert(files).values({ handler: 'audio', id: fileId, libraryId, scanRootId: rootId, relPath: `${id}/${i}.flac`, sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
      await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, trackNo: i, titleGuess: `T${i}`, durationMs: 1000 });
    }
    for (const c of cands) {
      await db.insert(matchCandidates).values({ localAlbumId: id, releaseId: c.releaseId, distance: c.distance, breakdown: { album: 0, artist: 0, tracks: 0, trackTitle: 0, year: 0 }, source: 'mb_search' });
    }
    return id;
  }

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values([
      { id: ownerId, email: `owner-${ownerId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `stranger-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values({ id: libraryId, name: 'Review', ownerUserId: ownerId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: `/rv-${rootId}`, displayName: 'RV', writable: false });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Kosmonument', artistCredit: ['Oranssi Pazuzu'] });

    // the queue: two clean editions alone (97 %, 92 %), one with a rival a
    // point behind, one bootleg, and an album already decided
    await album([{ releaseId: await release(), distance: '0.0300' }]);
    await album([{ releaseId: await release(), distance: '0.0800' }]);
    await album([{ releaseId: await release(), distance: '0.0300' }, { releaseId: await release(), distance: '0.0400' }]);
    await album([{ releaseId: await release({ status: 'Bootleg' }), distance: '0.0100' }]);
    await album([{ releaseId: await release(), distance: '0.0100' }], 'matched');

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createReviewMatchesRoutes } = await import('./reviewMatches.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com` } as any) : undefined;
    });
    await app.register(createReviewMatchesRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    if (releaseIds.length) await db.delete(releases).where(inArray(releases.id, releaseIds));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(users).where(inArray(users.id, [ownerId, strangerId]));
    await client?.end({ timeout: 5 });
  });

  it('reads the defaults (off) before anything is saved', async () => {
    const res = await req('GET', `/libraries/${libraryId}/auto-accept`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rules: DEFAULT_AUTO_ACCEPT_RULES, updatedAt: null, recent: [], acceptedTotal: 0 });
  });

  it('dry run: counts the needs_review albums the given rules accept, nothing written', async () => {
    const preview = (rules: object) => req('POST', `/libraries/${libraryId}/auto-accept/preview`, { ...DEFAULT_AUTO_ACCEPT_RULES, ...rules });
    expect((await preview({})).json()).toEqual({ wouldAccept: 1, total: 4 });
    expect((await preview({ minMatch: 90 })).json()).toEqual({ wouldAccept: 2, total: 4 });
    expect((await preview({ minMatch: 90, clearWinnerGap: 0 })).json()).toEqual({ wouldAccept: 3, total: 4 });
    expect((await preview({ minMatch: 90, clearWinnerGap: 0, officialOnly: false })).json()).toEqual({ wouldAccept: 4, total: 4 });
    const live = await db.select().from(albumMatches).where(inArray(albumMatches.localAlbumId, albumIds));
    expect(live).toHaveLength(0);
  });

  it('saves the rules and refuses invalid ones with a plain reason', async () => {
    const saved = await req('PUT', `/libraries/${libraryId}/auto-accept`, { ...DEFAULT_AUTO_ACCEPT_RULES, enabled: true, minMatch: 92, preferSource: 'musicbrainz' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().rules).toEqual({ ...DEFAULT_AUTO_ACCEPT_RULES, enabled: true, minMatch: 92, preferSource: 'musicbrainz' });
    expect(saved.json().updatedAt).toEqual(expect.any(String));
    expect((await req('GET', `/libraries/${libraryId}/auto-accept`)).json().rules.minMatch).toBe(92);

    const bad = await req('PUT', `/libraries/${libraryId}/auto-accept`, { ...DEFAULT_AUTO_ACCEPT_RULES, minMatch: 30 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toMatch(/^minMatch: /);
    expect((await req('POST', `/libraries/${libraryId}/auto-accept/preview`, { enabled: true })).statusCode).toBe(400);
  });

  it('lists what the rules accepted (the audit rows), newest first', async () => {
    const decided = albumIds[4]!;
    const rel = releaseIds[releaseIds.length - 1]!;
    await db.insert(albumMatches).values({ libraryId, localAlbumId: decided, releaseId: rel, distance: '0.0100', status: 'auto', decidedBy: 'system', reason: 'auto-accept rules: 99% match (MusicBrainz)' });
    await db.insert(albumMatches).values({ libraryId, localAlbumId: decided, releaseId: rel, distance: '0.0100', status: 'rejected', decidedBy: 'system', reason: 'chip-rule auto-accept: 5 green' });
    const view = (await req('GET', `/libraries/${libraryId}/auto-accept`)).json();
    expect(view.acceptedTotal).toBe(1);
    expect(view.recent).toEqual([expect.objectContaining({ albumId: decided, title: 'Kosmonument', percent: 99 })]);
  });

  it('finds no unknown library or album (every library on the install is shared, 0043)', async () => {
    const unknown = randomUUID();
    expect((await req('GET', `/libraries/${unknown}/auto-accept`, undefined, strangerId)).statusCode).toBe(404);
    expect((await req('POST', `/libraries/${unknown}/auto-accept/preview`, DEFAULT_AUTO_ACCEPT_RULES, strangerId)).statusCode).toBe(404);
    expect((await req('POST', `/albums/${randomUUID()}/editions`, { input: `https://musicbrainz.org/release/${randomUUID()}` }, strangerId)).statusCode).toBe(404);
  });

  it('paste field: says what is wrong with the input before any lookup', async () => {
    const post = (input: unknown) => req('POST', `/albums/${albumIds[0]}/editions`, { input });
    const empty = await post('');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().detail).toBe('Paste a MusicBrainz or Discogs release URL or ID.');
    expect((await post('hotel costes')).statusCode).toBe(400);
    expect((await post(`https://musicbrainz.org/artist/${randomUUID()}`)).json().detail).toMatch(/artist page/);
    const rg = await post(`https://musicbrainz.org/release-group/${randomUUID()}`);
    expect(rg.statusCode).toBe(400);
    expect(rg.json().detail).toMatch(/release group/);
    expect((await post(42)).statusCode).toBe(400);
  });
});
