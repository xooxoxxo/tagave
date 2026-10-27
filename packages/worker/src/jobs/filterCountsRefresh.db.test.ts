/**
 * Database tests for the facets.refresh staleness check. The worker's `sql`
 * client is shared with drizzle, whose postgres-js driver replaces the
 * timestamp parsers, so raw queries return timestamps as strings, not Dates.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@tagave/db';
import pino from 'pino';
import { refreshFilterCounts } from './filterCountsRefresh.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('refreshFilterCounts staleness (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  let userId: string;
  let libraryId: string;
  const rgIds: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set');
    const made = await makeDb(databaseUrl);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    userId = randomUUID();
    libraryId = randomUUID();
    await client`insert into users (id, email, password_hash) values (${userId}, ${`facets-${userId}@test.local`}, 'x')`;
    await client`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${userId}, 'facets test')`;
  });

  afterAll(async () => {
    await client`delete from album_filter_counts where library_id = ${libraryId}`;
    await client`delete from local_albums where library_id = ${libraryId}`;
    await client`delete from release_groups where id = any(${rgIds}::uuid[])`;
    await client`delete from filter_rail_state where library_id = ${libraryId}`;
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('builds when no state exists, then skips while the build is fresh', async () => {
    const first = await refreshFilterCounts(ctx, libraryId, false);
    expect(first.skipped).toBe(false);

    const second = await refreshFilterCounts(ctx, libraryId, false);
    expect(second.skipped).toBe(true);
  });

  it('rebuilds when the library was stamped dirty after the last build', async () => {
    await client`update filter_rail_state set dirty_at = computed_at + interval '1 second' where library_id = ${libraryId}`;
    const result = await refreshFilterCounts(ctx, libraryId, false);
    expect(result.skipped).toBe(false);
  });

  it('rebuilds a build older than the max age', async () => {
    await client`update filter_rail_state set computed_at = now() - interval '1 hour', dirty_at = null where library_id = ${libraryId}`;
    const result = await refreshFilterCounts(ctx, libraryId, false);
    expect(result.skipped).toBe(false);
  });

  it('files a model-matched album under its own match kind', async () => {
    const rgId = randomUUID();
    rgIds.push(rgId);
    const releaseId = randomUUID();
    const albumId = randomUUID();
    const master = 900_000_000 + Math.floor(Math.random() * 99_000_000);
    await client`insert into release_groups (id, title, discogs_master_id) values (${rgId}, 'Facets', ${master})`;
    await client`insert into releases (id, release_group_id, title) values (${releaseId}, ${rgId}, 'Facets')`;
    await client`insert into local_albums (id, library_id, cluster_key, state, release_group_id, release_id)
                 values (${albumId}, ${libraryId}, ${`facets:${albumId}`}, 'matched', ${rgId}, ${releaseId})`;
    await client`
      insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind,
                                 decider_id, decider_version, probability, reason)
      values (${libraryId}, ${albumId}, ${releaseId}, 0.0500, 'auto', 'system', 'model',
              'jev', 'jev-2026-09-15', 0.9940, 'auto-accept: jev-2026-09-15, probability 0.9940')`; // a reason another bucket's prefix matches: decided_kind alone must keep it model

    await refreshFilterCounts(ctx, libraryId, true);

    const rows = await client`select decided from album_filter_counts where album_id = ${albumId}`;
    expect(rows[0]!['decided']).toEqual(['model']);
  });
});
