/**
 * Database tests for the facets.refresh staleness check. The worker's `sql`
 * client is shared with drizzle, whose postgres-js driver replaces the
 * timestamp parsers, so raw queries return timestamps as strings, not Dates.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@liner/db';
import pino from 'pino';
import { refreshLibraryFacets } from './facetsRefresh.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('refreshLibraryFacets staleness (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  let userId: string;
  let libraryId: string;

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
    await client`delete from facet_state where library_id = ${libraryId}`;
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('builds when no state exists, then skips while the build is fresh', async () => {
    const first = await refreshLibraryFacets(ctx, libraryId, false);
    expect(first.skipped).toBe(false);

    const second = await refreshLibraryFacets(ctx, libraryId, false);
    expect(second.skipped).toBe(true);
  });

  it('rebuilds when the library was stamped dirty after the last build', async () => {
    await client`update facet_state set dirty_at = computed_at + interval '1 second' where library_id = ${libraryId}`;
    const result = await refreshLibraryFacets(ctx, libraryId, false);
    expect(result.skipped).toBe(false);
  });

  it('rebuilds a build older than the max age', async () => {
    await client`update facet_state set computed_at = now() - interval '1 hour', dirty_at = null where library_id = ${libraryId}`;
    const result = await refreshLibraryFacets(ctx, libraryId, false);
    expect(result.skipped).toBe(false);
  });
});
