/**
 * The artists list query against the test database: junk tag names come back
 * untouched (display and order only, never data), "Recently added" reads the
 * album scan time, and the card mosaic gets only albums with a stored cover.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { images, libraries, localAlbums, users, makeDb } from '@liner/db';
import { coverKey, coversFor, fetchArtistRows, orderArtists } from './artistList.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('artists list (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const albumIds: Record<string, string[]> = {};

  const album = async (artist: string, title: string, year: number, createdAt: string) => {
    const id = randomUUID();
    await db.insert(localAlbums).values({
      id, libraryId, clusterKey: `${artist}/${title}`, artistGuess: artist, titleGuess: title,
      yearGuess: year, trackCount: 10, createdAt: new Date(createdAt),
    });
    (albumIds[artist] ??= []).push(id);
    return id;
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: userId, email: `al-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Artists list', ownerUserId: userId });
    await album('Air', 'Moon Safari', 1998, '2026-01-01T00:00:00Z');
    await album('Air', 'Talkie Walkie', 2004, '2026-01-02T00:00:00Z');
    await album('Air', 'Pocket Symphony', 2007, '2026-01-03T00:00:00Z');
    await album('\u008F\u008E¬}', 'Bad bytes', 2004, '2026-02-01T00:00:00Z');
    await album('이지수', 'Korean', 2003, '2026-09-01T00:00:00Z');
    await album('+/-', 'Punctuation', 2006, '2026-03-01T00:00:00Z');
    await album('Beirut', 'Gulag Orkestar', 2006, '2026-04-01T00:00:00Z');
    // covers for two of Air's three albums
    for (const id of albumIds['Air']!.slice(0, 2)) {
      await db.insert(images).values({
        libraryId, entityType: 'local_album', entityId: id, localAlbumId: id, kind: 'front', origin: 'owner',
        licenseNote: 'test', thumbBytes: Buffer.from([0xff, 0xd8, 0xff]),
      });
    }
  });

  afterAll(async () => {
    await db.delete(images).where(eq(images.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it('returns every artist with names exactly as tagged, junk after real names', async () => {
    const rows = await fetchArtistRows(db, libraryId, '');
    const ordered = orderArtists(rows, { sort: 'name' });
    expect(ordered.items.map((r) => r.name)).toEqual(['Air', 'Beirut', '이지수', '+/-', '\u008F\u008E¬}']);
    const air = ordered.items[0]!;
    expect(air).toMatchObject({ albumCount: 3, trackCount: 30, yearFrom: 1998, yearTo: 2007, resolved: false });
    expect(ordered.groups.map((g) => g.key)).toEqual(['A', 'B', 'other', '#']);
  });

  it('orders by when the newest album was scanned', async () => {
    const rows = await fetchArtistRows(db, libraryId, '');
    expect(orderArtists(rows, { sort: 'recent' }).items.map((r) => r.name)[0]).toBe('이지수');
  });

  it('narrows by search', async () => {
    const rows = await fetchArtistRows(db, libraryId, 'bei');
    expect(rows.map((r) => r.name)).toEqual(['Beirut']);
  });

  it('gives the mosaic only albums that have a stored cover, oldest first', async () => {
    const rows = await fetchArtistRows(db, libraryId, '');
    const covers = await coversFor(db, libraryId, rows);
    const air = rows.find((r) => r.name === 'Air')!;
    expect(covers.get(coverKey(air))).toEqual(albumIds['Air']!.slice(0, 2));
    const beirut = rows.find((r) => r.name === 'Beirut')!;
    expect(covers.get(coverKey(beirut))).toBeUndefined();
  });
});
