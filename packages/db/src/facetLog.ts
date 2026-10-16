/**
 * The facet change log (0048, facet_changes): which facet of which entity
 * changed, in order (Facets and Connectors design §6). The Music Connections
 * feeds read it through api › lib/mcFeeds.ts; an in-process consumer reads it
 * here and keeps where it stopped in facet_cursors.
 *
 * Rows only count once every transaction that could still add an earlier one
 * has finished: the log is ordered by changed_at, and a transaction that
 * commits late would otherwise slip a row in behind a cursor already handed
 * out. So a read stops short of the start of the oldest transaction still
 * writing (all of tagave runs as one database role, which sees them all).
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** The facets the built-in providers log (facet_changes.facet). */
export const LOGGED_FACETS = ['album.rating@1', 'album.collection@1', 'album.listens@1', 'album.identity@1'] as const;
export type LoggedFacet = (typeof LOGGED_FACETS)[number];

/** Whose rows a read sees: one library, and one person or the library's (null). */
export interface FacetLogScope {
  libraryId: string;
  userId: string | null;
}

/** Position in the log: changed_at (microseconds, UTC ISO) and id. */
export interface FacetLogPosition {
  t: string;
  id: string;
}

export interface FacetChange {
  id: string;
  key: string;
  op: 'upsert' | 'delete';
  changed_at: string;
}

/** How far behind the clock the read horizon is (ms); a long transaction holds every reader back. */
export async function facetLogHorizon(sql: Sql): Promise<{ t: string; lagMs: number }> {
  const [h] = await sql<Array<{ t: string; lag_ms: number }>>`
    select to_char(h at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t,
           (extract(epoch from (clock_timestamp() - h)) * 1000)::float8 as lag_ms
      from (select least(clock_timestamp(),
                     (select min(xact_start) from pg_stat_activity
                       where datname = current_database() and backend_xid is not null and pid <> pg_backend_pid())) as h) s`;
  return { t: h!.t, lagMs: h!.lag_ms };
}

/**
 * The next `limit` changes of one facet after `after`, in order, up to the
 * read horizon. Pass limit + 1 to learn whether there is more.
 */
export async function readFacetChanges(
  sql: Sql,
  facet: LoggedFacet,
  scope: FacetLogScope,
  after: FacetLogPosition | null,
  limit: number,
  horizon?: string,
): Promise<FacetChange[]> {
  const until = horizon ?? (await facetLogHorizon(sql)).t;
  // ::text first: postgres.js would serialise a timestamptz parameter through
  // a JS Date and drop the microseconds a cursor carries.
  const t = after?.t ?? '1970-01-01T00:00:00Z';
  const id = after?.id ?? '0';
  return sql<FacetChange[]>`
    select id::text as id, key, op, to_char(changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as changed_at
      from facet_changes
     where facet = ${facet}
       and ${scope.userId === null ? sql`user_id is null` : sql`user_id = ${scope.userId}`}
       and library_id = ${scope.libraryId}
       and (changed_at, id) > (${t}::text::timestamptz, ${id}::text::bigint)
       and changed_at < ${until}::text::timestamptz
     order by changed_at, id
     limit ${limit}`;
}

const scopeKey = (s: FacetLogScope): string => `${s.libraryId}:${s.userId ?? ''}`;

/** Where `consumer` stopped reading `facet` for this scope, or null (from the start). */
export async function facetCursor(sql: Sql, consumer: string, facet: LoggedFacet, scope: FacetLogScope): Promise<FacetLogPosition | null> {
  const [row] = await sql<Array<{ cursor: string }>>`
    select cursor from facet_cursors where consumer = ${consumer} and facet = ${facet} and scope_key = ${scopeKey(scope)}`;
  if (!row) return null;
  const [t, id] = row.cursor.split('|');
  return t && id ? { t, id } : null;
}

export async function saveFacetCursor(sql: Sql, consumer: string, facet: LoggedFacet, scope: FacetLogScope, at: FacetLogPosition): Promise<void> {
  await sql`
    insert into facet_cursors (consumer, facet, scope_key, cursor, updated_at)
    values (${consumer}, ${facet}, ${scopeKey(scope)}, ${`${at.t}|${at.id}`}, now())
    on conflict (consumer, facet, scope_key) do update set cursor = excluded.cursor, updated_at = now()`;
}

/**
 * An in-process consumer's next batch: the changes after its saved cursor;
 * `commit()` saves the cursor past them once the consumer has used them.
 */
export async function nextFacetChanges(
  sql: Sql,
  consumer: string,
  facet: LoggedFacet,
  scope: FacetLogScope,
  limit = 500,
): Promise<{ changes: FacetChange[]; commit(): Promise<void> }> {
  const after = await facetCursor(sql, consumer, facet, scope);
  const changes = await readFacetChanges(sql, facet, scope, after, limit);
  const last = changes.at(-1);
  return {
    changes,
    commit: async () => {
      if (last) await saveFacetCursor(sql, consumer, facet, scope, { t: last.changed_at, id: last.id });
    },
  };
}
