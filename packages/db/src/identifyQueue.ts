/**
 * The identify queue's commands for other modules (Facets and Connectors
 * design §4: cross-module writes go through the owning module's commands).
 * A module suggests a release for an album here; it never writes
 * match_candidates or album_matches itself. A suggestion is a candidate like
 * any other, tagged with its source (mc:<link>), and only a person accepts it:
 * the auto-accept rules and the chip-rule sweep leave every module's
 * suggestion alone (autoAccept.ts, worker › queueAutoAccept.ts).
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

export interface Suggestion {
  localAlbumId: string;
  releaseId: string;
  /** 0 (identical) … 1 */
  distance: number;
  /** the module's evidence; `key` names the suggestion within its source */
  breakdown: Record<string, unknown>;
  /** e.g. mc:<link id> */
  source: string;
  key: string;
}

/** identify.suggest: add the candidate once per (album, source, key). Returns whether it was added. */
export async function identifySuggest(sql: Sql, s: Suggestion): Promise<boolean> {
  const breakdown = { ...s.breakdown, mc: { ...(s.breakdown['mc'] as Record<string, unknown> | undefined), key: s.key } };
  const rows = await sql`
    insert into match_candidates (local_album_id, release_id, distance, breakdown, source)
    select ${s.localAlbumId}, ${s.releaseId}, ${Math.min(1, Math.max(0, s.distance)).toFixed(4)}::numeric, ${JSON.stringify(breakdown)}::text::jsonb, ${s.source}
     where not exists (select 1 from match_candidates where local_album_id = ${s.localAlbumId} and source = ${s.source}
                        and breakdown->'mc'->>'key' = ${s.key})
    returning id`;
  return rows.length > 0;
}

/**
 * identify.withdraw: a source takes back its undecided suggestions (all of
 * them, or one key's). A candidate a person decided stays: one they accepted
 * (a person's album_matches row for that album and release) or excluded.
 */
export async function identifyWithdraw(sql: Sql, source: { exact: string } | { prefix: string }, key?: string): Promise<number> {
  const match = 'exact' in source ? sql`c.source = ${source.exact}` : sql`c.source like ${`${source.prefix}%`}`;
  const rows = await sql`
    delete from match_candidates c
     where ${match}
       and (${key ?? null}::text is null or c.breakdown->'mc'->>'key' = ${key ?? null}::text)
       and c.excluded is not true
       and not exists (select 1 from album_matches m
                        where m.local_album_id = c.local_album_id and m.release_id = c.release_id and m.decided_by = 'user')
    returning c.id`;
  return rows.length;
}
