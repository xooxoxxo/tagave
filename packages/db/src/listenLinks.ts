/**
 * The listen-links module's switch and its data (Module Composition
 * Principle rule 2).
 *
 *   turn off          listenLinks.resolve skips, the Listen control and
 *                     Settings › Listen elsewhere hide, every row stays
 *   delete its data   the module's five tables are emptied, nothing else
 *                     (core albums, artists and people stay as they are)
 *
 * The switch lives in the settings of the install's first library, as Music
 * Connections' does: settings.modules['listen-links'].enabled. Absent means
 * off: an install shows no links until the owner turns it on. Read per call,
 * so the switch needs no restart.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

export const LISTEN_LINKS_MODULE_ID = 'listen-links';

/** Every table the module owns, children of nothing: each is emptied on its own. */
export const LISTEN_LINKS_TABLES = ['listen_links', 'listen_artist_links', 'listen_album_checks', 'listen_artist_checks', 'listen_prefs'] as const;

export async function listenLinksEnabled(sql: Sql | Tx): Promise<boolean> {
  const [row] = await sql<Array<{ v: string | null }>>`
    select settings->'modules'->'listen-links'->>'enabled' as v from libraries order by created_at, id limit 1`;
  return row?.v === 'true';
}

export async function setListenLinksEnabled(sql: Sql | Tx, enabled: boolean): Promise<void> {
  await sql`
    update libraries set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}',
           coalesce(settings->'modules', '{}'::jsonb) || jsonb_build_object('listen-links', coalesce(settings->'modules'->'listen-links', '{}'::jsonb) || jsonb_build_object('enabled', ${enabled}::boolean)))
     where id = (select id from libraries order by created_at, id limit 1)`;
}

/** Delete the module's data: exactly its rows, in one transaction. Idempotent. */
export async function removeListenLinksData(sql: Sql): Promise<Record<(typeof LISTEN_LINKS_TABLES)[number], number>> {
  return sql.begin(async (tx) => {
    const out = {} as Record<(typeof LISTEN_LINKS_TABLES)[number], number>;
    for (const t of LISTEN_LINKS_TABLES) out[t] = (await tx`delete from ${tx(t)}`).count;
    return out;
  });
}

/** A person's platforms, in their order ([] until they choose). */
export async function listenPrefsOf(sql: Sql | Tx, userId: string): Promise<string[]> {
  const [row] = await sql<Array<{ platforms: string[] }>>`select platforms from listen_prefs where user_id = ${userId}`;
  return row?.platforms ?? [];
}

export async function setListenPrefs(sql: Sql | Tx, userId: string, platforms: readonly string[]): Promise<void> {
  await sql`insert into listen_prefs (user_id, platforms, updated_at) values (${userId}, ${platforms as string[]}::text[], now())
            on conflict (user_id) do update set platforms = excluded.platforms, updated_at = now()`;
}

/** Every platform someone on this install picked: the resolver looks for nothing else. */
export async function pickedListenPlatforms(sql: Sql | Tx): Promise<string[]> {
  const rows = await sql<Array<{ p: string }>>`select distinct unnest(platforms) as p from listen_prefs`;
  return rows.map((r) => r.p).sort();
}
