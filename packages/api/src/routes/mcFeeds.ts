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
 * minute on one token: 429 with Retry-After. Every answer is no-store.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildFeedPage, capabilityJsonSchema, feedLimit, isCapability, readScope } from 'music-connections';
import { getAuthHandle } from '../middleware/auth.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { TAGAVE_PROVIDES, bearerToken, lookupAccessToken, type AccessGrant } from '../lib/mcOAuth.js';
import { feedLibrary, parseSince, readFeed } from '../lib/mcFeeds.js';
import { feedPath } from './connect.js';

/** Per access token (feeds) or per address (the public schemas). */
const feedCalls = new RateLimiter(60, 60_000);
const schemaCalls = new RateLimiter(60, 60_000);

export function resetMcFeedLimits(): void {
  feedCalls.reset();
  schemaCalls.reset();
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

/** The bearer gate: no-store, then public, or token → rate limit → scope. */
async function bearerGate(request: FastifyRequest, reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
  const config = request.routeOptions.config;
  if (config?.mcPublic === true) return;
  const token = bearerToken(request.headers.authorization);
  if (!token) return unauthorized(reply, false);
  const grant = await lookupAccessToken(getAuthHandle().sql, token);
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
