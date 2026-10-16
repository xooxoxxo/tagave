/**
 * The route guard: every /api route declares what it needs (routeTable.ts,
 * or `config: { permission }` on the route, which wins), and this checks it
 * once per request, before the body is read. Deny by default: a route with
 * no declaration refuses everyone, and routeTable.test.ts fails CI over it.
 *
 *   'public'        no session needed
 *   'self'          any signed-in person, acting on their own account or data
 *   a Permission    the caller's role must grant it (@tagave/shared › permissions)
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Permission, type RoutePermission } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { PUBLIC_PREFIXES, ROUTE_PERMISSIONS } from './routeTable.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** What this route needs; see permissions/guard.ts. */
    permission?: RoutePermission;
  }
}

export const NOT_AVAILABLE = 'Not available for your account';

/** `METHOD /url` as routeTable.ts keys it (HEAD is GET's). */
export function routeKey(method: string, url: string): string {
  return `${method === 'HEAD' ? 'GET' : method} ${url}`;
}

/** What a route declared, or undefined (then nobody gets in). */
export function declaredPermission(method: string, url: string, config?: { permission?: RoutePermission } | undefined): RoutePermission | undefined {
  const declared = config?.permission ?? ROUTE_PERMISSIONS[routeKey(method, url)];
  if (declared !== undefined) return declared;
  return PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`)) ? 'public' : undefined;
}

/** Only the API is guarded; the web app's files and deep links are public by nature. */
export function isGuarded(url: string): boolean {
  return url === '/api' || url.startsWith('/api/');
}

/**
 * Root onRequest hook, after the session is resolved. Sends the refusal
 * itself (401 anonymous, 403 signed in without the permission).
 */
export async function enforceRoutePermission(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = request.routeOptions.url;
  // No route matched: the not-found handler answers.
  if (url === undefined || !isGuarded(url)) return;
  const needed = declaredPermission(request.method, url, request.routeOptions.config);
  if (needed === undefined) {
    request.log.error({ route: routeKey(request.method, url) }, 'route has no permission declared (permissions/routeTable.ts); refused');
    await reply.status(403).send({ status: 403, title: 'Forbidden', detail: NOT_AVAILABLE });
    return reply;
  }
  if (needed === 'public') return;
  if (!request.user) {
    await reply.status(401).send({ status: 401, title: 'Unauthorized', detail: 'Authentication required' });
    return reply;
  }
  if (needed === 'self') return;
  if (!can(request.user.role, needed)) {
    await reply.status(403).send({ status: 403, title: 'Forbidden', detail: NOT_AVAILABLE });
    return reply;
  }
}

/** Inside a handler, for a branch that needs more than the route's own permission. */
export function requirePermission(request: FastifyRequest, permission: Permission): NonNullable<FastifyRequest['user']> {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  if (!can(request.user.role, permission)) throw new ApiError(403, 'Forbidden', NOT_AVAILABLE);
  return request.user;
}

/** True when the signed-in caller has the permission (no throw). */
export function callerCan(request: FastifyRequest, permission: Permission): boolean {
  return Boolean(request.user && can(request.user.role, permission));
}
