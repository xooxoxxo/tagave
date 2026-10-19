/**
 * "Delete its data" for a module, in tagave's own database: exactly the
 * module's rows, nothing of the core.
 *
 *   tagave-doctor purge-module <id> [--delete-history] [--json]
 *
 * The updater runs it in the app container (docker compose exec app) after
 * it has turned the module off and the app answers healthy again without it,
 * and before it deletes the module's volumes. Settings › Modules and
 * install-tagave.sh disable-module both come through there.
 *
 * One transaction: every table of the module is locked first, so nothing
 * writes a new row half way, then emptied children first. Running it again
 * deletes nothing (it is idempotent). It refuses while the module is still
 * configured in this process's environment.
 *
 * The player: its rows are the tables of migrations 0041, 0044 and 0045
 * (song ids on the server, play events, plays, album listens made from
 * plays, scrobbles, play counts, poll state, ratings pushed, accounts on the
 * server, retired accounts, scan requests) and scrobble_accounts. Last.fm
 * and ListenBrainz connections are per person, but only the player feeds
 * them, so they belong to the player for now and go with it (they hold the
 * session keys). Kept: the listens it wrote into the core `listens` table
 * (source 'player'), which are the person's history; `deleteHistory` deletes
 * those too, and only those (listens logged by hand stay either way). The
 * owner's own settings in libraries.settings stay as well (a player server
 * of their own, the Last.fm API key); only the player's scan status goes.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql;

export interface ModuleData {
  /** Its tables, in the order they are emptied (a table before the ones it references). */
  tables: readonly string[];
  /** Keys of libraries.settings that are the module's state, not the owner's settings. */
  librarySettingsKeys: readonly string[];
  /** Rows it wrote into a core table, kept unless the owner asks: the person's history. */
  history: { table: string; where: string } | null;
  /** Set in the app's environment while the module is on: the purge refuses then. */
  onWhenEnv: readonly string[];
}

export const MODULE_DATA: Readonly<Record<string, ModuleData>> = {
  player: {
    tables: [
      'player_scrobbles',
      'player_plays',
      'player_listens',
      'player_events',
      'player_track_map',
      'player_song_counts',
      'player_poll_state',
      'player_rating_sync',
      'player_users',
      'player_retired_accounts',
      'scrobble_accounts',
      'player_scan_requests',
    ],
    librarySettingsKeys: ['playerLastScan'],
    history: { table: 'listens', where: "source = 'player'" },
    onWhenEnv: ['TAGAVE_PLAYER_URL'],
  },
};

export class PurgeRefused extends Error {}

export interface PurgeResult {
  module: string;
  /** Rows deleted per table (0 on a second run). */
  deleted: Record<string, number>;
  /** The history rows it wrote into a core table: deleted (deleteHistory) or kept, and how many. */
  history: { table: string; action: 'deleted' | 'kept'; count: number } | null;
  /** Libraries whose settings lost a key of the module. */
  librariesCleared: number;
}

export async function purgeModuleData(
  sql: Sql,
  moduleId: string,
  opts: { deleteHistory?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<PurgeResult> {
  const data = MODULE_DATA[moduleId];
  if (!data) throw new PurgeRefused(`tagave keeps no data of its own for a module called ${moduleId}`);
  const env = opts.env ?? process.env;
  const on = data.onWhenEnv.filter((k) => (env[k] ?? '').trim() !== '');
  if (on.length) throw new PurgeRefused(`${moduleId} is still on here (${on.join(', ')} is set); turn it off first`);
  const deleteHistory = opts.deleteHistory === true;

  return sql.begin(async (tx) => {
    const exists = await tx<{ name: string }[]>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relkind = 'r' and c.relname = any(${[...data.tables]}::text[])`;
    const present = data.tables.filter((t) => exists.some((e) => e.name === t));
    if (present.length) await tx.unsafe(`lock table ${present.map((t) => `"${t}"`).join(', ')} in share row exclusive mode`);

    let history: PurgeResult['history'] = null;
    if (data.history) {
      const { table, where } = data.history;
      if (deleteHistory) {
        const gone = await tx.unsafe(`delete from "${table}" where ${where}`);
        history = { table, action: 'deleted', count: gone.count };
      } else {
        const [row] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from "${table}" where ${where}`);
        history = { table, action: 'kept', count: row?.n ?? 0 };
      }
    }

    const deleted: Record<string, number> = {};
    for (const t of present) deleted[t] = (await tx.unsafe(`delete from "${t}"`)).count;

    let librariesCleared = 0;
    if (data.librarySettingsKeys.length) {
      const keys = [...data.librarySettingsKeys];
      const res = await tx`
        update libraries set settings = settings - ${keys}::text[]
        where settings ?| ${keys}::text[]`;
      librariesCleared = res.count;
    }
    return { module: moduleId, deleted, history, librariesCleared };
  });
}

/** One line for a run log: what went and what stayed. */
export function describePurge(r: PurgeResult): string {
  const rows = Object.entries(r.deleted).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`);
  const parts = [rows.length ? `deleted ${rows.join(', ')}` : 'no rows of its own were left'];
  if (r.librariesCleared) parts.push(`its scan status cleared in ${r.librariesCleared} librar${r.librariesCleared === 1 ? 'y' : 'ies'}`);
  if (r.history) parts.push(`${r.history.action} the ${r.history.count} ${r.history.table} it recorded`);
  return parts.join('; ');
}
