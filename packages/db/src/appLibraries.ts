/**
 * Libraries by app (libraries.app, 0068; one app per library): which app a
 * library is for, the libraries of an app, and the first library of an app
 * made on demand (the books app's, when it is turned on).
 *
 *   libraryApp(sql, id)                    'music' | 'books' | …; 'music' for a database from before 0068
 *   appLibraryIds(sql, app)                the app's libraries, oldest first
 *   ensureAppLibrary(sql, { app, … })      the app's first library, made when there is none
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;
type Q = Sql | Tx;

/** Every library before 0068 is music's. */
export const DEFAULT_LIBRARY_APP = 'music';

/** Postgres: undefined column (a database from before 0068, under TAGAVE_ALLOW_SCHEMA_SKEW). */
const UNDEFINED_COLUMN = '42703';

/** The app a library is for; music for a library this database does not have, or one from before 0068. */
export async function libraryApp(sql: Q, libraryId: string): Promise<string> {
  try {
    const [row] = await sql<Array<{ app: string }>>`select app from libraries where id = ${libraryId}`;
    return row?.app ?? DEFAULT_LIBRARY_APP;
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_COLUMN) return DEFAULT_LIBRARY_APP;
    throw err;
  }
}

export async function appLibraryIds(sql: Q, app: string): Promise<string[]> {
  const rows = await sql<Array<{ id: string }>>`select id::text as id from libraries where app = ${app} order by created_at, id`;
  return rows.map((r) => r.id);
}

/**
 * The app's first library, made now (owned by `ownerUserId`, named `name`)
 * when the app has none. Two calls at once make one: the insert takes a
 * transaction-scoped advisory lock on the app id first.
 */
export async function ensureAppLibrary(sql: Sql, opts: { app: string; name: string; ownerUserId: string }): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`libraries.app:${opts.app}`}))`;
    const [have] = await tx<Array<{ id: string }>>`select id::text as id from libraries where app = ${opts.app} order by created_at, id limit 1`;
    if (have) return have.id;
    const [made] = await tx<Array<{ id: string }>>`
      insert into libraries (owner_user_id, name, settings, app) values (${opts.ownerUserId}, ${opts.name}, '{}'::jsonb, ${opts.app})
      returning id::text as id`;
    return made!.id;
  }) as Promise<string>;
}
