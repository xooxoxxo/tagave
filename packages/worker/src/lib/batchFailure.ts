/**
 * What an accept batch's message says when a run stops: a short label,
 * never the raw error, which can carry SQL or connection details and is
 * read by everyone who cares for the library. The raw error goes to the log.
 */
import { DrizzleQueryError } from 'drizzle-orm';
import { pgErrorCode } from './dbErrors.js';
import { isTransientNetworkError } from './netErrors.js';

// postgres.js's own codes for a connection that went away
const CONNECTION_CODES = new Set(['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT']);

export function failureReason(err: unknown): string {
  const code = pgErrorCode(err);
  if ((code && CONNECTION_CODES.has(code)) || code?.startsWith('08') || isTransientNetworkError(err)) return 'lost connection';
  if (err instanceof DrizzleQueryError || (code && /^[0-9A-Z]{5}$/.test(code))
      || (err as { name?: unknown } | null)?.name === 'PostgresError') return 'database error';
  if (err instanceof RangeError) return 'invalid item';
  return 'unexpected error';
}
