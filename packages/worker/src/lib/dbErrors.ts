import { DrizzleQueryError } from 'drizzle-orm';

/**
 * drizzle-orm (>=0.44) wraps every driver error in a DrizzleQueryError whose
 * message is the failed SQL plus its params; the Postgres error is `.cause`.
 */
function unwrap(err: unknown): unknown {
  return err instanceof DrizzleQueryError && err.cause ? err.cause : err;
}

/** SQLSTATE of a Postgres error, wrapped by drizzle or not. */
export function pgErrorCode(err: unknown): string | undefined {
  return (unwrap(err) as { code?: string } | null)?.code;
}

/** Message fit to store or show: the driver's own, not the SQL text drizzle prepends. */
export function errorMessage(err: unknown): string {
  const e = unwrap(err);
  return e instanceof Error ? e.message : String(e);
}
