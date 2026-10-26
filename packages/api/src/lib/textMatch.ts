/**
 * Text search that ignores case and diacritics (QA 2026-10-26 Q-08: "bjork"
 * did not find "Björk", and "Björk" did not find a "bjork" tag). Both the
 * column and the query go through unaccent (the extension is installed since
 * migration 0000). The plain ilike stays first so the trigram indexes still
 * serve it; the unaccent branch catches the rest.
 */
import { sql, type SQL } from 'drizzle-orm';

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** `%query%` with LIKE wildcards in the query taken literally. */
export function containsPattern(query: string): string {
  return '%' + escapeLike(query) + '%';
}

/** column ILIKE pattern, ignoring diacritics on both sides. */
export function textMatches(column: SQL, pattern: string): SQL {
  return sql`(${column} ilike ${pattern} or unaccent(${column}) ilike unaccent(${pattern}::text))`;
}

/** A query-side value folded the way `foldedColumn` folds a column. */
export function foldedValue(value: string): SQL {
  return sql`lower(unaccent(${value}::text))`;
}

export function foldedColumn(column: SQL): SQL {
  return sql`lower(unaccent(coalesce(${column}, '')))`;
}
