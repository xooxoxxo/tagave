/**
 * tagave-doctor purge-module against TEST_DATABASE_URL, as the updater runs
 * it (node dist/cli.js … --json in the app container): the JSON line it
 * answers, the refusal while the module is on, and the exit codes. The
 * plug/unplug round trip through the player's own code is in
 * packages/api/src/routes/playerUnplug.db.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { listenLinksEnabled, moduleEnabled, runMigrations, setListenLinksEnabled, setModuleEnabled, setModuleSettings, setTypesafeKey, syncInstalledModules, typesafeKeyHint } from '@tagave/db';
import { AUTOTAGGER_MODULE, ledgerEntries } from '@tagave/core/facets';
import { MODULE_DATA, purgeModuleData } from './modulePurge.js';

const url = process.env.TEST_DATABASE_URL;
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, DATABASE_URL: url!, TAGAVE_PLAYER_URL: '', ...env } }, (err, stdout) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout });
    });
  });
}

describe.skipIf(!url || !existsSync(cli))('purge-module (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  const user = randomUUID();
  const libraryId = randomUUID();
  const rg = randomUUID();

  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => undefined });
    await sql`insert into users (id, email, password_hash) values (${user}, ${`purge-${user}@t.com`}, 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${user}, 'Purge', ${sql.json({ playerLastScan: { state: 'requested' }, playerUrl: 'http://own:4533' })})`;
    await sql`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'Purged')`;
    await sql`insert into scrobble_accounts (user_id, service, account_name, secret_sealed) values (${user}, 'lastfm', 'me', 'enc:v1:x')`;
    await sql`insert into player_scan_requests (library_id, folder) values (${libraryId}, 'A')`;
    await sql`insert into listens (library_id, user_id, release_group_id, listened_at, source) values
      (${libraryId}, ${user}, ${rg}, now(), 'player'), (${libraryId}, ${user}, ${rg}, now(), 'manual')`;
  });

  afterAll(async () => {
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from release_groups where id = ${rg}`;
    await sql`delete from users where id = ${user}`;
    await sql.end({ timeout: 2 });
  });

  it('refuses while the player is configured, and a module it knows nothing of', async () => {
    const on = await run(['purge-module', 'player', '--json'], { TAGAVE_PLAYER_URL: 'http://player:4533' });
    expect(on.code).toBe(3);
    expect(JSON.parse(on.stdout.trim())).toEqual({ refused: true, error: 'player is still on here (TAGAVE_PLAYER_URL is set); turn it off first' });
    expect(await sql`select 1 from scrobble_accounts where user_id = ${user}`).toHaveLength(1);
    expect((await run(['purge-module', 'lyrics', '--json'])).code).toBe(3);
    expect((await run(['purge-module'])).code).toBe(2);
    expect((await run(['purge-module', 'player', '--nope'])).code).toBe(2);
  }, 20_000); // four CLI spawns; vitest's 5 s default was too tight on CI

  it('deletes the rows and answers one JSON line; the listens stay unless asked; the owner\'s settings stay', async () => {
    const first = await run(['purge-module', 'player', '--json']);
    expect(first.code).toBe(0);
    const { purged } = JSON.parse(first.stdout.trim().split('\n').pop()!);
    expect(Object.keys(purged.deleted)).toEqual([...MODULE_DATA['player']!.tables]);
    expect(purged.deleted.scrobble_accounts).toBeGreaterThanOrEqual(1);
    expect(purged.history).toMatchObject({ table: 'listens', action: 'kept' });
    expect(await sql`select source from listens where user_id = ${user} order by source`).toEqual([{ source: 'manual' }, { source: 'player' }]);
    const [lib] = await sql`select settings from libraries where id = ${libraryId}`;
    expect(lib!['settings']).toEqual({ playerUrl: 'http://own:4533' });

    const history = await run(['purge-module', 'player', '--json', '--delete-history']);
    const again = JSON.parse(history.stdout.trim()).purged;
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    expect(again.history).toMatchObject({ action: 'deleted' });
    expect(again.history.count).toBeGreaterThanOrEqual(1);
    expect(await sql`select source from listens where user_id = ${user}`).toEqual([{ source: 'manual' }]);
  }, 20_000); // two CLI spawns

  it('keeps what a server of the owner\'s own uses when its settings are a jsonb string', async () => {
    // As an older writer stored them (a plain client binding JSON.stringify'd
    // settings as jsonb); 0051 unwraps those, a restored dump may bring one back.
    const served = randomUUID();
    const own = { playerUrl: 'http://own:4533', playerUser: 'me', playerPassword: 'enc:v1:x' };
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${served}, ${user}, 'Served', ${JSON.stringify(own)}::jsonb)`;
    try {
      expect(await sql`select jsonb_typeof(settings) as t from libraries where id = ${served}`).toEqual([{ t: 'string' }]);
      await sql`insert into player_scan_requests (library_id, folder) values (${served}, 'B')`;
      const res = await run(['purge-module', 'player', '--json']);
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout.trim().split('\n').pop()!).purged.keptForLibraries).toBe(1);
      expect(await sql`select folder from player_scan_requests where library_id = ${served}`).toEqual([{ folder: 'B' }]);
    } finally {
      await sql`delete from player_scan_requests where library_id = ${served}`;
      await sql`delete from libraries where id = ${served}`;
    }
  }, 20_000);
});

describe.skipIf(!url || !existsSync(cli))('purge-module listen-links (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  const user = randomUUID();
  const libraryId = randomUUID();
  const rg = randomUUID();
  const artist = randomUUID();
  // the switch is the module ledger's row (installed_modules), as it was before is put back
  const setOn = (on: boolean) => setListenLinksEnabled(sql, on);
  let was = false;

  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => undefined });
    was = await listenLinksEnabled(sql);
    await sql`insert into users (id, email, password_hash) values (${user}, ${`purge-ll-${user}@t.com`}, 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, created_at) values (${libraryId}, ${user}, 'Purge listen', '1970-01-01')`;
    await sql`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'Linked')`;
    await sql`insert into artists (id, mbid, name) values (${artist}, ${randomUUID()}, 'Linked artist')`;
    await sql`insert into listen_links (release_group_id, platform, url, source) values (${rg}, 'qobuz', 'https://play.qobuz.com/album/x1', 'mb-release')`;
    await sql`insert into listen_artist_links (artist_id, platform, url, source) values (${artist}, 'qobuz', 'https://play.qobuz.com/artist/1', 'mb-artist')`;
    await sql`insert into listen_album_checks (release_group_id, platforms, found) values (${rg}, '{qobuz}', 1)`;
    await sql`insert into listen_artist_checks (artist_id, platforms, found) values (${artist}, '{qobuz}', 1)`;
    await sql`insert into listen_prefs (user_id, platforms) values (${user}, '{qobuz}')`;
  });

  afterAll(async () => {
    await setOn(was);
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from release_groups where id = ${rg}`;
    await sql`delete from artists where id = ${artist}`;
    await sql`delete from users where id = ${user}`;
    await sql.end({ timeout: 2 });
  });

  it('refuses while it is on; off, deletes exactly its rows, once', async () => {
    await setOn(true);
    const on = await run(['purge-module', 'listen-links', '--json']);
    expect(on.code).toBe(3);
    expect(JSON.parse(on.stdout.trim()).refused).toBe(true);
    expect(await sql`select 1 from listen_prefs where user_id = ${user}`).toHaveLength(1);

    await setOn(false);
    const off = await run(['purge-module', 'listen-links', '--json']);
    expect(off.code).toBe(0);
    const { purged } = JSON.parse(off.stdout.trim().split('\n').pop()!);
    expect(Object.keys(purged.deleted)).toEqual([...MODULE_DATA['listen-links']!.tables]);
    expect(purged.history).toBeNull();
    for (const t of MODULE_DATA['listen-links']!.tables) expect(await sql`select 1 from ${sql(t)}`, t).toHaveLength(0);
    // the core rows stay
    expect(await sql`select title from release_groups where id = ${rg}`).toEqual([{ title: 'Linked' }]);
    expect(await sql`select name from artists where id = ${artist}`).toEqual([{ name: 'Linked artist' }]);
    expect(await sql`select 1 from users where id = ${user}`).toHaveLength(1);

    const again = JSON.parse((await run(['purge-module', 'listen-links', '--json'])).stdout.trim()).purged;
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
  }, 20_000); // three CLI spawns
});

/**
 * On a database of its own, migrated in full and synced as a boot does: the
 * tests switch the module on and empty its whole tables, which on the shared
 * test database would clash with other packages' suites running at the same
 * time.
 */
