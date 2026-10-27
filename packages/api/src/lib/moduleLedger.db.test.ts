/**
 * Step 2, the module ledger (0065-0067), against real upgrades:
 *
 *   upgrade     a 0059 database with data, its ledger in the old shape
 *               (_migrations(name)), Music Connections and Listen elsewhere
 *               on and playlists off in the first library's settings, is
 *               migrated: the switches read the same through installed_modules,
 *               the old keys are gone (other settings stay), every ledger row
 *               is the core's, and the filter-rail rows are the same under
 *               their new names.
 *   defaults    with no library yet, each module gets its old default.
 *   restore     a backup taken before the change restores (doctor restore,
 *               swap) and upgrades again to the same state (needs pg_dump and
 *               pg_restore 16, as restore.db.test.ts does).
 *   round trip  Listen elsewhere plugged in, used, unplugged and purged through
 *               the ledger and its manifest leaves every core row as it was.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  UnknownModuleError, enabledAppIds, listInstalledModules, listenLinksEnabled, mcEnabled, moduleEnabled, moduleSettings, moduleSwitches,
  playlistsEnabled, readLedger, setModuleEnabled, setModuleSettings, syncInstalledModules,
} from '@tagave/db';
import { LISTEN_LINKS_MODULE, ledgerEntries, moduleContext, registry } from '@tagave/core/facets';
import { MODULE_DATA, PurgeRefused, pgDumpBin, pgRestoreBin, purgeModuleData, runBackup, runRestore } from '@tagave/doctor';
import { createScratchDb, migrateAll, migrateUpTo, migrationsBefore } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;
const STEP2 = ['0065_installed_modules.sql', '0066_migrations_by_module.sql', '0067_filter_counts_rename.sql'];

/** A database as 0.15 left it: the ledger in its old shape, migrated to 0059. */
async function oldInstall(admin: postgres.Sql): Promise<{ url: string; name: string }> {
  const db = await createScratchDb(url!, admin);
  const sql = postgres(db.url, { max: 1, onnotice: () => undefined });
  try {
    await sql`create table _migrations (name text primary key, applied_at timestamptz not null default now())`;
  } finally {
    await sql.end({ timeout: 2 });
  }
  await migrateUpTo(db.url, '0060');
  return db;
}

/** How 0.15 read a switch (db/src/mcUnplug.ts, listenLinks.ts, playlistsModule.ts before 0065). */
async function oldSwitches(sql: postgres.Sql): Promise<Record<string, boolean>> {
  const [r] = await sql<Array<{ mc: string | null; ll: string | null; pl: string | null }>>`
    select settings->'modules'->'mc'->>'enabled' as mc, settings->'modules'->'listen-links'->>'enabled' as ll,
           settings->'modules'->'playlists'->>'enabled' as pl
      from libraries order by created_at, id limit 1`;
  return { mc: r?.mc === 'true', 'listen-links': r?.ll === 'true', playlists: r?.pl !== 'false' };
}

async function newSwitches(sql: postgres.Sql): Promise<Record<string, boolean>> {
  return { mc: await mcEnabled(sql), 'listen-links': await listenLinksEnabled(sql), playlists: await playlistsEnabled(sql) };
}

/** The ledger rows without their clocks. */
const ledgerRows = async (sql: postgres.Sql) =>
  (await sql`select id, kind, version, enabled, enabled_at is not null as stamped, schema_version, settings from installed_modules order by id`).map((r) => ({ ...r }));

