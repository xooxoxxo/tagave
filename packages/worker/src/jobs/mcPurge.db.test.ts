/**
 * mc.purge against the test database: Music Connections tombstones older
 * than 90 days go; younger ones and every upsert (however old) stay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@tagave/db';
import pino from 'pino';
import { mcPurgeJob } from './mcPurge.js';
import type { WorkerContext } from '../lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('mc.purge (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const tag = randomUUID().slice(0, 8);

  const row = (key: string, op: 'upsert' | 'delete', age: string) =>
    client`insert into mc_changes (capability, key, op, user_id, library_id, changed_at)
           values ('ratings', ${`${tag}:${key}`}, ${op}, ${userId}, ${libraryId}, now() - ${age}::interval)`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email) values (${userId}, ${`purge-${tag}@example.test`})`;
    await client`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${userId}, 'purge test')`;
    await row('old-delete', 'delete', '91 days');
    await row('older-delete', 'delete', '400 days');
    await row('recent-delete', 'delete', '89 days');
    await row('old-upsert', 'upsert', '400 days');
  });

  afterAll(async () => {
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('deletes only tombstones past 90 days', async () => {
    const result = await mcPurgeJob(ctx, { batchSize: 1 });
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    const left = (await client`select key from mc_changes where key like ${`${tag}:%`} order by key`).map((r: { key: string }) => r.key);
    expect(left).toEqual([`${tag}:old-upsert`, `${tag}:recent-delete`]);
  });
});
