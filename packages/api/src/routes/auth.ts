import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { sql } from 'drizzle-orm';
import { users } from '@liner/db';
import { getDb } from '../db.js';
import { APIError, LEGACY_SESSION_COOKIE, fromNodeHeaders } from '@liner/auth';
import { setupRequestSchema, loginRequestSchema } from '@liner/shared/auth';
import { ApiError } from '../middleware/errorHandler.js';
import { forwardSetCookies, getAuthHandle, toSessionUser, tryGetAuthHandle } from '../middleware/auth.js';
import { createAuthSecurityRoutes } from './authSecurity.js';

/** Held (transaction-scoped) while setup checks for and creates the owner. */
export const SETUP_LOCK_KEY = 7_302_026_101;

function isSecureConnection(request: FastifyRequest): boolean {
  return (
    request.protocol === 'https' ||
    request.headers['x-forwarded-proto']?.includes('https') === true
  );
}

export async function createAuthRoutes(fastify: FastifyInstance) {
  // Settings > Security (signed-in only)
  await fastify.register(createAuthSecurityRoutes);

  // Is the owner account still to be created? The login page sends a fresh
  // install to /setup on `true`. A database error is a 503, never a guess:
  // treating it as "setup required" would open the wizard on a broken
  // install instead of showing what is wrong.
  fastify.get('/setup-required', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const h = tryGetAuthHandle();
      const rows = h ? await h.sql`select 1 from users limit 1` : await getDb().select({ one: sql<number>`1` }).from(users).limit(1);
      return reply.status(200).send({ setupRequired: rows.length === 0 });
    } catch (err) {
      request.log.error({ err }, 'setup-required: user lookup failed');
      return reply.status(503).send({
        status: 503,
        title: 'Service Unavailable',
        detail: 'The app cannot read its database. Check that Postgres is running and that DATABASE_URL is right.',
      });
    }
  });

  // First-run owner account. Better Auth's HTTP sign-up stays disabled; the
  // owner is created server-side under an advisory lock, so two tabs cannot
  // both create one.
  fastify.post('/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isSecureConnection(request) && process.env.ALLOW_INSECURE_HTTP !== 'true') {
      throw new ApiError(
        400,
        'Insecure Connection',
        'Setup requires HTTPS. Set ALLOW_INSECURE_HTTP=true to allow HTTP in development.',
        '/api/v1/auth/setup'
      );
    }

    const body = setupRequestSchema.parse(request.body);
    const { auth, sql } = getAuthHandle();

    const created = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${SETUP_LOCK_KEY}::bigint)`;
      const existing = await tx`select 1 from users limit 1`;
      if (existing.length > 0) {
        throw new ApiError(409, 'Conflict', 'An owner account already exists', '/api/v1/auth/setup');
      }
      const res = await auth.api.createOwner({
        body: { email: body.email, password: body.password, name: body.displayName },
        headers: fromNodeHeaders(request.headers),
        returnHeaders: true,
      });
      const user = res.response.user;
      await tx`
        insert into libraries (id, owner_user_id, name, settings, created_at)
        values (${uuidv7()}, ${user.id}, 'My Music Library',
                ${tx.json({ contactString: body.contactString })}, now())`;
      return res;
    });

    forwardSetCookies(reply, created.headers);
    return reply.status(201).send({ user: toSessionUser(created.response.user) });
  });

  // Kept for one release so a 0.6.x SPA still signs in: a thin wrapper over
  // Better Auth's email sign-in (the SPA itself uses /api/auth/sign-in/email).
  fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = loginRequestSchema.parse(request.body);
    const { auth } = getAuthHandle();
    let result;
    try {
      result = await auth.api.signInEmail({
        body: { email: body.email, password: body.password },
        headers: fromNodeHeaders(request.headers),
        returnHeaders: true,
      });
    } catch (err) {
      if (err instanceof APIError && (err.statusCode === 401 || err.statusCode === 400)) {
        throw new ApiError(401, 'Unauthorized', 'Invalid email or password', '/api/v1/auth/login');
      }
      throw err;
    }
    forwardSetCookies(reply, result.headers);
    reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
    const response = result.response as { user?: Parameters<typeof toSessionUser>[0]; twoFactorRedirect?: boolean };
    if (response.twoFactorRedirect || !response.user) {
      throw new ApiError(403, 'Two-factor required', 'Sign in from the updated sign-in page to enter your code.', '/api/v1/auth/login');
    }
    return reply.status(200).send({ user: toSessionUser(response.user) });
  });

  // Kept for one release: signs out of Better Auth and drops any legacy session.
  fastify.post('/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const { auth, sql } = getAuthHandle();
    const legacy = request.cookies[LEGACY_SESSION_COOKIE];
    if (legacy && /^[0-9a-f-]{36}$/i.test(legacy)) {
      await sql`delete from sessions where id = ${legacy}`;
    }
    try {
      const res = await auth.api.signOut({ headers: fromNodeHeaders(request.headers), returnHeaders: true });
      forwardSetCookies(reply, res.headers);
    } catch (err) {
      request.log.debug({ err }, 'logout: no Better Auth session to end');
    }
    reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' }).status(200).send({ success: true });
  });

  // Get current user endpoint
  fastify.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required', '/api/v1/auth/me');
    }

    reply.status(200).send({ user: request.user });
  });
}