describe.skipIf(!url)('purge-module autotagger (scratch db)', () => {
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;
  const name = `tagave_purgeattest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const user = randomUUID();
  const lib = randomUUID();
  const album = randomUUID();

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    await runMigrations(u.toString(), { log: () => undefined });
    sql = postgres(u.toString(), { max: 1, onnotice: () => undefined });
    await syncInstalledModules(sql, ledgerEntries());
    expect(await moduleEnabled(sql, 'autotagger')).toBe(false);
    await sql`insert into users (id, email, password_hash) values (${user}, ${`purge-at-${user}@t.com`}, 'x')`;
    await sql`insert into libraries (id, owner_user_id, name) values (${lib}, ${user}, 'Purge autotagger')`;
    await sql`insert into local_albums (id, library_id, cluster_key, state) values (${album}, ${lib}, ${`k-purge-at-${album}`}, 'needs_review')`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('is built from its manifest: its six tables, nothing in libraries.settings', () => {
    expect(MODULE_DATA['autotagger']).toMatchObject({ tables: [...AUTOTAGGER_MODULE.tables], librarySettingsKeys: [], history: null, onWhenEnv: [] });
  });

  it('refuses while the module is on, and deletes nothing', async () => {
    await sql`insert into decider_prices (decider_id, model, per_million_input, currency) values ('jev-refuse', '*', 1.5, 'USD') on conflict do nothing`;
    await setModuleEnabled(sql, 'autotagger', true);
    try {
      await expect(purgeModuleData(sql, 'autotagger', { env: {} })).rejects.toThrow(/still on/);
      expect(await sql`select 1 from decider_prices where decider_id = 'jev-refuse'`).toHaveLength(1);
    } finally {
      await setModuleEnabled(sql, 'autotagger', false);
      await sql`delete from decider_prices where decider_id = 'jev-refuse'`;
    }
  });

  it('off: empties exactly its tables; core batches, match provenance and its ledger row stay', async () => {
    const release = randomUUID();
    const rg = randomUUID();
    await sql`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'Purge autotagger')`;
    await sql`insert into releases (id, release_group_id, mbid, title) values (${release}, ${rg}, ${randomUUID()}, 'Purge autotagger')`;
    try {
      await sql`insert into decider_library_settings (library_id, config) values (${lib}, '{"monthlyCap":10}'::jsonb)`;
      await setTypesafeKey(sql, lib, 'enc:v1:x', 'abcd');
      expect(await typesafeKeyHint(sql, lib)).toBe('abcd');
      await sql`insert into decider_prices (decider_id, model, per_million_input, currency) values ('jev', '*', 1.5, 'USD') on conflict do nothing`;
      const [run] = await sql`insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population) values (${lib}, 'jev', 'h', 'jev-latest', 'needs_review') returning id`;
      const [dec] = await sql`insert into decider_decisions (run_id, local_album_id, outcome, band) values (${run!['id']}, ${album}, 'pick', 'high') returning id`;
      await sql`insert into decider_spot_checks (run_id, decision_id, band) values (${run!['id']}, ${dec!['id']}, 'high')`;
      const [batch] = await sql`insert into decider_batches (library_id, decider_id, decided_kind, run_id) values (${lib}, 'jev', 'model', ${run!['id']}) returning id`;
      await sql`insert into decider_batch_items (batch_id, position, local_album_id, release_id, distance, reason) values (${batch!['id']}, 0, ${album}, ${release}, 0.01, 'model accept')`;
      await sql`insert into album_matches (library_id, local_album_id, release_id, distance, decided_kind, decider_id, batch_id) values (${lib}, ${album}, ${release}, 0.01, 'model', 'jev', ${batch!['id']})`;
      await setModuleSettings(sql, 'autotagger', { kept: true });

      const purged = await purgeModuleData(sql, 'autotagger', { env: {} });
      expect(Object.keys(purged.deleted)).toEqual([...MODULE_DATA['autotagger']!.tables]);
      expect(purged.deleted['decider_library_settings']).toBeGreaterThanOrEqual(1);
      for (const t of MODULE_DATA['autotagger']!.tables) expect(await sql`select 1 from ${sql(t)} where true`, t).toHaveLength(0);
      // the TypeSafe key goes with the module's data
      expect(await typesafeKeyHint(sql, lib)).toBeNull();
      // core: the batch, its items and the match it made, so an undo still works
      expect(await sql`select run_id from decider_batches where id = ${batch!['id']}`).toEqual([{ run_id: run!['id'] }]);
      expect(await sql`select 1 from decider_batch_items where batch_id = ${batch!['id']}`).toHaveLength(1);
      expect(await sql`select decided_kind, decider_id from album_matches where batch_id = ${batch!['id']}`).toEqual([{ decided_kind: 'model', decider_id: 'jev' }]);
      // the owner's switch and the module's own ledger settings stay
      expect(await sql`select enabled, settings from installed_modules where id = 'autotagger'`).toEqual([{ enabled: false, settings: { kept: true } }]);
      expect(Object.values((await purgeModuleData(sql, 'autotagger', { env: {} })).deleted).every((n) => n === 0)).toBe(true);
    } finally {
      await setModuleSettings(sql, 'autotagger', { kept: null });
      await sql`delete from album_matches where local_album_id = ${album}`;
      await sql`delete from decider_batches where library_id = ${lib}`;
      await sql`delete from releases where id = ${release}`;
      await sql`delete from release_groups where id = ${rg}`;
    }
  });
});
