/**
 * cache.purge against the test database: rows a week past expiry go, fresh
 * and never-expiring rows stay, and MusicBrainz release payloads of releases
 * still in the catalogue stay (tracks.link reads them ignoring expiry).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@liner/db';
import pino from 'pino';
import { cachePurgeJob } from './cachePurge.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('cache.purge (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  const tag = randomUUID().slice(0, 8);
  const keptMbid = randomUUID();
  const goneMbid = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();

  const row = (provider: string, key: string, expires: string | null) =>
    client`insert into provider_cache (provider, cache_key, payload, expires_at)
           values (${provider}, ${key}, '{}'::jsonb, ${expires === null ? null : client`now() + ${expires}::interval`})`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    await client`insert into release_groups (id, mbid, title) values (${rgId}, ${randomUUID()}, 'purge test')`;
    await client`insert into releases (id, release_group_id, mbid, title) values (${releaseId}, ${rgId}, ${keptMbid}, 'purge test')`;
    await row('discogs', `t-${tag}:old`, '-30 days');
    await row('discogs', `t-${tag}:recent`, '-2 days');
    await row('discogs', `t-${tag}:fresh`, '10 days');
    await row('discogs', `t-${tag}:forever`, null);
    await row('musicbrainz', `v2:release:${keptMbid}`, '-60 days');
    await row('musicbrainz', `v2:release:${goneMbid}`, '-60 days');
  });

  afterAll(async () => {
    await client`delete from provider_cache where cache_key like ${`t-${tag}:%`} or cache_key in (${`v2:release:${keptMbid}`}, ${`v2:release:${goneMbid}`})`;
    await client`delete from releases where id = ${releaseId}`;
    await client`delete from release_groups where id = ${rgId}`;
    await client.end({ timeout: 5 });
  });

  it('deletes only rows a week past expiry, keeping catalogue MB releases', async () => {
    const result = await cachePurgeJob(ctx, { batchSize: 1 });
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    const left = (await client`
      select cache_key from provider_cache
       where cache_key like ${`t-${tag}:%`} or cache_key in (${`v2:release:${keptMbid}`}, ${`v2:release:${goneMbid}`})
       order by cache_key`).map((r: { cache_key: string }) => r.cache_key);
    expect(left).toEqual([`t-${tag}:forever`, `t-${tag}:fresh`, `t-${tag}:recent`, `v2:release:${keptMbid}`].sort());
  });
});
