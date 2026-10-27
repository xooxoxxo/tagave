/**
 * The playlists module's switch and its data (Module Composition Principle
 * rule 2).
 *
 *   turn off          the Playlists page, the menus' "Add to playlist" and
 *                     Settings › Modules' counts hide; every row stays
 *   delete its data   its two tables are emptied, nothing else (tracks,
 *                     albums and people stay as they are)
 *
 * The switch is the module ledger's row 'playlists' (installed_modules,
 * 0065), on from the start: playlists reach nothing outside tagave, so an
 * install has them until the owner turns them off. Read per call.
 */
import type postgres from 'postgres';
import { moduleEnabled, setModuleEnabled } from './modules.js';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

export const PLAYLISTS_MODULE_ID = 'playlists';

/** Every table the module owns, a table before the one it references. */
export const PLAYLISTS_TABLES = ['playlist_items', 'playlists'] as const;

export async function playlistsEnabled(sql: Sql | Tx): Promise<boolean> {
  return moduleEnabled(sql, PLAYLISTS_MODULE_ID);
}

export async function setPlaylistsEnabled(sql: Sql | Tx, enabled: boolean): Promise<void> {
  await setModuleEnabled(sql, PLAYLISTS_MODULE_ID, enabled);
}

/** Delete the module's data: exactly its rows, in one transaction. Idempotent. */
export async function removePlaylistsData(sql: Sql): Promise<Record<(typeof PLAYLISTS_TABLES)[number], number>> {
  return sql.begin(async (tx) => {
    const out = {} as Record<(typeof PLAYLISTS_TABLES)[number], number>;
    for (const t of PLAYLISTS_TABLES) out[t] = (await tx`delete from ${tx(t)}`).count;
    return out;
  });
}
