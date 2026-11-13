/**
 * The autotagger module's switch, per-library settings and data, against a
 * real database: the ledger row is the switch (no row reads off), the
 * settings are the defaults until the owner sets one, a patch is validated
 * before anything is written, deleting its data empties exactly its
 * tables, and the drizzle mirror has every column its migration made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import postgres from 'postgres';
import {
  AUTOTAGGER_TABLES, AutotaggerStillOnError, DEFAULT_AUTOTAGGER_CONFIG as DB_DEFAULTS, UnknownModuleError, autotaggerConfig, autotaggerEnabled, deciderCalls,
  deciderDecisions, deciderLibrarySettings, deciderModels, deciderPrices, deciderRuns, deciderSpotChecks, makeDb, removeAutotaggerData, runMigrations,
  clearTypesafeKey, markPayloadSeen, setAutotaggerConfig, storeModel, setAutotaggerEnabled, setTypesafeKey, syncInstalledModules, typesafeKeyHint, typesafeKeyHintOf, type AutotaggerConfig as DbConfig, type AutotaggerConfigPatch as DbPatch,
} from '@tagave/db';
import {
  DEFAULT_AUTOTAGGER_CONFIG, autotaggerConfigPatchSchema, deciderPriceSchema, type AutotaggerConfig, type AutotaggerConfigPatch,
} from '@tagave/shared';
import { AUTOTAGGER_MODULE, ledgerEntries } from '@tagave/core/facets';
import { openSecret, sealSecret } from '@tagave/core';

// The two copies of the config shape (db keeps its own: it depends on no
// other tagave package) must stay the same, both ways. tsc enforces it (the
// worker's tsconfig includes its tests): a drift makes these two constants
// fail to type-check. The runtime expect below only marks the check.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameConfig: Same<DbConfig, AutotaggerConfig> = true;
const samePatch: Same<Required<DbPatch>, Required<AutotaggerConfigPatch>> = true;
const parse = (raw: unknown) => autotaggerConfigPatchSchema.parse(raw);

class Rollback extends Error {}

describe('autotagger config shape', () => {
  it('db and shared agree on the defaults; the patch schema refuses unknown keys and out-of-range values', () => {
    expect([sameConfig, samePatch]).toEqual([true, true]);
    expect(DB_DEFAULTS).toEqual(DEFAULT_AUTOTAGGER_CONFIG);
    expect(DEFAULT_AUTOTAGGER_CONFIG).toEqual({
      decider: 'local', model: 'jev-latest', monthlyCap: null, currency: 'USD', maxErrorRate: 0.01, maxRequestBytes: null, payloadSeenAt: null, payloadSeenBy: null,
    });
    expect(parse({ monthlyCap: 20, model: 'jev-2026-09-15' })).toEqual({ monthlyCap: 20, model: 'jev-2026-09-15' });
    expect(parse({ monthlyCap: null, maxRequestBytes: null })).toEqual({ monthlyCap: null, maxRequestBytes: null });
    for (const bad of [
      { payloadSeenAt: '2026-10-01' }, { typesafeKey: 'x' }, { model: 'Jev' }, { model: '' }, { monthlyCap: -1 }, { monthlyCap: 100_001 },
      { currency: 'usd' }, { maxErrorRate: 0 }, { maxErrorRate: 0.3 }, { maxRequestBytes: 1000 }, { maxRequestBytes: 10_000_001 },
    ]) expect(autotaggerConfigPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(deciderPriceSchema.parse({ model: '*', perMillionInput: 1.5, currency: 'USD' })).toEqual({ model: '*', perMillionInput: 1.5, currency: 'USD' });
    expect(deciderPriceSchema.safeParse({ model: 'Any', perMillionInput: 1, currency: 'USD' }).success).toBe(false);
    expect(deciderPriceSchema.safeParse({ model: '*', perMillionInput: -1, currency: 'USD' }).success).toBe(false);
  });

  it('the hint of a plain key is its last four characters', () => {
    expect(typesafeKeyHintOf('ts-abcdefgh1234')).toBe('1234');
    expect(typesafeKeyHintOf('xyz')).toBe('xyz');
    expect(typesafeKeyHintOf('')).toBe('');
  });

  it('db lists the same tables as the manifest, in its purge order', () => {
    expect([...AUTOTAGGER_TABLES]).toEqual([...AUTOTAGGER_MODULE.tables]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('autotagger module (shared db: its own libraries only)', () => {
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const otherLibrary = randomUUID();

  beforeAll(async () => {
    client = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`at-${userId}@test.com`}, 'x')`;
    for (const id of [libraryId, otherLibrary]) await client`insert into libraries (id, owner_user_id, name, settings) values (${id}, ${userId}, 'Autotagger', '{}'::jsonb)`;
  });

  afterAll(async () => {
    await client`delete from libraries where id = any(${[libraryId, otherLibrary]}::uuid[])`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('settings: the defaults until set; a patch merges and keeps the rest; a bad patch writes nothing', async () => {
    expect(await autotaggerConfig(client, libraryId)).toEqual(DEFAULT_AUTOTAGGER_CONFIG);
    expect(await setAutotaggerConfig(client, libraryId, { monthlyCap: 20 }, parse)).toEqual({ ...DEFAULT_AUTOTAGGER_CONFIG, monthlyCap: 20 });
    expect(await setAutotaggerConfig(client, libraryId, { model: 'jev-2026-09-15' }, parse)).toEqual({ ...DEFAULT_AUTOTAGGER_CONFIG, monthlyCap: 20, model: 'jev-2026-09-15' });
    expect(await setAutotaggerConfig(client, libraryId, { monthlyCap: null }, parse)).toEqual({ ...DEFAULT_AUTOTAGGER_CONFIG, model: 'jev-2026-09-15' });
    await expect(setAutotaggerConfig(client, libraryId, { maxErrorRate: 5 }, parse)).rejects.toThrow();
    await expect(setAutotaggerConfig(client, libraryId, { sealedKey: 'x' }, parse)).rejects.toThrow();
    expect(await autotaggerConfig(client, libraryId)).toEqual({ ...DEFAULT_AUTOTAGGER_CONFIG, model: 'jev-2026-09-15' });
    // per library, and in the module's own table, not libraries.settings
    expect(await autotaggerConfig(client, otherLibrary)).toEqual(DEFAULT_AUTOTAGGER_CONFIG);
    expect((await client`select settings from libraries where id = ${libraryId}`)[0].settings).toEqual({});
    expect((await client`select config from decider_library_settings where library_id = ${libraryId}`)[0].config).toEqual({ model: 'jev-2026-09-15', monthlyCap: null });
  });

  it('the API key: stored only sealed, with its hint; the plain key is refused and nothing is written', async () => {
    const SECRET = 'test-app-secret-0123456789abcdef01234567';
    const plain = `ts-${randomUUID()}-wxyz`;
    const sealed = sealSecret(plain, SECRET);
    expect(await typesafeKeyHint(client, libraryId)).toBeNull();
    await expect(setTypesafeKey(client, libraryId, plain, 'wxyz')).rejects.toThrow(/sealed/);
    await expect(setTypesafeKey(client, libraryId, sealed, 'wxyz-too-long')).rejects.toThrow(/hint/);
    // the error never carries the value it refused
    await setTypesafeKey(client, libraryId, plain, 'wxyz').catch((e: Error) => expect(e.message).not.toContain(plain));
    expect(await client`select sealed_key from decider_library_settings where library_id = ${libraryId} and sealed_key is not null`).toHaveLength(0);
    // the table refuses a plain key too, whoever writes it
    for (const [key, hint] of [[plain, null], ['enc:', null], [sealed, 'wxyz5']]) {
      await expect(client`insert into decider_library_settings (library_id, sealed_key, key_hint) values (${otherLibrary}, ${key}, ${hint}) on conflict (library_id) do update set sealed_key = excluded.sealed_key, key_hint = excluded.key_hint`, `${hint}`).rejects.toThrow(/check/);
    }

    await setTypesafeKey(client, libraryId, sealed, 'wxyz');
    expect(await typesafeKeyHint(client, libraryId)).toBe('wxyz');
    const [row] = await client`select sealed_key, key_hint from decider_library_settings where library_id = ${libraryId}`;
    expect(row.sealed_key).toBe(sealed);
    expect(openSecret(row.sealed_key, SECRET)).toBe(plain);
    // the settings stay as they were, and never carry the key
    const config = await autotaggerConfig(client, libraryId);
    expect(config).toEqual({ ...DEFAULT_AUTOTAGGER_CONFIG, model: 'jev-2026-09-15' });
    const patched = await setAutotaggerConfig(client, libraryId, { currency: 'EUR' }, parse);
    for (const read of [config, patched]) {
      const text = JSON.stringify(read);
      expect(text).not.toContain(sealed);
      expect(text).not.toContain(plain);
      expect(Object.keys(read).some((k) => /key|hint/i.test(k))).toBe(false);
    }
    expect((await client`select settings from libraries where id = ${libraryId}`)[0].settings).toEqual({});

    await clearTypesafeKey(client, libraryId);
    expect(await typesafeKeyHint(client, libraryId)).toBeNull();
    expect((await client`select sealed_key, key_hint from decider_library_settings where library_id = ${libraryId}`)[0]).toEqual({ sealed_key: null, key_hint: null });
    // clearing a library that has no row is a no-op
    await clearTypesafeKey(client, randomUUID());
    expect(await autotaggerConfig(client, libraryId)).toEqual({ ...DEFAULT_AUTOTAGGER_CONFIG, model: 'jev-2026-09-15', currency: 'EUR' });
    await setAutotaggerConfig(client, libraryId, { currency: 'USD' }, parse);
  });

  it('seeing the payload preview is recorded server-side, merged into the settings; the patch cannot set it', async () => {
    const lib = randomUUID();
    await client`insert into libraries (id, owner_user_id, name) values (${lib}, ${userId}, 'Seen')`;
    try {
      await expect(setAutotaggerConfig(client, lib, { payloadSeenAt: new Date().toISOString() }, parse)).rejects.toThrow();
      await setAutotaggerConfig(client, lib, { monthlyCap: 5 }, parse);
      const before = Date.now();
      const seen = await markPayloadSeen(client, lib, userId);
      expect(seen).toEqual({ ...DEFAULT_AUTOTAGGER_CONFIG, monthlyCap: 5, payloadSeenBy: userId, payloadSeenAt: expect.any(String) });
      expect(Date.parse(seen.payloadSeenAt!)).toBeGreaterThanOrEqual(before - 1000);
      expect(await autotaggerConfig(client, lib)).toEqual(seen);
      // a later patch keeps it
      expect(await setAutotaggerConfig(client, lib, { currency: 'EUR' }, parse)).toMatchObject({ payloadSeenBy: userId, payloadSeenAt: seen.payloadSeenAt, currency: 'EUR' });
      // a library with no settings row yet gets one
      expect((await markPayloadSeen(client, otherLibrary, userId)).payloadSeenBy).toBe(userId);
      await client`update decider_library_settings set config = config - 'payloadSeenAt' - 'payloadSeenBy' where library_id = ${otherLibrary}`;
    } finally {
      await client`delete from libraries where id = ${lib}`;
    }
  });

  it('deleting a library deletes its settings row', async () => {
    const gone = randomUUID();
    await client`insert into libraries (id, owner_user_id, name) values (${gone}, ${userId}, 'Gone')`;
    await setAutotaggerConfig(client, gone, { currency: 'EUR' }, parse);
    await client`delete from libraries where id = ${gone}`;
    expect(await client`select 1 from decider_library_settings where library_id = ${gone}`).toHaveLength(0);
  });

  it('the drizzle schema has every column the module migration made', async () => {
    const tables = {
      decider_library_settings: deciderLibrarySettings, decider_prices: deciderPrices, decider_runs: deciderRuns,
      decider_calls: deciderCalls, decider_decisions: deciderDecisions, decider_spot_checks: deciderSpotChecks, decider_models: deciderModels,
    };
    expect(Object.keys(tables).sort()).toEqual([...AUTOTAGGER_TABLES].sort());
    for (const [name, table] of Object.entries(tables)) {
      const inDb = (await client`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = ${name}`).map((r: any) => r.c).sort();
      const inSchema = Object.values(getTableColumns(table)).map((c) => c.name).sort();
      expect(inDb.length, name).toBeGreaterThan(0);
      expect(inSchema, name).toEqual(inDb);
    }
  });

  it('no core table references the module’s tables', async () => {
    const refs = await client`
      select c.conrelid::regclass::text as t, c.confrelid::regclass::text as ref from pg_constraint c
       where c.contype = 'f' and c.confrelid::regclass::text = any(${[...AUTOTAGGER_TABLES]}::text[])`;
    expect(refs.filter((r: any) => !(AUTOTAGGER_TABLES as readonly string[]).includes(r.t))).toEqual([]);
  });
});

/**
 * A database of its own, migrated in full and synced as a boot does: the
 * tests below switch the module on and empty its whole tables, which on the
 * shared test database would clash with other packages' suites running at
 * the same time.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('autotagger module (scratch db: the switch, deleting its data)', () => {
  let admin: postgres.Sql;
  let client: any;
  const name = `tagave_attest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const userId = randomUUID();
  const libraryId = randomUUID();

  beforeAll(async () => {
    admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    await runMigrations(u.toString(), { log: () => undefined });
    client = (await makeDb(u.toString())).client;
    await syncInstalledModules(client, ledgerEntries());
    await client`insert into users (id, email, password_hash) values (${userId}, ${`at-${userId}@test.com`}, 'x')`;
    await client`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${userId}, 'Autotagger', '{}'::jsonb)`;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('the switch is the module ledger: off from the start, on and off again, and no row reads off', async () => {
    const [row] = await client`select enabled, kind, schema_version from installed_modules where id = 'autotagger'`;
    expect(row).toMatchObject({ enabled: false, kind: 'in-process', schema_version: '0002_decider_models.sql' });
    expect(await autotaggerEnabled(client)).toBe(false);
    await setAutotaggerEnabled(client, true);
    expect(await autotaggerEnabled(client)).toBe(true);
    await setAutotaggerEnabled(client, false);
    expect(await autotaggerEnabled(client)).toBe(false);
    // as on an install whose boot has not made the row yet (rolled back)
    await expect(client.begin(async (tx: any) => {
      await tx`delete from installed_modules where id = 'autotagger'`;
      expect(await autotaggerEnabled(tx)).toBe(false);
      await expect(setAutotaggerEnabled(tx, true)).rejects.toBeInstanceOf(UnknownModuleError);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect((await client`select 1 from installed_modules where id = 'autotagger'`).length).toBe(1);
  });

  it('removeAutotaggerData refuses while the module is on, and deletes nothing', async () => {
    await client`insert into decider_prices (decider_id, model, per_million_input, currency) values ('jev-on', '*', 1.5, 'USD')`;
    await setAutotaggerEnabled(client, true);
    try {
      await expect(removeAutotaggerData(client)).rejects.toBeInstanceOf(AutotaggerStillOnError);
      expect(await client`select 1 from decider_prices where decider_id = 'jev-on'`).toHaveLength(1);
    } finally {
      await setAutotaggerEnabled(client, false);
    }
  });

  it('removeAutotaggerData empties exactly its tables and returns a count per table; accept batches stay', async () => {
    const album = randomUUID();
    await client`insert into local_albums (id, library_id, cluster_key, state) values (${album}, ${libraryId}, ${`k-at-${album}`}, 'needs_review')`;
    await setAutotaggerConfig(client, libraryId, { monthlyCap: 5 }, parse);
    await client`insert into decider_prices (decider_id, model, per_million_input, currency) values ('jev', '*', 1.5, 'USD')`;
    const [run] = await client`insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population) values (${libraryId}, 'jev', 'h', 'jev-latest', 'needs_review') returning id`;
    const [call] = await client`insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers)
      values (${libraryId}, ${album}, ${run.id}, ${'e'.repeat(64)}, 'h', 'jev', 'jev-2026-09-15', 100, 10, 0.001, 'USD', '{}'::jsonb) returning id`;
    const [dec] = await client`insert into decider_decisions (run_id, local_album_id, call_id, outcome, band) values (${run.id}, ${album}, ${call.id}, 'pick', 'high') returning id`;
    await client`insert into decider_spot_checks (run_id, decision_id, band) values (${run.id}, ${dec.id}, 'high')`;
    const [batch] = await client`insert into decider_batches (library_id, decider_id, decided_kind, run_id) values (${libraryId}, 'jev', 'model', ${run.id}) returning id`;
    await storeModel(client, { libraryId, version: 'local@purge', featuresSchemaHash: 'f'.repeat(64), model: {}, dataHash: 'd'.repeat(64), counts: { albums: 0, rows: 0, owner: 0, auto: 0, rejections: 0 }, metrics: {} });

    const counts = await removeAutotaggerData(client);
    expect(Object.keys(counts)).toEqual([...AUTOTAGGER_TABLES]);
    for (const t of ['decider_spot_checks', 'decider_decisions', 'decider_calls', 'decider_runs', 'decider_prices', 'decider_library_settings', 'decider_models'] as const) {
      expect(counts[t], t).toBeGreaterThanOrEqual(1);
    }
    for (const t of AUTOTAGGER_TABLES) expect(await client`select 1 from ${client(t)} where true`, t).toHaveLength(0);
    // core: the batch (and its run id) stays
    expect(await client`select run_id from decider_batches where id = ${batch.id}`).toEqual([{ run_id: run.id }]);
    expect(Object.values(await removeAutotaggerData(client)).every((n) => n === 0)).toBe(true);
    await client`delete from decider_batches where id = ${batch.id}`;
  });
});
