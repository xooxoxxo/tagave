/**
 * Whether an error means the database cannot be reached (as opposed to a
 * query that failed, or some other service that is down). postgres.js puts
 * a Node network code (ECONNREFUSED) or its own (CONNECT_TIMEOUT) on
 * connection errors and the server's SQLSTATE on the rest; drizzle wraps
 * both in `cause`.
 *
 * A Node network code alone proves nothing: fetch() to MusicBrainz fails
 * with the same ENOTFOUND. It counts only on an error that came through the
 * database driver (postgres.js marks the errors it rejects a query with by
 * `query` and `parameters`, drizzle by `query` and `params`), or one whose
 * address is the database's own (DATABASE_URL).
 */

/** Codes only postgres.js uses: always the database. */
const DRIVER_CODES: Record<string, string> = {
  CONNECT_TIMEOUT: 'it does not answer',
  CONNECTION_CLOSED: 'the connection was closed',
  CONNECTION_ENDED: 'the connection was closed',
  CONNECTION_DESTROYED: 'the connection was closed',
};

/** Node network codes: the database only when the error is the database's. */
const NETWORK_CODES: Record<string, string> = {
  ECONNREFUSED: 'it refuses connections',
  ECONNRESET: 'the connection was cut',
  ENOTFOUND: 'its host name does not resolve',
  EAI_AGAIN: 'its host name does not resolve',
  ETIMEDOUT: 'it does not answer',
  EHOSTUNREACH: 'its host cannot be reached',
  ENETUNREACH: 'its network cannot be reached',
  EPIPE: 'the connection was cut',
};

/** SQLSTATEs that mean the server is there but cannot serve. */
const SERVER_CODES: Record<string, string> = {
  '57P01': 'it is shutting down',
  '57P02': 'it is shutting down',
  '57P03': 'it is starting up or recovering',
  '53100': 'its disk is full',
  '53300': 'it has no free connections',
};

interface DbTarget {
  host: string;
  port: number;
}

function targetOf(databaseUrl: string | undefined): DbTarget | null {
  if (!databaseUrl) return null;
  try {
    const u = new URL(databaseUrl);
    return { host: decodeURIComponent(u.hostname).replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : 5432 };
  } catch {
    return null;
  }
}

const isIpLiteral = (host: string) => /^[\d.]+$/.test(host) || host.includes(':');

/** A query error from postgres.js or drizzle. */
function fromDriver(e: object): boolean {
  return 'query' in e && ('parameters' in e || 'params' in e);
}

/** The network error names the database's host (a container name resolves to an address, so the port decides then). */
function atDatabase(e: object, target: DbTarget | null): boolean {
  if (!target) return false;
  const { address, port, hostname } = e as { address?: unknown; port?: unknown; hostname?: unknown };
  if (typeof hostname === 'string' && hostname === target.host) return true;
  if (port !== target.port) return false;
  if (address === target.host) return true;
  return typeof address === 'string' && !isIpLiteral(target.host);
}

/** Why the database cannot be reached, or null when `err` is something else. */
export function databaseUnreachable(err: unknown, databaseUrl: string | undefined = process.env['DATABASE_URL']): string | null {
  const target = targetOf(databaseUrl);
  const seen = new Set<unknown>();
  const queue: Array<{ e: unknown; viaDriver: boolean }> = [{ e: err, viaDriver: false }];
  while (queue.length > 0) {
    const { e, viaDriver: parentViaDriver } = queue.shift()!;
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    const viaDriver = parentViaDriver || fromDriver(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (DRIVER_CODES[code]) return `${DRIVER_CODES[code]} (${code})`;
      if (SERVER_CODES[code]) return `${SERVER_CODES[code]} (${code})`;
      if (/^08[0-9A-Z]{3}$/.test(code)) return `the connection failed (${code})`;
      if (NETWORK_CODES[code] && (viaDriver || atDatabase(e, target))) return `${NETWORK_CODES[code]} (${code})`;
    }
    queue.push({ e: (e as { cause?: unknown }).cause, viaDriver });
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors.map((x) => ({ e: x, viaDriver })));
  }
  return null;
}
