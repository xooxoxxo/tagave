/**
 * Manual match through the real routes (fastify.inject, test database): what
 * the input queues, and what the album page and the plan page's status call
 * report once the job has ended — the recorded outcome, never a stale
 * "queued". pg-boss never runs: sends are recorded, jobs are rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { libraries, localAlbums, users } from '@liner/db';

const sent = vi.hoisted(() => [] as Array<{ name: string; data: any; opts: any }>);
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return null; },
    cancel: async () => {},
  }),
}));

const RG = '593f3c1a-3529-39e6-92ef-395dd48f840c';

describe.skipIf(!process.env.TEST_DATABASE_URL)('manual match routes', () => {
  let app: FastifyInstance;
  let db: any;
  let client: any;
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const albumId = randomUUID();
  const queuedAlbum = randomUUID();
  const as = { 'x-test-user': ownerId };
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: as, payload: payload as any });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: as });

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await client`do $$ begin
      if not exists (select 1 from pg_namespace where nspname = 'pgboss') then create schema pgboss; end if;
    end $$`;
    await client`create table if not exists pgboss.job (
      id uuid, name text, state text, priority int, singleton_key text, data jsonb)`;
    await client`alter table pgboss.job add column if not exists created_on timestamptz, add column if not exists started_on timestamptz,
      add column if not exists completed_on timestamptz, add column if not exists output jsonb`;
    await db.insert(users).values({ id: ownerId, email: `mm-${ownerId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Manual', ownerUserId: ownerId, settings: {} });
    await db.insert(localAlbums).values([
      { id: albumId, libraryId, clusterKey: `mm-${albumId}`, dirPaths: ['H'], titleGuess: 'Hotel Costes Vol. 11', artistGuess: 'Stephane Pompougnac', state: 'unidentified', trackCount: 16 },
      { id: queuedAlbum, libraryId, clusterKey: `mm-${queuedAlbum}`, dirPaths: ['Q'], titleGuess: 'Queued', state: 'unidentified', trackCount: 3 },
    ]);

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createAlbumRoutes } = await import('./albums.js');
    const { createIdentifyRoutes } = await import('./identify.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com` } as any) : undefined;
    });
    await app.register(createAlbumRoutes);
    await app.register(createIdentifyRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await client`delete from pgboss.job where data->>'localAlbumId' in (${albumId}, ${queuedAlbum})`;
    await db.delete(localAlbums).where(inArray(localAlbums.id, [albumId, queuedAlbum]));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, ownerId));
    await client?.end({ timeout: 5 });
  });

  it('refuses a MusicBrainz artist page with what to paste instead', async () => {
    const res = await post(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, { input: `https://musicbrainz.org/artist/${RG}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/artist page on MusicBrainz/);
  });

  it('queues a release-group URL as a release-group request, ahead of the sweep', async () => {
    sent.length = 0;
    const res = await post(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, { input: `https://musicbrainz.org/release-group/${RG}` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ entity: 'release-group', mbid: RG });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: 'identify.album', data: { localAlbumId: albumId, force: true, pinnedReleaseGroup: RG }, opts: { priority: 100 } });
  });

  it('after the job ends, the album page shows the recorded outcome with the releases to pick from', async () => {
    const jobId = randomUUID();
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data, created_on, completed_on)
      values (${jobId}, 'identify.album', 'completed', 100, ${`identify:${albumId}`},
              ${JSON.stringify({ localAlbumId: albumId, force: true, pinnedMbid: RG })}::jsonb, now() - interval '5 seconds', now() - interval '4 seconds')`;
    await client`insert into identify_runs (library_id, local_album_id, job_id, kind, pinned, outcome, message, detail)
      values (${libraryId}, ${albumId}, ${jobId}, 'mbid', ${RG}, 'release_group',
              'No MusicBrainz release has this ID. It is a release group — pick one of its releases:',
              ${JSON.stringify({ releaseGroup: { mbid: RG, title: 'Hôtel Costes, Volume 11' }, choices: [{ mbid: 'f52cf3d9-c1f2-492f-99d5-b4b2cbd5d081', title: 'Hôtel Costes, Volume 11', trackCount: 16, mediumCount: 1, trackDelta: 0, fit: 'exact' }], moreChoices: 0 })}::jsonb)`;
    const res = await get(`/libraries/${libraryId}/albums/${albumId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pendingIdentify).toBeNull();
    expect(body.identifyRequest).toMatchObject({ status: 'done', jobId, kind: 'mbid', pinned: RG, outcome: { kind: 'release_group', releaseGroup: { title: 'Hôtel Costes, Volume 11' } } });
    expect(body.identifyRequest.outcome.choices[0].fit).toBe('exact');
  });

  it('a queued job reads as queued; cancelling it records the cancellation', async () => {
    const jobId = randomUUID();
    await client`insert into pgboss.job (id, name, state, priority, singleton_key, data, created_on)
      values (${jobId}, 'identify.album', 'created', 100, ${`identify:${queuedAlbum}`},
              ${JSON.stringify({ localAlbumId: queuedAlbum, force: true })}::jsonb, now())`;
    const before = await post(`/libraries/${libraryId}/identify/status`, { albumIds: [queuedAlbum, albumId, randomUUID()] });
    expect(before.statusCode).toBe(200);
    const items = before.json().items as any[];
    expect(items[0]).toMatchObject({ albumId: queuedAlbum, exists: true, request: { status: 'queued', kind: 'reidentify', jobsAhead: 0 } });
    expect(items[1]).toMatchObject({ albumId, exists: true, request: { status: 'done', outcome: { kind: 'release_group' } } });
    expect(items[2]).toMatchObject({ exists: false });

    const cancel = await post(`/libraries/${libraryId}/albums/${queuedAlbum}/identify-request/cancel`, {});
    expect(cancel.statusCode).toBe(200);
    // the stub pg-boss does not move the row; a real cancel sets state 'cancelled'
    await client`update pgboss.job set state = 'cancelled', completed_on = now() where id = ${jobId}`;
    const after = await get(`/libraries/${libraryId}/albums/${queuedAlbum}`);
    expect(after.json().identifyRequest).toMatchObject({ status: 'done', outcome: { kind: 'cancelled', message: 'You cancelled this request before it ran.' } });
  });
});
