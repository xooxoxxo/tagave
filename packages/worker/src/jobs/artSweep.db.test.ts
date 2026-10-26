/**
 * art.sweep against a real database: every album without a front image gets
 * one cover lookup (embedded art, a folder image, then online art), and is
 * looked up again only once the album changes (a match, a rescan). Nothing
 * else ever queued art.fetch for a scanned album, so local covers were never
 * read (QA 2026-10-26, Q-04).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { images, libraries, localAlbums, makeDb, users } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { artSweepJob } from './artFetch.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('artSweepJob (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let createdJobTable = false;
  const send = vi.fn(async () => 'job-id');
  const queued = () => send.mock.calls
    .filter((c) => (c as unknown[])[0] === 'art.fetch')
    .map((c) => ((c as unknown[])[1] as { localAlbumId: string }).localAlbumId);

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    // pg-boss never runs in tests: stand in its job table with the columns the sweep reads
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    const [had] = await client`select to_regclass('pgboss.job') is not null as yes`;
    createdJobTable = !had.yes;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb, created_on timestamptz default now())`;
    await client`alter table pgboss.job add column if not exists created_on timestamptz default now()`;
    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `sweep-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Sweep', ownerUserId: userId, settings: {} });
  });

  beforeEach(async () => {
    send.mockClear();
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
  });

  afterAll(async () => {
    await client`delete from pgboss.job where name = 'art.fetch' and data->>'test' = ${libraryId}`;
    if (createdJobTable) await client`drop table if exists pgboss.job`;
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  async function album(over: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.insert(localAlbums).values({ id, libraryId, clusterKey: `sweep:${id}`, dirPaths: [`s/${id}`], titleGuess: 'Dummy', ...over });
    return id;
  }
  async function lookup(albumId: string, createdOn: Date, state = 'completed') {
    await client`insert into pgboss.job (id, name, state, singleton_key, data, created_on)
      values (${randomUUID()}, 'art.fetch', ${state}, ${`art:${albumId}`}, ${JSON.stringify({ test: libraryId })}::jsonb, ${createdOn.toISOString()}::timestamptz)`;
  }

  it('queues a lookup for an album that never had one', async () => {
    const fresh = await album();
    await artSweepJob(ctx, { libraryId });
    expect(queued()).toEqual([fresh]);
    expect(send).toHaveBeenCalledWith('art.fetch', { localAlbumId: fresh }, { singletonKey: `art:${fresh}` });
  });

  it('skips albums with a cover, ignored albums, and albums looked up since they last changed', async () => {
    const withCover = await album();
    await db.insert(images).values({
      libraryId, entityType: 'local_album', entityId: withCover, localAlbumId: withCover, kind: 'front', origin: 'owner', licenseNote: 'test',
    });
    await album({ state: 'ignored' });
    const lookedUp = await album({ updatedAt: new Date(Date.now() - 3600_000) });
    await lookup(lookedUp, new Date());
    const queuedNow = await album({ updatedAt: new Date(Date.now() - 3600_000) });
    await lookup(queuedNow, new Date(), 'created');
    await artSweepJob(ctx, { libraryId });
    expect(queued()).toEqual([]);
  });

  it('looks an album up again once it changed after the last lookup (matched since)', async () => {
    const matched = await album({ state: 'matched', updatedAt: new Date() });
    await lookup(matched, new Date(Date.now() - 3600_000));
    await artSweepJob(ctx, { libraryId });
    expect(queued()).toEqual([matched]);
  });

  it('without a library: sweeps every library', async () => {
    const fresh = await album();
    await artSweepJob(ctx, {});
    expect(queued()).toContain(fresh);
  });
});
