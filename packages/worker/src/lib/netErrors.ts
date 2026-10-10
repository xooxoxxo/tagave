/**
 * Network failures that say nothing about the thing being looked up: the
 * request never got an answer (home internet down, DNS gone, a timeout).
 * A job that hits one must fail and be retried later, never record "looked,
 * found nothing" — on 2026-10-08 an outage stamped 637 releases as bridge
 * attempted, deferring them 30 days as if Discogs had no match.
 */
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** True for errors whose cause is the network, not the provider's answer. */
export function isTransientNetworkError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 4) return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  // fetch()'s own timeout / abort (AbortSignal.timeout) and undici's wrapper
  if (e.name === 'TimeoutError' || e.name === 'ConnectTimeoutError') return true;
  if (typeof e.message === 'string' && /^fetch failed$|socket hang up|network (error|timeout)/i.test(e.message)) return true;
  // undici: TypeError('fetch failed', { cause: AggregateError [ETIMEDOUT] { errors: [...] } })
  if (e.cause && isTransientNetworkError(e.cause, depth + 1)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isTransientNetworkError(x, depth + 1))) return true;
  return false;
}
