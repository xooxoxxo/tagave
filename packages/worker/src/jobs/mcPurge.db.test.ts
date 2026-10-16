/**
 * mc.purge against the test database: rows a newer row of the same key
 * supersedes go; tombstones older than 90 days go unless their key has data
 * now (then the key is logged again as an upsert); everything else stays.
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
  const rgLive = randomUUID();
  const tag = randomUUID().slice(0, 8);

  const row = (key: string, op: 'upsert' | 'delete', age: string) =>
    client`insert into mc_changes (capability, key, op, user_id, library_id, changed_at)
           values ('ratings', ${key}, ${op}, ${userId}, ${libraryId}, now() - ${age}::interval)`;
  const left = async () =>
    (await client`select key, op from mc_changes where library_id = ${libraryId} order by key, changed_at`)
      .map((r: { key: string; op: string }) => `${r.key.replace(`${tag}:`, '')} ${r.op}`)
      .sort();

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email) values (${userId}, ${`purge-${tag}@example.test`})`;
    await client`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${userId}, 'purge test')`;
    await client`insert into release_groups (id, mbid, title) values (${rgLive}, ${randomUUID()}, 'purge test')`;
    // a rating that exists (its trigger logs one upsert, removed below)
    await client`insert into user_reviews (library_id, user_id, release_group_id, rating) values (${libraryId}, ${userId}, ${rgLive}, 4)`;
    await client`delete from mc_changes where library_id = ${libraryId}`;

    await row(`${tag}:old-delete`, 'delete', '91 days');
    await row(`${tag}:older-delete`, 'delete', '400 days');
    await row(`${tag}:recent-delete`, 'delete', '89 days');
    await row(`${tag}:old-upsert`, 'upsert', '400 days');
    // three rows of one key: only the newest stays
    await row(`${tag}:busy`, 'upsert', '3 days');
    await row(`${tag}:busy`, 'delete', '2 days');
    await row(`${tag}:busy`, 'upsert', '1 day');
    // a stale delete as the newest row of a key that has data now
    await row(rgLive, 'delete', '120 days');
  });

  afterAll(async () => {
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from release_groups where id = ${rgLive}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('drops superseded rows and old tombstones, never a key that has data', async () => {
    const result = await mcPurgeJob(ctx, { batchSize: 1 });
    expect(result).toMatchObject({ relogged: 1 });
    expect(result.superseded).toBeGreaterThanOrEqual(3);
    expect(result.tombstones).toBeGreaterThanOrEqual(2);
    expect(await left()).toEqual([
      'busy upsert',
      'old-upsert upsert',
      'recent-delete delete',
      `${rgLive} upsert`,
    ].sort());
  });

  it('a second run changes nothing', async () => {
    const before = await left();
    expect(await mcPurgeJob(ctx)).toMatchObject({ relogged: 0 });
    expect(await left()).toEqual(before);
  });
});
