/**
 * Music Connections feeds (spec §3): what a linked app reads with its access
 * token.
 *
 *   GET /mc/v1/<capability>?since=<cursor>&limit=<1..500>   ratings, collection, listens, identity
 *   GET /mc/v1/schema/<capability>.json                      each one's JSON Schema (public)
 *
 * Outside /api, so the route guard (permissions/guard.ts) never sees these:
 * the bearer gate below is their only gate. It is one onRequest hook for
 * every route of this plugin, and it refuses by default:
 *
 *   config.mcPublic: true    no token needed (the schemas)
 *   config.mcScope: '<s>'    a live token granted scope <s>
 *   neither                  refused (401 without a token, 403 with one)
 *
 * Missing, unknown, expired or revoked token, a disabled client or person:
 * 401. A live token without the route's scope: 403. More than 60 calls a
 * minute on one token: 429 with Retry-After.
 *
 * Tokens that are not valid cost no unbounded database work, and lock no one
 * out:
 *   - a malformed one (empty, over the package's length limit, shorter than
 *     any issued token, or outside the bearer charset) is 401 with no lookup;
 *   - one that missed is remembered (by hash, 10,000 at most, 5 minutes) and
 *     answered 401 with no lookup again;
 *   - lookups that miss are limited per client address (request.ip, so
 *     TRUST_PROXY decides which hop that is; unset behind a proxy, every
 *     caller shares one address): 300 a minute, counted with a slot taken
 *     before the lookup and given back when it succeeds, so requests at once
 *     cannot all pass. Past it the address's lookups run one at a time and
 *     a miss is 429 with Retry-After, so the database sees at most one such
 *     lookup in flight per address. At most 100 wait their turn: past that
 *     a token is 429 with Retry-After at once, and a waiting lookup whose
 *     client has gone is dropped;
 *   - a token issued by this process, or one that succeeded within the hour,
 *     skips that queue: it is looked up and served at once. Any other valid
 *     token is served in its turn, or is 429 while the queue is full. Nothing
 *     is served from memory, so a revoke or expiry counts on the next request.
 * Every answer is no-store.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildFeedPage, capabilityJsonSchema, feedLimit, isCapability, readScope } from 'music-connections';
import { mcEnabled } from '@tagave/db';
import { getAuthHandle } from '../middleware/auth.js';
import { RateLimitError, RateLimiter, TtlCache } from '../lib/rateLimit.js';
import { TAGAVE_PROVIDES, bearerToken, hashToken, knownGoodTokens as knownGood, lookupAccessToken, type AccessGrant } from '../lib/mcOAuth.js';
import { isLookupLength } from 'music-connections';
import { feedLibrary, parseSince, readFeed } from '../lib/mcFeeds.js';
import { feedPath } from './connect.js';

/** Per access token (feeds) or per address (the public schemas). */
const feedCalls = new RateLimiter(60, 60_000);
const schemaCalls = new RateLimiter(60, 60_000);
/** Lookups that miss, per client address, before that address's lookups go one at a time. */
export const FAILED_LOOKUPS_PER_MINUTE = 300;
const failedLookups = new RateLimiter(FAILED_LOOKUPS_PER_MINUTE, 60_000);
const FAILED_LOOKUPS_DETAIL = 'Too many requests with an access token that is not valid.';
/** Token hashes that missed: answered 401 without a lookup for 5 minutes. */
const missed = new TtlCache<true>(5 * 60_000, 10_000);
/** Past the limit, an address's lookups run one at a time, in order. */
interface Lane {
  tail: Promise<void>;
  /** Lookups queued and not yet started. */
  waiting: number;
}
const lanes = new Map<string, Lane>();
/** Lookups that may wait in one address's lane; past it, 429 at once. */
export const MAX_LANE_WAITING = 100;
/** What a lane gives back for a lookup it never ran: the lane was full, or the client had gone. */
export const LANE_FULL = Symbol('lane full');
export const LANE_DROPPED = Symbol('lane dropped');

