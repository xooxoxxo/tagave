/**
 * The albums list and its facets file a match a decision model made under its
 * own match kind (`model`), apart from the matcher's strong accepts and the
 * owner's rules: the live queries and the worker-built summary alike.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../boss.js', () => ({
  getBoss: async () => ({ send: async () => 'job-id', createQueue: async () => undefined }),
}));

describe.skipIf(!process.env.TEST_DATABASE_URL)('albums list: model match kind (db)', () => {
  let app: FastifyInstance;
  let client: any;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const lib = randomUUID();
  const rgId = randomUUID();
  const modelRelease = randomUUID();
  const ruleRelease = randomUUID();
  const modelAlbum = randomUUID();
  const ruleAlbum = randomUUID();

  const get = async (url: string, as = userId) => {
    const res = await app.inject({ method: 'GET', url, headers: { 'x-test-user': as } });
    expect(res.statusCode).toBe(200);
    return { body: res.json(), headers: res.headers };
  };
  const countOf = (facets: any, value: string) => facets.decided.find((d: any) => d.value === value)?.count;

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    const made = await initDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    await client`insert into users (id, email, password_hash) values
      (${userId}, ${`ad-${userId}@test.com`}, 'x'), (${otherUserId}, ${`ad-${otherUserId}@test.com`}, 'x')`;
    await client`insert into libraries (id, name, owner_user_id, settings) values (${lib}, 'Decided', ${userId}, '{}')`;
    const master = 900_000_000 + Math.floor(Math.random() * 99_000_000);
    await client`insert into release_groups (id, title, discogs_master_id) values (${rgId}, 'Kosmonument', ${master})`;
    await client`insert into releases (id, release_group_id, title) values (${modelRelease}, ${rgId}, 'Kosmonument'), (${ruleRelease}, ${rgId}, 'Kosmonument')`;
    await client`insert into local_albums (id, library_id, cluster_key, state, title_guess, artist_guess, release_group_id, release_id) values
      (${modelAlbum}, ${lib}, ${`ad:${modelAlbum}`}, 'matched', 'Model pick', 'A', ${rgId}, ${modelRelease}),
      (${ruleAlbum}, ${lib}, ${`ad:${ruleAlbum}`}, 'matched', 'Rule pick', 'B', ${rgId}, ${ruleRelease})`;
    await client`
      insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind,
                                 decider_id, decider_version, probability, reason)
      values (${lib}, ${modelAlbum}, ${modelRelease}, 0.0500, 'auto', 'system', 'model',
              'jev', 'jev-2026-09-15', 0.9940, 'auto-accept: jev-2026-09-15, probability 0.9940')`; // a reason another bucket's prefix matches: decided_kind alone must keep it model
    await client`
      insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind, reason)
      values (${lib}, ${ruleAlbum}, ${ruleRelease}, 0.0300, 'auto', 'system', 'system', 'chip-rule auto-accept: 5 green')`;

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createAlbumRoutes } = await import('./albums.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com` } as any) : undefined;
    });
    await app.register(createAlbumRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await client`delete from filter_rail_state where library_id = ${lib}`;
    await client`delete from album_filter_counts where library_id = ${lib}`;
    await client`delete from local_albums where library_id = ${lib}`;
    await client`delete from release_groups where id = ${rgId}`;
    await client`delete from libraries where id = ${lib}`;
    await client`delete from users where id = any(${[userId, otherUserId]}::uuid[])`;
    await client?.end({ timeout: 5 });
  });

  it('lists a model match under its own match kind and filter', async () => {
    const { body: list } = await get(`/api/v1/libraries/${lib}/albums?decided=model`);
    expect(list.items.map((a: any) => a.id)).toEqual([modelAlbum]);
    expect(list.items[0].matchKind).toBe('model');
    const { body: strong } = await get(`/api/v1/libraries/${lib}/albums?decided=auto_strong`);
    expect(strong.items).toEqual([]);
    const { body: all } = await get(`/api/v1/libraries/${lib}/albums`);
    expect(Object.fromEntries(all.items.map((a: any) => [a.id, a.matchKind]))).toEqual({ [modelAlbum]: 'model', [ruleAlbum]: 'chip_rule' });

    const { body: facets, headers } = await get(`/api/v1/libraries/${lib}/albums/facets`);
    expect(headers['x-tagave-facets']).toBe('live');
    expect(countOf(facets, 'model')).toBe(1);
    expect(countOf(facets, 'auto_strong')).toBe(0);
    expect(countOf(facets, 'chip_rule')).toBe(1);
    for (const k of ['first_candidate', 'by_me', 'manual_mbid']) expect(countOf(facets, k), k).toBe(0);
  });

  it('counts a model match from the facet summary too', async () => {
    // what the worker's facets.refresh writes for these two albums
    await client`insert into album_filter_counts (album_id, library_id, release_group_id, state, format, decided) values
      (${modelAlbum}, ${lib}, ${rgId}, 'matched', 'lossy', ${['model']}::text[]),
      (${ruleAlbum}, ${lib}, ${rgId}, 'matched', 'lossy', ${['chip_rule']}::text[])`;
    await client`insert into filter_rail_state (library_id, computed_at) values (${lib}, now())
                 on conflict (library_id) do update set computed_at = now(), dirty_at = null`;
    // another viewer: the first test's answer sits in the per-viewer cache
    const { body: facets, headers } = await get(`/api/v1/libraries/${lib}/albums/facets`, otherUserId);
    expect(headers['x-tagave-facets']).toBe('summary');
    expect(countOf(facets, 'model')).toBe(1);
    expect(countOf(facets, 'auto_strong')).toBe(0);
  });
});
