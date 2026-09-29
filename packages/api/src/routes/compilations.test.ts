/**
 * Compilation tools through the real routes (fastify.inject, test database):
 * manual tag plans (values, folder scope, validation), the bulk editor's
 * suggestions, "Treat as one album" and split back, and how numbered and
 * VA album artists show in the album and artist lists. pg-boss never runs:
 * sends are recorded.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import {
  audioFiles, clusterOverrides, libraries, localAlbums, localTracks, scanRoots, tagPlans, users,
} from '@liner/db';

const sent = vi.hoisted(() => [] as Array<{ name: string; data: any; opts: any }>);
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return 'job-id'; },
  }),
}));

describe.skipIf(!process.env.TEST_DATABASE_URL)('compilation routes', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const otherLibraryId = randomUUID();
  const rootId = randomUUID();
  const pieces = [randomUUID(), randomUUID(), randomUUID()];
  const vaAlbums = [randomUUID(), randomUUID()];
  const foreignAlbum = randomUUID();
  const artists = ['Lena Horne', 'Morten Varano', 'Vanessa Da Mata'];
  const dirOf = (i: number) => `#/0${i + 1}. Stephane Pompougnac/2008 - Hotel Costes Vol. 11`;

  const as = (user: string | null) => (user ? { 'x-test-user': user } : {});
  const post = (url: string, payload: unknown, user: string | null = ownerId) =>
    app.inject({ method: 'POST', url, headers: as(user), payload: payload as any });
  const get = (url: string, user: string | null = ownerId) => app.inject({ method: 'GET', url, headers: as(user) });

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;
    // the album page reads when a queued identify job was created and started
    await client`alter table pgboss.job add column if not exists created_on timestamptz, add column if not exists started_on timestamptz`;

    await db.insert(users).values([
      { id: ownerId, email: `comp-${ownerId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `comp-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values([
      { id: libraryId, name: 'Compilations', ownerUserId: ownerId, settings: {} },
      { id: otherLibraryId, name: 'Other', ownerUserId: strangerId, settings: {} },
    ]);
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/comp-root', displayName: 'comp', writable: true, validationStatus: 'ok' });
    await db.insert(localAlbums).values([
      ...pieces.map((id, i) => ({
        id, libraryId, clusterKey: `piece-${id}`, dirPaths: [dirOf(i)], titleGuess: 'Hotel Costes Vol. 11',
        artistGuess: `0${i + 1}. Stephane Pompougnac`, yearGuess: 2008, state: 'unidentified', trackCount: 1, createdAt: new Date(Date.now() + i),
      })),
      { id: vaAlbums[0]!, libraryId, clusterKey: `va0-${vaAlbums[0]}`, dirPaths: ['V/One'], titleGuess: 'Mix One', artistGuess: 'Various', state: 'matched', trackCount: 10 },
      { id: vaAlbums[1]!, libraryId, clusterKey: `va1-${vaAlbums[1]}`, dirPaths: ['V/Two'], titleGuess: 'Mix Two', artistGuess: 'VA', state: 'matched', trackCount: 12 },
      { id: foreignAlbum, libraryId: otherLibraryId, clusterKey: `f-${foreignAlbum}`, dirPaths: ['F'], state: 'matched' },
    ]);
    for (const [i, albumId] of pieces.entries()) {
      const fileId = randomUUID();
      await db.insert(audioFiles).values({
        id: fileId, libraryId, scanRootId: rootId, relPath: `${dirOf(i)}/0${i + 1} - T.mp3`, sizeBytes: 1, mtime: 1, status: 'present', durationMs: 1000,
        tagsRaw: { common: { artist: artists[i], albumartist: `0${i + 1}. Stephane Pompougnac`, album: 'Hotel Costes Vol. 11', year: 2008, track: { no: i + 1, of: null } } },
      });
      await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: fileId, trackNo: i + 1, artistGuess: artists[i], durationMs: 1000 });
    }

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createTagPlansRoutes } = await import('./tagPlans.js');
    const { createAlbumRoutes } = await import('./albums.js');
    const { createArtistsRoutes } = await import('./artists.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com` } as any) : undefined;
    });
    await app.register(createTagPlansRoutes, { prefix: '/libraries/:libraryId' });
    await app.register(createAlbumRoutes);
    await app.register(createArtistsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(tagPlans).where(eq(tagPlans.libraryId, libraryId));
    await db.delete(clusterOverrides).where(eq(clusterOverrides.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(localAlbums).where(inArray(localAlbums.libraryId, [libraryId, otherLibraryId]));
    await db.delete(libraries).where(inArray(libraries.id, [libraryId, otherLibraryId]));
    await db.delete(users).where(inArray(users.id, [ownerId, strangerId]));
    await client?.end({ timeout: 5 });
  });

  const manual = (values: unknown) => ({ preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ', values });

  it('lists the numbered album artists as one artist and the VA spellings as one row', async () => {
    const res = await get(`/libraries/${libraryId}/artists`);
    expect(res.statusCode).toBe(200);
    const names = res.json().items.map((a: { name: string; albumCount: number }) => `${a.name}:${a.albumCount}`);
    expect(names).toEqual(['Stephane Pompougnac:3', 'Various Artists:2']);

    const list = await get(`/libraries/${libraryId}/albums?artist=${encodeURIComponent('Stephane Pompougnac')}`);
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ id: string; artistCredit: string }>;
    expect(items.map((a) => a.id).sort()).toEqual([...pieces].sort());
    expect(new Set(items.map((a) => a.artistCredit))).toEqual(new Set(['Stephane Pompougnac']));
  });

  it('suggests values for a selection and for a folder; refuses what it cannot edit', async () => {
    const res = await post(`/libraries/${libraryId}/tag-edit/suggest`, { scope: { type: 'albumIds', albumIds: pieces } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toBe(3);
    expect(body.suggested).toMatchObject({ albumartist: 'Stephane Pompougnac', album: 'Hotel Costes Vol. 11', compilation: '1', date: '2008' });

    const folder = await post(`/libraries/${libraryId}/tag-edit/suggest`, { scope: { type: 'folder', dirPath: '#/02. Stephane Pompougnac' } });
    expect(folder.statusCode).toBe(200);
    expect(folder.json().albumIds).toEqual([pieces[1]]);

    expect((await post(`/libraries/${libraryId}/tag-edit/suggest`, { scope: { type: 'library' } })).statusCode).toBe(400);
    expect((await post(`/libraries/${libraryId}/tag-edit/suggest`, { scope: { type: 'albumIds', albumIds: [foreignAlbum] } })).statusCode).toBe(404);
    expect((await post(`/libraries/${libraryId}/tag-edit/suggest`, { scope: { type: 'albumIds', albumIds: pieces } }, strangerId)).statusCode).toBe(404);
  });

  it('creates a manual plan; a folder scope resolves to its albums', async () => {
    const res = await post(`/libraries/${libraryId}/tag-plans`, {
      name: 'Hotel Costes', scope: { type: 'albumIds', albumIds: pieces }, policy: manual({ albumartist: 'Various Artists', compilation: '1' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().policy).toMatchObject({ preset: 'manual', values: { albumartist: 'Various Artists', compilation: '1' } });

    const byFolder = await post(`/libraries/${libraryId}/tag-plans`, {
      name: 'Folder', scope: { type: 'folder', dirPath: '#/' }, policy: manual({ genre: ['Lounge'] }),
    });
    expect(byFolder.statusCode).toBe(201);
    expect([...byFolder.json().scope.albumIds].sort()).toEqual([...pieces].sort());
  });

  it('refuses manual plans without values, values under another preset, and foreign albums', async () => {
    const url = `/libraries/${libraryId}/tag-plans`;
    const scope = { type: 'albumIds', albumIds: pieces };
    expect((await post(url, { name: 'x', scope, policy: manual({}) })).statusCode).toBe(400);
    expect((await post(url, { name: 'x', scope, policy: { preset: 'fill_blanks_only', id3Version: '2.4', multiValueSeparator: '; ', values: { album: 'A' } } })).statusCode).toBe(400);
    expect((await post(url, { name: 'x', scope, policy: manual({ date: 'last year' }) })).statusCode).toBe(400);
    expect((await post(url, { name: 'x', scope: { type: 'albumIds', albumIds: [pieces[0], foreignAlbum] }, policy: manual({ album: 'A' }) })).statusCode).toBe(400);
    expect((await post(url, { name: 'x', scope: { type: 'folder', dirPath: 'Nowhere' }, policy: manual({ album: 'A' }) })).statusCode).toBe(400);
  });

  it('the album page offers the other pieces, and treating them as one keeps the page', async () => {
    const detail = await get(`/libraries/${libraryId}/albums/${pieces[1]}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().merged).toBe(false);
    expect(detail.json().artistCredit).toBe('Stephane Pompougnac');
    expect(detail.json().mergeCandidates.map((c: { id: string }) => c.id).sort()).toEqual([pieces[0], pieces[2]].sort());

    sent.length = 0;
    const res = await post(`/libraries/${libraryId}/albums/merge`, { albumIds: pieces, targetId: pieces[1] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ albumId: pieces[1], files: 3, identifyQueued: true });
    expect(sent.filter((j) => j.name === 'identify.album').map((j) => j.data.localAlbumId)).toEqual([pieces[1]]);

    const after = await get(`/libraries/${libraryId}/albums/${pieces[1]}`);
    expect(after.json()).toMatchObject({ merged: true, trackCount: 3, state: 'pending' });
    expect(after.json().tracks).toHaveLength(3);
    expect((await get(`/libraries/${libraryId}/albums/${pieces[0]}`)).statusCode).toBe(404);
  });

  it('refuses nonsense merges', async () => {
    const url = `/libraries/${libraryId}/albums/merge`;
    expect((await post(url, { albumIds: [pieces[1]] })).statusCode).toBe(400);
    expect((await post(url, { albumIds: [pieces[1], foreignAlbum] })).statusCode).toBe(404);
    expect((await post(url, { albumIds: [pieces[1], vaAlbums[0]] }, strangerId)).statusCode).toBe(404);
  });

  it('splits back: pins removed, folders queued for re-clustering', async () => {
    sent.length = 0;
    const res = await post(`/libraries/${libraryId}/albums/${pieces[1]}/unmerge`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ albumId: pieces[1], files: 3, folders: 3 });
    expect(sent.filter((j) => j.name === 'cluster.dir').map((j) => j.data.dirPath).sort()).toEqual([dirOf(0), dirOf(1), dirOf(2)].sort());
    expect(await db.select().from(clusterOverrides).where(eq(clusterOverrides.libraryId, libraryId))).toHaveLength(0);
    const [row] = await db.select().from(localAlbums).where(eq(localAlbums.id, pieces[1]!));
    expect(row.clusterKey).toBe(`piece-${pieces[1]}`);
    expect((await post(`/libraries/${libraryId}/albums/${pieces[1]}/unmerge`, {})).statusCode).toBe(409);
  });
});
