/**
 * The playlists module's switch and its data (Module Composition Principle
 * rule 2).
 *
 *   turn off          the Playlists page, the menus' "Add to playlist" and
 *                     Settings › Modules' counts hide; every row stays
 *   delete its data   its two tables are emptied, nothing else (tracks,
 *                     albums and people stay as they are)
 *
 * The switch lives in the settings of the install's first library, as
 * Listen elsewhere's does: settings.modules.playlists.enabled. Absent means
 * on: playlists reach nothing outside tagave, so an install has them from
 * the start; the owner can turn them off. Read per call.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

export const PLAYLISTS_MODULE_ID = 'playlists';

/** Every table the module owns, a table before the one it references. */
export const PLAYLISTS_TABLES = ['playlist_items', 'playlists'] as const;

export async function playlistsEnabled(sql: Sql | Tx): Promise<boolean> {
  const [row] = await sql<Array<{ v: string | null }>>`
    select settings->'modules'->'playlists'->>'enabled' as v from libraries order by created_at, id limit 1`;
  return row?.v !== 'false';
}

export async function setPlaylistsEnabled(sql: Sql | Tx, enabled: boolean): Promise<void> {
  await sql`
    update libraries set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}',
           coalesce(settings->'modules', '{}'::jsonb) || jsonb_build_object('playlists', coalesce(settings->'modules'->'playlists', '{}'::jsonb) || jsonb_build_object('enabled', ${enabled}::boolean)))
     where id = (select id from libraries order by created_at, id limit 1)`;
}

/** Delete the module's data: exactly its rows, in one transaction. Idempotent. */
export async function removePlaylistsData(sql: Sql): Promise<Record<(typeof PLAYLISTS_TABLES)[number], number>> {
  return sql.begin(async (tx) => {
    const out = {} as Record<(typeof PLAYLISTS_TABLES)[number], number>;
    for (const t of PLAYLISTS_TABLES) out[t] = (await tx`delete from ${tx(t)}`).count;
    return out;
  });
}
