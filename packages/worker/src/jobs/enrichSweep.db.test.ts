/**
 * enrich.sweep against a real database: the owner's pace (the library's
 * enrichSweepLimit) raises how many releases one run enqueues, and the run
 * fails accept batches whose job ended without marking them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { createBatch, getBatch, libraries, releaseGroups, users, makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { enrichSweepJob } from './enrichSweep.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('enrich.sweep (db)', () => {
  let db: any;
  let client: any;
  let ctx: WorkerContext;
  const send = vi.fn(async (..._args: unknown[]) => 'job');
  const owner = randomUUID();
  const lib = randomUUID();
  const rgId = randomUUID();
  const rels = Array.from({ length: 900 }, () => randomUUID());
  const enqueued = () => send.mock.calls.filter((c) => c[0] === 'enrich.release').length;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    // pg-boss's job table as the suites on the shared test database stand it in (never a real pg-boss here:
    // its queue table would refuse the other suites' rows)
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;
    await client`alter table pgboss.job add column if not exists created_on timestamptz, add column if not exists started_on timestamptz,
      add column if not exists completed_on timestamptz, add column if not exists output jsonb`;
    await db.insert(users).values({ id: owner, email: `es-${owner}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: lib, name: 'EnrichSweep', ownerUserId: owner, settings: {} });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Sweep', artistCredit: ['Sweep Artist'] });
    // 900 matched albums whose release has an MBID but no Discogs id yet
    await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                 select r, ${rgId}, gen_random_uuid(), 'Sweep', 'Official', 1, 'musicbrainz' from unnest(${rels}::uuid[]) as r`;
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, state, release_id, track_count)
                 select gen_random_uuid(), ${lib}, 'es-' || r::text, array['es/' || r::text], 'Sweep', 'matched', r, 1
                   from unnest(${rels}::uuid[]) as r`;
  });

  beforeEach(() => { send.mockClear(); });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, lib)); // cascades albums, batches
    await client`delete from releases where id = any(${rels}::uuid[])`;
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(users).where(eq(users.id, owner));
    await client.end({ timeout: 5 });
  });

  it('without a pace setting, a run enqueues the scheduled 400', async () => {
    await enrichSweepJob(ctx, { libraryId: lib, limit: 400 });
    expect(enqueued()).toBe(400);
  });

  it("the owner's pace of 800 raises the run to 800", async () => {
    await client`update libraries set settings = settings || '{"enrichSweepLimit": 800}'::jsonb where id = ${lib}`;
    await enrichSweepJob(ctx, { libraryId: lib, limit: 400 });
    expect(enqueued()).toBe(800);
  });

  it('a pace that is not one of the offered ones is ignored', async () => {
    await client`update libraries set settings = settings || '{"enrichSweepLimit": 100000}'::jsonb where id = ${lib}`;
    await enrichSweepJob(ctx, { libraryId: lib, limit: 400 });
    expect(enqueued()).toBe(400);
    await client`update libraries set settings = settings - 'enrichSweepLimit' where id = ${lib}`;
  });

  it('fails a batch left accepting or undoing with no job and no progress, and leaves a fresh one', async () => {
    const mk = () => createBatch(client, { libraryId: lib, deciderId: 'rules', deciderVersion: null, decidedKind: 'rule', startedByUserId: owner, items: [] });
    const [old, oldUndo, fresh] = [await mk(), await mk(), await mk()];
    await client`update decider_batches set state = 'accepting', created_at = now() - interval '7 hours' where id = ${old}`;
    await client`update decider_batches set state = 'undoing', created_at = now() - interval '9 hours', undo_requested_at = now() - interval '7 hours' where id = ${oldUndo}`;
    await client`update decider_batches set state = 'accepting' where id = ${fresh}`;
    await enrichSweepJob(ctx, { libraryId: lib, limit: 400 });
    expect(await getBatch(client, old)).toMatchObject({ state: 'failed', message: 'Accept stopped: no progress' });
    expect(await getBatch(client, oldUndo)).toMatchObject({ state: 'failed', message: 'Undo stopped: no progress' });
    expect((await getBatch(client, fresh))!.state).toBe('accepting');
  });

  it('leaves a stale-looking batch alone while a job for it is still queued', async () => {
    const b = await createBatch(client, { libraryId: lib, deciderId: 'rules', deciderVersion: null, decidedKind: 'rule', startedByUserId: owner, items: [] });
    await client`update decider_batches set state = 'accepting', created_at = now() - interval '7 hours' where id = ${b}`;
    const jobId = randomUUID();
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data)
                 values (${jobId}, 'decider.accept', 'retry', 0, ${`decider:${b}`}, ${JSON.stringify({ batchId: b, mode: 'accept' })}::jsonb)`;
    try {
      await enrichSweepJob(ctx, { libraryId: lib, limit: 400 });
      expect((await getBatch(client, b))!.state).toBe('accepting');
    } finally {
      await client`delete from pgboss.job where id = ${jobId}`;
    }
  });
});
