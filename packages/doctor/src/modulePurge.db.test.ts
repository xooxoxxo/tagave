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
import { MODULE_DATA } from './modulePurge.js';

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
