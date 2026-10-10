/**
 * facets.refresh rebuilds artist_list (migration 0035): one row per artist
 * row of the artists page, with its position under each sort matching the
 * live ordering, and facet_state.artists_at stamped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb, fetchArtistRows } from '@liner/db';
import { orderArtists } from '@liner/core';
import pino from 'pino';
import { refreshArtistList, refreshLibraryFacets } from './facetsRefresh.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('artist_list rebuild (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email, password_hash) values (${userId}, ${`al-${userId}@test.local`}, 'x')`;
    await client`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${userId}, 'artist list')`;
    const albums: Array<[string, string, number, string]> = [
      ['The Beatles', 'Abbey Road', 1969, '2026-01-05'],
      ['Air', 'Moon Safari', 1998, '2026-01-01'],
      ['Air', 'Talkie Walkie', 2004, '2026-01-02'],
      ['ABBA', 'Arrival', 1976, '2026-03-01'],
      ['+/-', 'Punctuation', 2006, '2026-02-01'],
    ];
    for (const [artist, title, year, created] of albums) {
      await client`insert into local_albums (library_id, cluster_key, artist_guess, title_guess, year_guess, track_count, created_at)
                   values (${libraryId}, ${`${artist}/${title}`}, ${artist}, ${title}, ${year}, 10, ${created})`;
    }
  });

  afterAll(async () => {
    await client`delete from artist_list where library_id = ${libraryId}`;
    await client`delete from album_facets where library_id = ${libraryId}`;
    await client`delete from facet_state where library_id = ${libraryId}`;
    await client`delete from local_albums where library_id = ${libraryId}`;
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('stores each sort position as the live ordering has it', async () => {
    expect(await refreshArtistList(ctx, libraryId)).toBe(4);
    const live = await fetchArtistRows(ctx.db, libraryId, '');
    for (const [sort, col] of [['name', 'pos_name'], ['albums', 'pos_albums'], ['recent', 'pos_recent']] as const) {
      const stored = (await client.unsafe(
        `select name from artist_list where library_id = $1 order by ${col}`, [libraryId],
      )).map((r: { name: string }) => r.name);
      expect(stored, sort).toEqual(orderArtists(live, { sort }).items.map((r) => r.name));
    }
    // "The Beatles" files under B, the symbol-only name under "#"
    const groups = await client`select name, group_key from artist_list where library_id = ${libraryId} order by pos_name`;
    expect(groups.map((g: { name: string; group_key: string }) => `${g.name}:${g.group_key}`))
      .toEqual(['ABBA:A', 'Air:A', 'The Beatles:B', '+/-:#']);
  });

  it('is rebuilt by facets.refresh and stamps artists_at', async () => {
    await client`delete from artist_list where library_id = ${libraryId}`;
    await client`delete from facet_state where library_id = ${libraryId}`;
    const result = await refreshLibraryFacets(ctx, libraryId, false);
    expect(result.skipped).toBe(false);
    expect(result.artists).toBe(4);
    const [st] = await client`select artists_at from facet_state where library_id = ${libraryId}`;
    expect(st.artists_at).not.toBeNull();
    // fresh: the next run skips
    expect((await refreshLibraryFacets(ctx, libraryId, false)).skipped).toBe(true);
  });
});
