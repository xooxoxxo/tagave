/**
 * The albums list's search box (`q`), like ⌘K, ignores diacritics both ways
 * (QA 2026-10-26 Q-08: "bjork" did not find "Björk").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { libraries, localAlbums, users, makeDb } from '@tagave/db';
import { albumQueryParts } from './albums.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('albums list: search ignores diacritics (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();

  const titles = async (q: string) => {
    const { conds } = albumQueryParts(libraryId, userId, { q });
    const rows = await db.select({ title: localAlbums.titleGuess }).from(localAlbums).where(and(...conds));
    return rows.map((r: { title: string }) => r.title).sort();
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: userId, email: `as-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Accents', ownerUserId: userId });
    await db.insert(localAlbums).values([
      { libraryId, clusterKey: `as-${randomUUID()}`, dirPaths: ['h'], titleGuess: 'Homogenic', artistGuess: 'Björk' },
      { libraryId, clusterKey: `as-${randomUUID()}`, dirPaths: ['d'], titleGuess: 'Debut', artistGuess: 'bjork' },
      { libraryId, clusterKey: `as-${randomUUID()}`, dirPaths: ['c'], titleGuess: 'Café Tacvba', artistGuess: 'Café Tacvba' },
      { libraryId, clusterKey: `as-${randomUUID()}`, dirPaths: ['o'], titleGuess: 'Other', artistGuess: 'Someone' },
    ]);
  });

  afterAll(async () => {
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it('finds the accented spelling from a plain query', async () => {
    expect(await titles('bjork')).toEqual(['Debut', 'Homogenic']);
    expect(await titles('cafe')).toEqual(['Café Tacvba']);
  });

  it('finds the plain spelling from an accented query', async () => {
    expect(await titles('Björk')).toEqual(['Debut', 'Homogenic']);
  });

  it('keeps LIKE wildcards literal', async () => {
    expect(await titles('%')).toEqual([]);
  });
});
