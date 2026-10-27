/**
 * QA 2026-10-26 Q-01: a fresh install without a Discogs token identified
 * nothing for six hours. The first pass asked Discogs only (no token → 401
 * or a 429 cooldown, nothing found) and MusicBrainz waited for the second
 * pass. MusicBrainz is the primary identifier: it runs on the first pass,
 * and a provider that is unconfigured or rate limited never counts as tried.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { files, libraries, localAlbums, localTracks, scanRoots, users, makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';

const calls = vi.hoisted(() => ({ mbSearch: 0, discogsSearch: 0, discogsAuthenticated: false }));
vi.mock('../lib/providers.js', () => ({
  libraryProviderSettings: vi.fn(async () => ({ contactString: 'test@example.com' })),
  getProviders: vi.fn(() => ({
    mb: {
      searchReleases: async () => { calls.mbSearch++; return []; },
      getRelease: async () => { throw new Error('not expected'); },
    },
    discogs: {
      get authenticated() { return calls.discogsAuthenticated; },
      searchReleases: async () => {
        calls.discogsSearch++;
        throw Object.assign(new Error('Discogs rate limited (429): retry after 60s'), { retryAfterMs: 60_000 });
      },
    },
  })),
  mbCall: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  discogsCall: vi.fn((_ctx: unknown, _p: unknown, fn: () => Promise<unknown>) => fn()),
}));

const { identifyAlbumJob } = await import('./identifyAlbum.js');
const { identifySweepJob } = await import('./identifySweep.js');

describe.skipIf(!process.env.TEST_DATABASE_URL)('first identify pass (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const sent: Array<{ name: string; data: any }> = [];
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const album = async (title: string) => {
    const id = randomUUID();
    await db.insert(localAlbums).values({
      id, libraryId, clusterKey: `fp-${id}`, dirPaths: [title], state: 'pending',
      titleGuess: `${title} ${id.slice(0, 8)}`, artistGuess: 'Nobody Known', trackCount: 1,
    });
    const fileId = randomUUID();
    await db.insert(files).values({ handler: 'audio', id: fileId, libraryId, scanRootId: rootId, relPath: `${id}/01.mp3`, sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} });
    await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, trackNo: 1, titleGuess: 'One', durationMs: 180_000 });
    return id;
  };
  const row = async (id: string) => (await db.select().from(localAlbums).where(eq(localAlbums.id, id)))[0];

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    const boss = { send: async (name: string, data: any) => { sent.push({ name, data }); return randomUUID(); } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: logger as any };
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;
    await db.insert(users).values({ id: userId, email: `fp-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'First pass', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/first-pass', displayName: 'FirstPass', writable: true });
  });

  afterAll(async () => {
    await client`delete from job_runs where library_id = ${libraryId}`;
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(files).where(eq(files.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  beforeEach(() => {
    calls.mbSearch = 0;
    calls.discogsSearch = 0;
    calls.discogsAuthenticated = false;
    sent.length = 0;
  });

  it('the sweep sends a new album to MusicBrainz first, not to a Discogs-only pass', async () => {
    const id = await album('Sweep');
    await identifySweepJob(ctx, { libraryId });
    const job = sent.find((s) => s.name === 'identify.album' && s.data.localAlbumId === id);
    expect(job).toBeDefined();
    expect(job!.data.discogsFirst).toBeFalsy();
  });

  it('asks MusicBrainz on the first pass without a Discogs token, and decides the album', async () => {
    const id = await album('No token');
    await identifyAlbumJob(ctx, { localAlbumId: id });
    expect(calls.mbSearch).toBeGreaterThan(0);
    // no token: the Discogs search (which needs one) is not even tried
    expect(calls.discogsSearch).toBe(0);
    const r = await row(id);
    expect(r.state).toBe('unidentified');
    expect(r.identifyReason).toBe('no_candidates');
  });

  it('a job queued by the old Discogs-first sweep still asks MusicBrainz in the same pass', async () => {
    calls.discogsAuthenticated = true;
    const id = await album('Queued before');
    await identifyAlbumJob(ctx, { localAlbumId: id, discogsFirst: true } as any);
    expect(calls.mbSearch).toBeGreaterThan(0);
    const r = await row(id);
    expect(r.identifyReason).not.toBe('discogs_pass');
    expect(r.state).toBe('unidentified');
  });

  it('a rate-limited Discogs (with a token) does not stop the MusicBrainz decision', async () => {
    calls.discogsAuthenticated = true;
    const id = await album('Rate limited');
    await identifyAlbumJob(ctx, { localAlbumId: id });
    expect(calls.mbSearch).toBeGreaterThan(0);
    expect(calls.discogsSearch).toBe(1);
    const r = await row(id);
    expect(r.state).toBe('unidentified');
    expect(r.identifyReason).toBe('no_candidates');
  });
});
