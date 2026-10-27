/**
 * When the filter rail answers from the stored counts (album_filter_counts)
 * and when from the live queries: a build must exist, be newer than any
 * bulk action's dirty stamp, and be recent (rebuilds that stopped, e.g. an
 * old worker on renamed tables, must not leave the counts stale for good).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@tagave/db';
import { SUMMARY_MAX_AGE_MS, summaryFresh } from './filterCounts.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('summaryFresh (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const state = (computed: Date | null, dirty: Date | null) => client`
    insert into filter_rail_state (library_id, computed_at, dirty_at)
    values (${libraryId}, ${computed?.toISOString() ?? null}::timestamptz, ${dirty?.toISOString() ?? null}::timestamptz)
    on conflict (library_id) do update set computed_at = excluded.computed_at, dirty_at = excluded.dirty_at`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`fc-${userId}@test.com`}, 'x')`;
    await client`insert into libraries (id, name, owner_user_id) values (${libraryId}, 'Filter counts', ${userId})`;
  });

  afterAll(async () => {
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('serves a recent build that no bulk action has marked dirty since', async () => {
    const now = Date.now();
    expect(await summaryFresh(db, libraryId, now)).toBe(false);
    await state(new Date(now - 60_000), null);
    expect(await summaryFresh(db, libraryId, now)).toBe(true);
    await state(new Date(now - 60_000), new Date(now - 30_000));
    expect(await summaryFresh(db, libraryId, now)).toBe(false);
    await state(new Date(now - 10_000), new Date(now - 30_000));
    expect(await summaryFresh(db, libraryId, now)).toBe(true);
  });

  it('falls back to the live counts once the last build is older than the limit', async () => {
    const now = Date.now();
    await state(new Date(now - SUMMARY_MAX_AGE_MS + 60_000), null);
    expect(await summaryFresh(db, libraryId, now)).toBe(true);
    await state(new Date(now - SUMMARY_MAX_AGE_MS - 60_000), null);
    expect(await summaryFresh(db, libraryId, now)).toBe(false);
  });
});
