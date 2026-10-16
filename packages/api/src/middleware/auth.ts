import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionUser } from '@tagave/shared/auth';
import {
  LEGACY_SESSION_COOKIE,
  fromNodeHeaders,
  sessionCookieNames,
  type AuthHandle,
} from '@tagave/auth';
import { enforceRoutePermission } from '../permissions/guard.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser | undefined;
    /** The Better Auth session id (auth_sessions.id). */
    sessionId?: string | undefined;
  }
}

let handle: AuthHandle | undefined;

export function initAuth(h: AuthHandle): void {
  handle = h;
}

export function tryGetAuthHandle(): AuthHandle | undefined {
  return handle;
}

export function getAuthHandle(): AuthHandle {
  if (!handle) throw new Error('auth used before initAuth()');
  return handle;
}

/** A role as stored; anything unknown is the least (listener). */
export function toRole(role: unknown): SessionUser['role'] {
  return role === 'owner' || role === 'editor' ? role : 'listener';
}

/** Better Auth's user, as every route has always seen it (`request.user`). */
export function toSessionUser(user: {
  id: string;
  email: string;
  name?: string | null;
  role?: unknown;
  createdAt: Date | string;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.name || user.email,
    role: toRole(user.role),
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

/** Copy Better Auth's Set-Cookie headers onto a Fastify reply. */
export function forwardSetCookies(reply: FastifyReply, headers: Headers | null | undefined): void {
  if (!headers) return;
  const cookies = headers.getSetCookie();
  if (cookies.length === 0) return;
  const existing = reply.getHeader('set-cookie');
  const prior = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  reply.header('set-cookie', [...prior, ...cookies]);
}

function hasSessionCookie(request: FastifyRequest): boolean {
  return sessionCookieNames().some((n) => Boolean(request.cookies[n]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Bridged {
  setCookies: string[];
  /** name=value of the new session cookie, as a Cookie request header carries it */
  cookiePair: string;
  userId: string;
}

// Parallel first requests after the upgrade carry the same legacy cookie: they
// share one bridge (one new session) instead of racing to delete the row.
const inflight = new Map<string, Promise<Bridged | null>>();
const INFLIGHT_KEEP_MS = 60_000;

async function bridgeOnce(h: AuthHandle, legacyId: string, request: FastifyRequest): Promise<Bridged | null> {
  const rows = await h.sql<{ user_id: string; created_at: Date; expires_at: Date }[]>`
    select s.user_id, s.created_at, s.expires_at
      from sessions s join users u on u.id = s.user_id
     where s.id = ${legacyId}`;
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() < Date.now()) {
    await h.sql`delete from sessions where id = ${legacyId}`;
    return null;
  }
  const res = await h.auth.api.bridgeLegacySession({
    body: { userId: row.user_id, createdAt: row.created_at },
    returnHeaders: true,
  });
  const setCookies = res.headers.getSetCookie();
  const names = sessionCookieNames();
  const sessionCookie = setCookies.find((c) => names.some((n) => c.startsWith(`${n}=`)));
  if (!sessionCookie) throw new Error('session bridge: Better Auth set no session cookie');
  await h.sql`delete from sessions where id = ${legacyId}`;
  // Keyward's audit table arrives with L5; until then the bridge is logged.
  request.log.info({ event: 'auth.session.bridged', userId: row.user_id, sessionId: res.response.sessionId }, 'legacy session bridged to Better Auth');
  return { setCookies, cookiePair: sessionCookie.split(';')[0]!, userId: row.user_id };
}

/**
 * One-release bridge from the 0.6.x cookie (`sessionId`, a raw uuid) to a
 * Better Auth session, so nobody is signed out by the upgrade. Runs before
 * routing; the request that carries the legacy cookie is already served with
 * the new session. Removed in the release that drops the `sessions` table.
 */
export async function bridgeLegacySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const legacyId = request.cookies[LEGACY_SESSION_COOKIE];
  if (!legacyId) return;
  reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
  if (hasSessionCookie(request) || !UUID_RE.test(legacyId)) return;

  const h = getAuthHandle();
  let pending = inflight.get(legacyId);
  if (!pending) {
    pending = bridgeOnce(h, legacyId, request);
    inflight.set(legacyId, pending);
    const forget = () => setTimeout(() => inflight.delete(legacyId), INFLIGHT_KEEP_MS).unref();
    pending.then(forget, () => inflight.delete(legacyId));
  }
  const bridged = await pending;
  if (!bridged) return;

  forwardSetCookies(reply, new Headers(bridged.setCookies.map((c) => ['set-cookie', c] as [string, string])));
  // This very request continues signed in.
  request.headers.cookie = request.headers.cookie ? `${request.headers.cookie}; ${bridged.cookiePair}` : bridged.cookiePair;
  const eq = bridged.cookiePair.indexOf('=');
  request.cookies[bridged.cookiePair.slice(0, eq)] = decodeURIComponent(bridged.cookiePair.slice(eq + 1));
}

/** Resolve `request.user` from the Better Auth session (refreshing its cookie when due). */
export async function resolveSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  request.user = undefined;
  request.sessionId = undefined;
  if (!hasSessionCookie(request)) return;
  const { auth } = getAuthHandle();
  const { headers, response } = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
    returnHeaders: true,
  });
  forwardSetCookies(reply, headers);
  if (!response) return;
  // Turned off or removed: their sessions are deleted at that moment; this
  // covers a session that raced the change.
  const u = response.user as { disabledAt?: unknown; removedAt?: unknown };
  if (u.disabledAt || u.removedAt) return;
  request.sessionId = response.session.id;
  request.user = toSessionUser(response.user);
}

/**
 * Root hooks, in order: the legacy-cookie bridge, the session, then the
 * route's permission (permissions/guard.ts). All before the body is read, so
 * a refused request never gets that far.
 */
export async function authMiddleware(fastify: FastifyInstance) {
  fastify.addHook('onRequest', bridgeLegacySession);
  fastify.addHook('onRequest', async (request, reply) => {
    // Better Auth's own routes resolve the session themselves.
    if (!request.url.startsWith('/api/auth/')) await resolveSession(request, reply);
    return enforceRoutePermission(request, reply);
  });
}