/**
 * Runs `fn` after every lookup queued before it on `key`. Refuses (LANE_FULL)
 * at once when MAX_LANE_WAITING are already waiting; skips `fn`
 * (LANE_DROPPED) when `gone()` is true at its turn.
 */
export function inLane<T>(key: string, fn: () => Promise<T>, gone: () => boolean = () => false): Promise<T | typeof LANE_FULL | typeof LANE_DROPPED> {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { tail: Promise.resolve(), waiting: 0 };
    lanes.set(key, lane);
  }
  if (lane.waiting >= MAX_LANE_WAITING) return Promise.resolve(LANE_FULL);
  const l = lane;
  l.waiting += 1;
  const turn = (): Promise<T | typeof LANE_DROPPED> => {
    l.waiting -= 1;
    return gone() ? Promise.resolve(LANE_DROPPED) : fn();
  };
  const run = l.tail.then(turn, turn);
  const tail = run.then(() => undefined, () => undefined);
  l.tail = tail;
  void tail.then(() => {
    if (l.tail === tail && lanes.get(key) === l) lanes.delete(key);
  });
  return run;
}

/** No issued token is shorter (tagave's are 47 characters); the bearer charset (RFC 6750 b64token). */
const MIN_TOKEN_LENGTH = 32;
const B64TOKEN_RE = /^[A-Za-z0-9._~+/-]+=*$/;

/** Cheap shape check before any lookup. */
export function lookupWorthy(token: string): boolean {
  return isLookupLength(token) && token.length >= MIN_TOKEN_LENGTH && B64TOKEN_RE.test(token);
}

export function resetMcFeedLimits(): void {
  feedCalls.reset();
  schemaCalls.reset();
  failedLookups.reset();
  missed.reset();
  knownGood.reset();
  lanes.clear();
}

/**
 * The grant behind a bearer token, or null (401): always from a lookup in
 * this request, never from memory. Memory decides only whether and when the
 * lookup runs: a malformed token or a recent miss gets none; within the
 * address's limit (a slot taken before the lookup, given back unless it
 * missed) it runs at once; past it, a token issued here or that succeeded
 * lately still runs at once and any other waits its turn in the address's
 * one-at-a-time lane (429 with Retry-After when the lane is full, or when the
 * lookup there misses).
 */
async function grantFor(request: FastifyRequest, token: string): Promise<AccessGrant | null> {
  if (!lookupWorthy(token)) return null;
  const hash = hashToken(token);
  const now = Date.now();
  if (missed.has(hash, now)) return null;
  const from = `ip:${request.ip}`;
  const lookup = async () => {
    const grant = await lookupAccessToken(getAuthHandle().sql, token);
    if (grant) knownGood.set(hash, true);
    else {
      knownGood.delete(hash);
      missed.set(hash, true);
    }
    return grant;
  };
  // take the slot before the lookup: requests at once each count
  if (failedLookups.allow(from, now)) {
    let miss = false;
    try {
      const grant = await lookup();
      miss = grant === null;
      return grant;
    } finally {
      // only a miss keeps its slot; a success or a database error gives it back
      if (!miss) failedLookups.release(from, now);
    }
  }
  failedLookups.release(from, now);
  // a token that worked lately and now fails (expired, revoked) gets the
  // plain 401, so its app refreshes instead of backing off
  if (knownGood.has(hash, now)) return lookup();
  // a client that hung up while waiting costs no lookup
  const grant = await inLane(from, lookup, () => request.raw.socket?.destroyed === true);
  if (grant === LANE_FULL || grant === LANE_DROPPED || !grant) throw new RateLimitError(failedLookups.retryAfterS(from), FAILED_LOOKUPS_DETAIL);
  return grant;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The access grant behind the bearer token (/mc/v1 routes only). */
    mcGrant?: AccessGrant | undefined;
  }
  interface FastifyContextConfig {
    /** /mc/v1: the scope a token must carry (see routes/mcFeeds.ts). */
    mcScope?: string;
    /** /mc/v1: served without a token. */
    mcPublic?: boolean;
  }
}

const problem = (status: number, title: string, detail?: string) => ({ type: 'about:blank', status, title, ...(detail ? { detail } : {}) });

