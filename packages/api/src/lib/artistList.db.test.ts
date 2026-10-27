/**
 * The artists list query against the test database: junk tag names come back
 * untouched (display and order only, never data), "Recently added" reads the
 * album scan time, and the card mosaic gets only albums with a stored cover.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { images, libraries, localAlbums, users, makeDb } from '@tagave/db';
import { artistListPositions } from '@tagave/core';
import { coverKey, coversFor, fetchArtistRows, orderArtists, readArtistListPage } from './artistList.js';

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
      const [img] = await db.insert(images).values({
        libraryId, entityType: 'local_album', entityId: id, localAlbumId: id, kind: 'front', origin: 'owner', licenseNote: 'test',
      }).returning({ id: images.id });
      await client`insert into cover_thumbs (image_id, bytes, sha256) values (${img.id}, ${Buffer.from([0xff, 0xd8, 0xff])}, ${Buffer.alloc(32)})`;
    }
  });

  afterAll(async () => {
    await client`delete from artist_list where library_id = ${libraryId}`;
    await client`delete from filter_rail_state where library_id = ${libraryId}`;
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

  describe('precomputed list (artist_list, migration 0035)', () => {
    /** What facets.refresh writes (worker refreshArtistList), built here from the same helpers. */
    async function buildList() {
      const positioned = artistListPositions(await fetchArtistRows(db, libraryId, ''));
      await client`delete from artist_list where library_id = ${libraryId}`;
      await client`insert into artist_list ${client(positioned.map((p) => ({
        library_id: libraryId, pos_name: p.posName, pos_albums: p.posAlbums, pos_recent: p.posRecent,
        artist_id: p.row.id, name: p.row.name, sort_name: p.row.sortName, resolved: p.row.resolved,
        album_count: p.row.albumCount, track_count: p.row.trackCount, year_from: p.row.yearFrom,
        year_to: p.row.yearTo, added_at: p.row.addedAt, group_key: p.group,
      })))}`;
      await client`insert into filter_rail_state (library_id, artists_at) values (${libraryId}, now())
                   on conflict (library_id) do update set artists_at = now(), dirty_at = null`;
    }

    it('is not used before the worker built it', async () => {
      expect(await readArtistListPage(db, libraryId, { sort: 'name', group: null, offset: 0, limit: 10 })).toBeNull();
    });

    it('pages every sort and group exactly like the live list', async () => {
      await buildList();
      const live = await fetchArtistRows(db, libraryId, '');
      for (const sort of ['name', 'albums', 'recent'] as const) {
        for (const group of [null, 'A', '#'] as const) {
          const all = orderArtists(live, { sort, group });
          for (const [offset, limit] of [[0, 2], [2, 2], [4, 10], [0, 100]] as const) {
            const page = await readArtistListPage(db, libraryId, { sort, group, offset, limit });
            expect(page, `${sort}/${group}/${offset}`).not.toBeNull();
            expect(page!.items.map((r) => r.name)).toEqual(all.items.slice(offset, offset + limit).map((r) => r.name));
            expect(page!.total).toBe(all.items.length);
            expect(page!.groups).toEqual(all.groups);
          }
        }
      }
      const page = await readArtistListPage(db, libraryId, { sort: 'name', group: null, offset: 0, limit: 1 });
      expect(page!.items[0]).toMatchObject({ name: 'Air', albumCount: 3, trackCount: 30, yearFrom: 1998, yearTo: 2007, resolved: false });
      expect(typeof page!.items[0]!.addedAt).toBe('string');
    });

    it('steps aside while a bulk action has marked the facets stale', async () => {
      await buildList();
      await client`update filter_rail_state set dirty_at = now() + interval '1 second' where library_id = ${libraryId}`;
      expect(await readArtistListPage(db, libraryId, { sort: 'name', group: null, offset: 0, limit: 10 })).toBeNull();
    });
  });
});
