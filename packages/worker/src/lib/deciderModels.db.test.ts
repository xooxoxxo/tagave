/**
 * The local decider's stored models against a real database (shared test
 * database, its own libraries only): one active model per library and
 * decider, a new one replaces it in one transaction, the list is newest
 * first, and a database without the module's table reads as having none.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { activeModel, listModels, makeDb, storeModel, type DeciderModelCounts, type NewDeciderModel } from '@tagave/db';

const counts: DeciderModelCounts = { albums: 3, rows: 9, owner: 2, auto: 1, rejections: 0 };
const row = (libraryId: string, version: string, extra: Partial<NewDeciderModel> = {}): NewDeciderModel => ({
  libraryId, version, featuresSchemaHash: 'a'.repeat(64), model: { version: 1, coefficients: [0.5, -1.25] },
  dataHash: 'b'.repeat(64), counts, metrics: { bands: [{ band: 'p99', decided: 2 }] }, ...extra,
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider models (shared db: its own libraries only)', () => {
  let client: any;
  const userId = randomUUID();
  const lib = randomUUID();
  const other = randomUUID();

  beforeAll(async () => {
    client = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`dm-${userId}@test.com`}, 'x')`;
    for (const id of [lib, other]) await client`insert into libraries (id, owner_user_id, name) values (${id}, ${userId}, 'Models')`;
  });

  afterAll(async () => {
    await client`delete from libraries where id = any(${[lib, other]}::uuid[])`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('no model until one is stored; the stored one reads back as written, active', async () => {
    expect(await activeModel(client, lib)).toBeNull();
    expect(await listModels(client, lib, 10)).toEqual([]);
    const stored = await storeModel(client, row(lib, 'local@000000000001'));
    expect(stored).toMatchObject({ libraryId: lib, decider: 'local', version: 'local@000000000001', active: true, counts });
    expect(await activeModel(client, lib)).toEqual(stored);
    expect(stored.model).toEqual({ version: 1, coefficients: [0.5, -1.25] });
    expect(stored.metrics).toEqual({ bands: [{ band: 'p99', decided: 2 }] });
    expect(Number.isNaN(Date.parse(stored.createdAt))).toBe(false);
  });

  it('one active model per library and decider: a new one deactivates the old, other libraries and deciders keep theirs', async () => {
    const otherModel = await storeModel(client, row(other, 'local@0000000000aa'));
    const jevLike = await storeModel(client, row(lib, 'other@1', { decider: 'other' }));
    const before = await activeModel(client, lib);
    const next = await storeModel(client, row(lib, 'local@000000000002'));
    expect((await activeModel(client, lib))!.id).toBe(next.id);
    const listed = await listModels(client, lib, 10);
    expect(listed.map((m) => [m.version, m.active])).toEqual([['local@000000000002', true], ['local@000000000001', false]]);
    expect(listed[1]!.id).toBe(before!.id);
    expect((await activeModel(client, other))!.id).toBe(otherModel.id);
    expect((await activeModel(client, lib, 'other'))!.id).toBe(jevLike.id);
    // the table itself refuses a second active model
    await expect(client`
      insert into decider_models (library_id, version, features_schema_hash, model, data_hash, active)
      values (${lib}, 'local@x', ${'a'.repeat(64)}, '{}'::jsonb, ${'b'.repeat(64)}, true)`).rejects.toThrow(/decider_models_one_active/);
    expect(await client`select count(*)::int as n from decider_models where library_id = ${lib} and decider = 'local' and active`).toEqual([{ n: 1 }]);
  });

  it('two stores at once: both rows kept, exactly one active', async () => {
    const [a, b] = await Promise.all([storeModel(client, row(lib, 'local@00000000000a')), storeModel(client, row(lib, 'local@00000000000b'))]);
    const active = await client`select id from decider_models where library_id = ${lib} and decider = 'local' and active`;
    expect(active).toHaveLength(1);
    expect([a.id, b.id]).toContain(active[0].id);
    expect(await client`select 1 from decider_models where id = any(${[a.id, b.id]}::uuid[])`).toHaveLength(2);
  });

  it('a failed store changes nothing: the old model stays active', async () => {
    const before = await activeModel(client, lib);
    await expect(storeModel(client, row(lib, 'x'.repeat(41)))).rejects.toThrow();
    expect((await activeModel(client, lib))!.id).toBe(before!.id);
  });

  it('inside the caller’s transaction, rolled back with it', async () => {
    const before = await activeModel(client, lib);
    class Rollback extends Error {}
    await expect(client.begin(async (tx: any) => {
      const s = await storeModel(tx, row(lib, 'local@00000000000c'));
      expect((await activeModel(tx, lib))!.id).toBe(s.id);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect((await activeModel(client, lib))!.id).toBe(before!.id);
  });

  it('listModels: newest first, limited', async () => {
    const two = await listModels(client, lib, 2);
    expect(two).toHaveLength(2);
    const all = await listModels(client, lib, 100);
    expect(all.length).toBeGreaterThan(2);
    expect(all.slice(0, 2).map((m) => m.id)).toEqual(two.map((m) => m.id));
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.createdAt >= all[i]!.createdAt).toBe(true);
  });

  it('deleting the library deletes its models', async () => {
    const gone = randomUUID();
    await client`insert into libraries (id, owner_user_id, name) values (${gone}, ${userId}, 'Gone')`;
    await storeModel(client, row(gone, 'local@00000000000d'));
    await client`delete from libraries where id = ${gone}`;
    expect(await client`select 1 from decider_models where library_id = ${gone}`).toHaveLength(0);
  });

  it('a database without the table (the module never migrated) reads no model', async () => {
    // a connection that sees nothing of public: decider_models is "missing" there
    const blind = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined, connection: { search_path: 'pg_catalog' } });
    try {
      expect(await activeModel(blind, lib)).toBeNull();
      expect(await listModels(blind, lib, 5)).toEqual([]);
    } finally {
      await blind.end({ timeout: 2 });
    }
  });
});