describe('migrateUpTo’s cut, with app and module chains', () => {
  it('stops in the core chain before a core file, or in a chain before its entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tagave-cut-'));
    try {
      for (const f of ['0001_a.sql', '0002_b.sql', 'apps/books/0001_x.sql', 'modules/decider/0001_d.sql', 'modules/decider/0002_e.sql', 'modules/zeta/0001_z.sql']) {
        await mkdir(join(dir, f, '..'), { recursive: true });
        await writeFile(join(dir, f), '');
      }
      expect(await migrationsBefore('0002', dir)).toEqual(['0001_a.sql']);
      expect(await migrationsBefore('9999', dir)).toEqual(['0001_a.sql', '0002_b.sql']);
      expect(await migrationsBefore('decider/0002', dir)).toEqual(['0001_a.sql', '0002_b.sql', 'books/0001_x.sql', 'decider/0001_d.sql']);
      expect(await migrationsBefore('decider/9999', dir)).toEqual(['0001_a.sql', '0002_b.sql', 'books/0001_x.sql', 'decider/0001_d.sql', 'decider/0002_e.sql']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!url)('step 2 upgrade from 0059 with data (old ledger shape)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  const ids = { user: randomUUID(), lib1: randomUUID(), lib2: randomUUID(), album: randomUUID() };
  let before: { switches: Record<string, boolean>; ledger: string[]; counts: unknown[]; state: unknown[] };
  let applied: string[];

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await oldInstall(admin);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await sql`insert into users (id, email, display_name, password_hash) values (${ids.user}, ${`m-${ids.user}@test.com`}, 'M', 'x')`;
    // the first library holds the switches (and the owner's own settings, which stay)
    await sql`insert into libraries (id, owner_user_id, name, created_at, settings) values
      (${ids.lib1}, ${ids.user}, 'First', '2026-01-01T00:00:00Z', ${sql.json({
        playerUrl: 'http://own:4533', lastfmApiKey: 'k',
        modules: { mc: { enabled: true, note: 'kept' }, 'listen-links': { enabled: true }, playlists: { enabled: false } },
      })}),
      (${ids.lib2}, ${ids.user}, 'Second', '2026-02-01T00:00:00Z', ${sql.json({ foo: 1, modules: { mc: { enabled: false } } })})`;
    await sql`insert into local_albums (id, library_id, cluster_key, state) values (${ids.album}, ${ids.lib1}, 'k-ledger', 'needs_review')`;
    await sql`insert into album_facets (album_id, library_id, state, format, containers, decade, labels, genres, gap_kinds, owned, decided)
              values (${ids.album}, ${ids.lib1}, 'needs_review', 'lossless', '{FLAC}', 1990, '{Warp}', '{ambient}', '{}', true, '{by_me}')`;
    await sql`insert into facet_state (library_id, computed_at, dirty_at, album_count, duration_ms, artists_at)
              values (${ids.lib1}, '2026-03-01T00:00:00Z', null, 1, 12, '2026-03-01T00:00:01Z')`;
    before = {
      switches: await oldSwitches(sql),
      ledger: (await sql`select name from _migrations order by name`).map((r) => r['name'] as string),
      counts: [...(await sql`select * from album_facets order by album_id`)],
      state: [...(await sql`select * from facet_state order by library_id`)],
    };
    applied = await migrateAll(db.url);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('applies the three step-2 migrations on top of 0059', () => {
    expect(before.switches).toEqual({ mc: true, 'listen-links': true, playlists: false });
    expect(applied).toEqual(STEP2);
  });

  it('every switch reads the same through installed_modules, and through the registry', async () => {
    expect(await newSwitches(sql)).toEqual(before.switches);
    expect(await ledgerRows(sql)).toEqual([
      { id: 'listen-links', kind: 'in-process', version: '1.0.0', enabled: true, stamped: true, schema_version: null, settings: {} },
      { id: 'mc', kind: 'in-process', version: '1.0.0', enabled: true, stamped: true, schema_version: null, settings: {} },
      { id: 'music', kind: 'app', version: '1.0.0', enabled: true, stamped: true, schema_version: null, settings: {} },
      { id: 'playlists', kind: 'in-process', version: '1.0.0', enabled: false, stamped: false, schema_version: null, settings: {} },
    ]);
    const ctx = moduleContext(await moduleSwitches(sql));
    expect(['mc', 'listen-links', 'playlists'].map((id) => registry.isEnabled(id, ctx))).toEqual([true, true, false]);
    // a boot's sync changes no switch
    expect(await syncInstalledModules(sql, ledgerEntries())).toEqual([]);
    expect(await newSwitches(sql)).toEqual(before.switches);
  });

  it('the old switches are gone from the settings; everything else in them stays', async () => {
    const libs = await sql`select id, settings from libraries order by created_at`;
    expect(libs.map((l) => l['settings'])).toEqual([
      { playerUrl: 'http://own:4533', lastfmApiKey: 'k', modules: { mc: { note: 'kept' } } },
      { foo: 1 },
    ]);
  });

  it('every ledger row is the core’s, keyed (module, name)', async () => {
    const rows = await sql`select module, name from _migrations order by name`;
    expect(rows.every((r) => r['module'] === 'core')).toBe(true);
    expect(rows.map((r) => r['name'])).toEqual([...before.ledger, ...STEP2]);
    expect(await readLedger(sql)).toEqual([...before.ledger, ...STEP2]);
    const [pk] = await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = '_migrations'::regclass and contype = 'p'`;
    expect(pk!['def']).toBe('PRIMARY KEY (module, name)');
  });

  it('the filter rail’s rows are the same under their new names, with their keys and indexes renamed', async () => {
    expect(await sql`select * from album_filter_counts order by album_id`).toEqual(before.counts);
    expect(await sql`select * from filter_rail_state order by library_id`).toEqual(before.state);
    expect(await sql`select to_regclass('public.album_facets') as a, to_regclass('public.facet_state') as b`).toEqual([{ a: null, b: null }]);
    const idx = await sql`select indexname from pg_indexes where tablename in ('album_filter_counts', 'filter_rail_state') order by 1`;
    expect(idx.map((r) => r['indexname'])).toEqual([
      'album_filter_counts_pkey', 'filter_rail_state_pkey', 'idx_album_filter_counts_gap_kinds', 'idx_album_filter_counts_genres',
      'idx_album_filter_counts_labels', 'idx_album_filter_counts_library',
    ]);
    const cons = await sql`select conname from pg_constraint where conrelid in ('album_filter_counts'::regclass, 'filter_rail_state'::regclass) order by 1`;
    expect(cons.map((r) => r['conname'])).toEqual([
      'album_filter_counts_album_id_fkey', 'album_filter_counts_library_id_fkey', 'album_filter_counts_pkey',
      'filter_rail_state_library_id_fkey', 'filter_rail_state_pkey',
    ]);
  });

  it('running the step-2 files again changes nothing', async () => {
    const snap = async () => ({ ledger: await ledgerRows(sql), libs: await sql`select settings from libraries order by created_at`, migs: await readLedger(sql) });
    const was = await snap();
    const { readFile } = await import('node:fs/promises');
    const { MIGRATIONS_DIR } = await import('@tagave/db');
    for (const f of STEP2) {
      await sql.begin(async (tx) => {
        await tx.unsafe(await readFile(join(MIGRATIONS_DIR, f), 'utf8'));
      });
    }
    expect(await snap()).toEqual(was);
  });
});

describe.skipIf(!url)('step 2 upgrade: the defaults when no library holds a switch', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let beforeLedger: unknown;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await oldInstall(admin);
    sql = postgres(db.url, { max: 1, onnotice: () => undefined });
    // what a worker running on this database with TAGAVE_ALLOW_SCHEMA_SKEW reads
    beforeLedger = {
      mc: await moduleEnabled(sql, 'mc'),
      switches: await moduleSwitches(sql),
      apps: await enabledAppIds(sql),
      settings: await moduleSettings(sql, 'mc'),
    };
    await migrateAll(db.url);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('before 0065 every module reads as off and no app as on (built-in apps are on regardless)', () => {
    expect(beforeLedger).toEqual({ mc: false, switches: {}, apps: [], settings: {} });
  });

  it('Music Connections and Listen elsewhere off, playlists on, music on: as the settings read when absent', async () => {
    expect(await newSwitches(sql)).toEqual({ mc: false, 'listen-links': false, playlists: true });
    expect(await moduleEnabled(sql, 'music')).toBe(true);
    expect(await moduleEnabled(sql, 'no-such-module')).toBe(false);
    // a mistyped id is refused, and never becomes a row
    await expect(setModuleEnabled(sql, 'no-such-module', true)).rejects.toBeInstanceOf(UnknownModuleError);
    await expect(setModuleSettings(sql, 'no-such-module', { a: 1 })).rejects.toBeInstanceOf(UnknownModuleError);
    expect(await sql`select 1 from installed_modules where id = 'no-such-module'`).toHaveLength(0);
  });
});

function pgToolsMissing(): string | null {
  for (const bin of [pgDumpBin(), pgRestoreBin()]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
    } catch {
      return `${bin} is not available (install postgresql-client-16 or set PG_DUMP / PG_RESTORE)`;
    }
  }
  return null;
}
const toolsMissing = url ? pgToolsMissing() : 'TEST_DATABASE_URL is not set';
if (toolsMissing) console.warn(`[moduleLedger.db.test] backup restore skipped: ${toolsMissing}`);

describe.skipIf(!!toolsMissing)('a backup taken before step 2 restores and upgrades again', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let dir: string;
  const drop: string[] = [];
  const ids = { user: randomUUID(), lib: randomUUID() };

  const state = async (dbUrl: string) => {
    const sql = postgres(dbUrl, { max: 1, onnotice: () => undefined });
    try {
      return {
        switches: await newSwitches(sql),
        ledger: await ledgerRows(sql),
        migrations: await readLedger(sql),
        settings: await sql`select id, settings from libraries order by id`,
        tables: await sql`select to_regclass('public.album_filter_counts')::text as counts, to_regclass('public.filter_rail_state')::text as rail`,
      };
    } finally {
      await sql.end({ timeout: 2 });
    }
  };

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await oldInstall(admin);
    drop.push(db.name);
    dir = await mkdtemp(join(tmpdir(), 'tagave-ledger-bk-'));
    const sql = postgres(db.url, { max: 1, onnotice: () => undefined });
    await sql`insert into users (id, email, display_name, password_hash) values (${ids.user}, ${`r-${ids.user}@test.com`}, 'R', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${ids.lib}, ${ids.user}, 'R',
              ${sql.json({ modules: { mc: { enabled: true }, 'listen-links': { enabled: true } } })})`;
    await sql.end({ timeout: 2 });
  }, 180_000);

  afterAll(async () => {
    for (const name of drop) await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('restores the pre-change dump (old ledger, switches in the settings), and the new app upgrades it to the same state', async () => {
    const dump = await runBackup({ databaseUrl: db.url, outDir: dir, kind: 'manual' });
    expect(dump.tocEntries).toBeGreaterThan(0);
    // the update: step 2 applies
    expect(await migrateAll(db.url)).toEqual(STEP2);
    const upgraded = await state(db.url);
    expect(upgraded.switches).toEqual({ mc: true, 'listen-links': true, playlists: true });

    // roll back to the dump taken before it
    const restored = await runRestore({ databaseUrl: db.url, file: dump.path, mode: 'swap', force: true, backupDir: dir, queueThumbSweep: async () => undefined });
    if (restored.previousDatabase) drop.push(restored.previousDatabase);
    expect(restored.latestMigration).toBe('0059_user_prefs.sql');
    const sql = postgres(db.url, { max: 1, onnotice: () => undefined });
    try {
      expect(await oldSwitches(sql)).toEqual({ mc: true, 'listen-links': true, playlists: true });
      expect(await sql`select to_regclass('public.installed_modules') as t`).toEqual([{ t: null }]);
      expect(await sql`select count(*)::int as n from information_schema.columns where table_name = '_migrations' and column_name = 'module'`).toEqual([{ n: 0 }]);
    } finally {
      await sql.end({ timeout: 2 });
    }

    // and the new app upgrades the restored database again, to the same state
    expect(await migrateAll(db.url)).toEqual(STEP2);
    expect(await state(db.url)).toEqual(upgraded);
  }, 180_000);
});

describe.skipIf(!url)('plug and unplug Listen elsewhere through the ledger: core rows stay as they were', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  const ids = { user: randomUUID(), lib: randomUUID(), rg: randomUUID(), artist: randomUUID() };

  const core = async () => ({
    users: await sql`select id, email, role from users order by id`,
    libraries: await sql`select id, name, settings from libraries order by id`,
    releaseGroups: await sql`select * from release_groups order by id`,
    artists: await sql`select * from artists order by id`,
    // the ledger's other rows; listen-links' own row is its switch
    ledger: (await ledgerRows(sql)).filter((r) => r['id'] !== 'listen-links'),
  });

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateAll(db.url);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await sql`insert into users (id, email, password_hash) values (${ids.user}, ${`p-${ids.user}@test.com`}, 'x')`;
    await sql`insert into libraries (id, owner_user_id, name) values (${ids.lib}, ${ids.user}, 'Plug')`;
    await sql`insert into release_groups (id, mbid, title) values (${ids.rg}, ${randomUUID()}, 'Linked')`;
    await sql`insert into artists (id, mbid, name) values (${ids.artist}, ${randomUUID()}, 'Linked artist')`;
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('on → used → off keeps its data; purge deletes exactly its tables; the core and the switch row stay', async () => {
    const was = await core();
    expect(await moduleEnabled(sql, 'listen-links')).toBe(false);

    // plug in
    await setModuleEnabled(sql, 'listen-links', true);
    expect(registry.isEnabled('listen-links', moduleContext(await moduleSwitches(sql)))).toBe(true);
    // use: what listenLinks.resolve and a person write
    await sql`insert into listen_links (release_group_id, platform, url, source) values (${ids.rg}, 'qobuz', 'https://play.qobuz.com/album/x1', 'mb-release')`;
    await sql`insert into listen_artist_links (artist_id, platform, url, source) values (${ids.artist}, 'qobuz', 'https://play.qobuz.com/artist/1', 'mb-artist')`;
    await sql`insert into listen_album_checks (release_group_id, platforms, found) values (${ids.rg}, '{qobuz}', 1)`;
    await sql`insert into listen_artist_checks (artist_id, platforms, found) values (${ids.artist}, '{qobuz}', 1)`;
    await sql`insert into listen_prefs (user_id, platforms) values (${ids.user}, '{qobuz}')`;
    // the purge refuses while it is on
    await expect(purgeModuleData(sql as never, 'listen-links', { env: {} })).rejects.toBeInstanceOf(PurgeRefused);

    // unplug: function goes, data stays (rule 2)
    await setModuleEnabled(sql, 'listen-links', false);
    expect(registry.isEnabled('listen-links', moduleContext(await moduleSwitches(sql)))).toBe(false);
    for (const t of LISTEN_LINKS_MODULE.tables) expect(await sql`select 1 from ${sql(t)}`, t).toHaveLength(1);

    // delete its data: exactly the tables its manifest lists, in its order
    expect(MODULE_DATA['listen-links']!.tables).toEqual(LISTEN_LINKS_MODULE.tables);
    const purged = await purgeModuleData(sql as never, 'listen-links', { env: {} });
    expect(Object.entries(purged.deleted)).toEqual(LISTEN_LINKS_MODULE.tables.map((t) => [t, 1]));
    for (const t of LISTEN_LINKS_MODULE.tables) expect(await sql`select 1 from ${sql(t)}`, t).toHaveLength(0);

    // the core is as it was, and the switch row is there, off
    expect(await core()).toEqual(was);
    const [row] = (await listInstalledModules(sql)).filter((m) => m.id === 'listen-links');
    expect(row).toMatchObject({ kind: 'in-process', enabled: false, enabledAt: null, settings: {} });
    // again: nothing left to delete
    expect(Object.values((await purgeModuleData(sql as never, 'listen-links', { env: {} })).deleted).every((n) => n === 0)).toBe(true);
  });

  it('every module purge-module knows lists a table before the tables it references (the order it empties them)', async () => {
    const refs = await sql<Array<{ t: string; ref: string }>>`
      select c.conrelid::regclass::text as t, c.confrelid::regclass::text as ref from pg_constraint c where c.contype = 'f'`;
    expect(Object.keys(MODULE_DATA).sort()).toEqual(['listen-links', 'player', 'playlists']);
    for (const [id, data] of Object.entries(MODULE_DATA)) {
      const at = new Map(data.tables.map((t, i) => [t, i]));
      for (const r of refs) {
        if (r.t === r.ref || !at.has(r.t) || !at.has(r.ref)) continue;
        expect(at.get(r.t)!, `${id}: ${r.t} references ${r.ref}`).toBeLessThan(at.get(r.ref)!);
      }
    }
  });

  it('Music Connections fills core gaps, so only its own removal deletes its data', async () => {
    await expect(purgeModuleData(sql as never, 'mc', { env: {} })).rejects.toThrow(/removes its own data/);
  });

  it('a new module needs only its manifest: the boot sync makes its row at its default, and never touches a switch', async () => {
    const entries = [...ledgerEntries(), { id: 'decider', kind: 'in-process' as const, version: '1.0.0', defaultEnabled: true }];
    await sql`insert into _migrations (module, name) values ('decider', '0001_decider.sql'), ('decider', '0002_more.sql')`;
    try {
      expect(await syncInstalledModules(sql, entries)).toEqual(['decider']);
      expect((await listInstalledModules(sql)).find((m) => m.id === 'decider')).toMatchObject({ kind: 'in-process', version: '1.0.0', enabled: true, schemaVersion: '0002_more.sql', settings: {} });
      // the owner turns it off; a later boot (a newer version) keeps that
      await setModuleEnabled(sql, 'decider', false);
      expect(await syncInstalledModules(sql, entries.map((e) => (e.id === 'decider' ? { ...e, version: '1.1.0' } : e)))).toEqual([]);
      expect((await listInstalledModules(sql)).find((m) => m.id === 'decider')).toMatchObject({ version: '1.1.0', enabled: false, enabledAt: null });
      // on stamps enabled_at once; on again keeps it
      await setModuleEnabled(sql, 'decider', true);
      const at = (await sql`select enabled_at as at from installed_modules where id = 'decider'`)[0]!['at'];
      await setModuleEnabled(sql, 'decider', true);
      expect((await sql`select enabled_at as at from installed_modules where id = 'decider'`)[0]!['at']).toEqual(at);
      // its own settings: merged, a null removes a key
      expect(await setModuleSettings(sql, 'decider', { threshold: 0.8, mode: 'auto' })).toEqual({ threshold: 0.8, mode: 'auto' });
      expect(await setModuleSettings(sql, 'decider', { mode: null })).toEqual({ threshold: 0.8 });
      expect(await moduleSettings(sql, 'decider')).toEqual({ threshold: 0.8 });
      expect(await moduleSettings(sql, 'nobody')).toEqual({});
      await expect(setModuleSettings(sql, 'nobody', { a: 1 })).rejects.toBeInstanceOf(UnknownModuleError);
    } finally {
      await sql`delete from installed_modules where id = 'decider'`;
      await sql`delete from _migrations where module = 'decider'`;
    }
  });
});
