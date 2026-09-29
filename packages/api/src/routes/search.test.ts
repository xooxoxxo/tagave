/**
 * ⌘K search ranking and artist results, through the real route against the
 * test database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { artists, audioFiles, libraries, localAlbums, localTracks, releaseGroupArtists, releaseGroups, scanRoots, users } from '@liner/db';
import { foldWords } from './search.js';

describe('foldWords', () => {
  it('folds punctuation and case to single spaces', () => {
    expect(foldWords('  Road-Salt  (One) ')).toBe('road salt one');
    expect(foldWords('Sigur Rós')).toBe('sigur rós');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('search route', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const rgId = randomUUID();
  const artistId = randomUUID();

  const album = (title: string, artist: string | null, releaseGroupId: string | null = null) => ({
    id: randomUUID(), libraryId, clusterKey: `k-${randomUUID()}`, dirPaths: [title],
    state: 'matched', titleGuess: title, artistGuess: artist, releaseGroupId,
  });

  const search = async (q: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/libraries/${libraryId}/search?q=${encodeURIComponent(q)}`,
      headers: { 'x-test-user': ownerId },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      albums: { title: string }[];
      artists: { id: string | null; name: string; albumCount: number }[];
      tracks: { title: string; artist: string | null; albumTitle: string }[];
    };
  };

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;

    await db.insert(users).values({ id: ownerId, email: `search-${ownerId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Search', ownerUserId: ownerId, settings: {} });
    await db.insert(artists).values({ id: artistId, name: 'Pain of Salvation', sortName: 'Pain of Salvation' });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Road Salt One' });
    await db.insert(releaseGroupArtists).values({ releaseGroupId: rgId, artistId, position: 0 });
    await db.insert(localAlbums).values([
      album('Salva', 'Someone'),
      album('Saliva Sessions', 'Another'),
      album('Road Salt Two', 'Pain of Salvation'),
      album('Road Salt One', 'Pain of Salvation', rgId),
      album('Sea Salt Songs', 'Salt Cellar'),
      album('Salty Dog', 'Procol Harum'),
    ]);
    // A compilation: the album artist is Various Artists, each track its own.
    const rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/search-root', displayName: 's', validationStatus: 'ok' });
    const comp = album('Late Night Tales', 'Various Artists');
    await db.insert(localAlbums).values(comp);
    for (const [title, artist] of [['Nights Interlude', 'Nightmares on Wax'], ['Teardrop', 'Massive Attack'], ['Opener', null]] as const) {
      const fileId = randomUUID();
      await db.insert(audioFiles).values({ id: fileId, libraryId, scanRootId: rootId, relPath: `${title}.flac`, status: 'present' });
      await db.insert(localTracks).values({ localAlbumId: comp.id, audioFileId: fileId, trackNo: 1, titleGuess: title, artistGuess: artist });
    }

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createSearchRoutes } = await import('./search.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com` } as any) : undefined;
    });
    await app.register(createSearchRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.releaseGroupId, rgId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(artists).where(inArray(artists.id, [artistId]));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, ownerId));
    await client?.end({ timeout: 5 });
  });

  it('ranks the exact-prefix title first', async () => {
    const { albums } = await search('road salt');
    expect(albums.map((a) => a.title).slice(0, 2)).toEqual(['Road Salt One', 'Road Salt Two']);
  });

  it('puts whole-word matches above fuzzy ones', async () => {
    const titles = (await search('salt')).albums.map((a) => a.title);
    const firstFuzzy = Math.min(...['Salva', 'Saliva Sessions'].map((t) => titles.indexOf(t)).filter((i) => i >= 0));
    for (const exact of ['Road Salt One', 'Road Salt Two', 'Sea Salt Songs']) {
      expect(titles).toContain(exact);
      if (Number.isFinite(firstFuzzy)) expect(titles.indexOf(exact)).toBeLessThan(firstFuzzy);
    }
    // a whole-word match outranks a title that only starts with the letters
    expect(titles.indexOf('Road Salt One')).toBeLessThan(titles.indexOf('Salty Dog'));
    expect(titles.indexOf('Salty Dog')).toBeLessThan(firstFuzzy);
  });

  it('returns canonical and tag-only artists, without duplicating a canonical name', async () => {
    const found = (await search('salva')).artists;
    const pos = found.filter((a) => a.name === 'Pain of Salvation');
    expect(pos).toHaveLength(1);
    expect(pos[0]!.id).toBe(artistId);

    const tagOnly = (await search('salt cellar')).artists;
    expect(tagOnly[0]).toMatchObject({ id: null, name: 'Salt Cellar', albumCount: 1 });
  });

  it('finds compilation tracks by their own artist and names that artist', async () => {
    const { tracks } = await search('massive attack');
    expect(tracks[0]).toMatchObject({ title: 'Teardrop', artist: 'Massive Attack', albumTitle: 'Late Night Tales' });
    const typo = await search('nightmares on wx');
    expect(typo.tracks.map((t) => t.title)).toContain('Nights Interlude');
  });

  it('falls back to the album artist for a track without its own', async () => {
    const { tracks } = await search('opener');
    expect(tracks[0]).toMatchObject({ title: 'Opener', artist: 'Various Artists' });
  });

  it('treats LIKE wildcards in the query literally', async () => {
    const { albums, artists: found } = await search('%_%');
    expect(albums).toEqual([]);
    expect(found).toEqual([]);
  });
});