function unauthorized(reply: FastifyReply, invalid: boolean): FastifyReply {
  reply.header('www-authenticate', invalid ? 'Bearer realm="music-connections", error="invalid_token"' : 'Bearer realm="music-connections"');
  return reply.status(401).send(problem(401, 'Unauthorized', invalid ? 'The access token is not valid.' : 'An access token is required.'));
}

function forbidden(reply: FastifyReply, scope: string | undefined): FastifyReply {
  reply.header('www-authenticate', `Bearer realm="music-connections", error="insufficient_scope"${scope ? `, scope="${scope}"` : ''}`);
  return reply.status(403).send(problem(403, 'Forbidden', scope ? `This link was not granted ${scope}.` : 'Not available to a linked app.'));
}

/** The bearer gate: no-store, off (404), then public, or token → rate limit → scope. */
async function bearerGate(request: FastifyRequest, reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
  // Music Connections off (Settings › Modules): nothing is served; the data stays
  if (!(await mcEnabled(getAuthHandle().sql))) return reply.status(404).send(problem(404, 'Not Found', 'Music Connections is turned off here.'));
  const config = request.routeOptions.config;
  if (config?.mcPublic === true) return;
  const token = bearerToken(request.headers.authorization);
  if (!token) return unauthorized(reply, false);
  const grant = await grantFor(request, token);
  if (!grant) return unauthorized(reply, true);
  feedCalls.check(`token:${grant.tokenId}`, Date.now(), 'Too many requests on this access token.');
  const scope = config?.mcScope;
  // a route that declares no scope is open to no token
  if (typeof scope !== 'string' || !grant.scopes.includes(scope)) return forbidden(reply, scope);
  request.mcGrant = grant;
}

export interface McFeedRouteOptions {
  /** Tests: register more routes inside the plugin, behind the same gate. */
  extraRoutes?: (fastify: FastifyInstance) => void | Promise<void>;
}

export async function createMcFeedRoutes(fastify: FastifyInstance, opts: McFeedRouteOptions = {}) {
  fastify.addHook('onRequest', bearerGate);

  fastify.get<{ Params: { file: string } }>('/mc/v1/schema/:file', { config: { mcPublic: true } }, async (request, reply) => {
    schemaCalls.check(`ip:${request.ip}`);
    const cap = request.params.file.replace(/\.json$/, '');
    if (!request.params.file.endsWith('.json') || !isCapability(cap) || !TAGAVE_PROVIDES.includes(cap)) {
      return reply.status(404).send(problem(404, 'Not Found'));
    }
    return capabilityJsonSchema(cap);
  });

  for (const cap of TAGAVE_PROVIDES) {
    fastify.get<{ Querystring: Record<string, unknown> }>(feedPath(cap), { config: { mcScope: readScope(cap) } }, async (request, reply) => {
      const grant = request.mcGrant;
      if (!grant) return unauthorized(reply, true); // the gate always sets it; never serve without
      const since = parseSince(request.query['since']);
      if (!since.ok) {
        return since.status === 410
          ? reply.status(410).send(problem(410, 'Gone', 'The cursor is older than the change log keeps; take a fresh snapshot.'))
          : reply.status(400).send(problem(400, 'Bad Request', 'Invalid cursor.'));
      }
      const limit = feedLimit(request.query['limit']);
      const prev = typeof request.query['since'] === 'string' ? request.query['since'] : '';

      const sql = getAuthHandle().sql;
      const libraryId = await feedLibrary(sql);
      if (!libraryId) return { items: [], next: prev, more: false };
      const rows = await readFeed(sql, cap, { userId: grant.userId, libraryId }, since.after, limit, (msg) => request.log.warn(msg));
      const page = buildFeedPage(rows, limit, prev);
      // buildFeedPage maps the first `limit` rows one to one: drop the skipped
      // ones (a key's earlier rows, invalid data) afterwards, so the cursor
      // still moves past them.
      page.items = page.items.filter((_, i) => !rows[i]?.skip);
      return page;
    });
  }

  if (opts.extraRoutes) await opts.extraRoutes(fastify);
}
