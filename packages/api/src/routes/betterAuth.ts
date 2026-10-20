import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { forwardSetCookies, getAuthHandle } from '../middleware/auth.js';
import { RateLimiter } from '../lib/rateLimit.js';

/**
 * The Better Auth endpoints tagave uses; every other one answers 404 (deny
 * by default). Each acts on the caller's own session or account only: no
 * admin plugin is installed, so nobody reaches another person's sessions,
 * passkeys or password through here. Account changes for someone else go
 * through Settings › Users (routes/users.ts, owner only).
 */
export const BETTER_AUTH_ALLOWED: ReadonlySet<string> = new Set([
  'GET /ok',
  'GET /error',
  'GET /get-session',
  'POST /get-session',
  'POST /sign-in/email',
  'POST /sign-out',
  'POST /change-password',
  'POST /update-user',
  'GET /list-sessions',
  'POST /revoke-session',
  'POST /revoke-other-sessions',
  'POST /two-factor/enable',
  'POST /two-factor/disable',
  'POST /two-factor/get-totp-uri',
  'POST /two-factor/verify-totp',
  'POST /two-factor/verify-backup-code',
  'POST /two-factor/generate-backup-codes',
  'GET /passkey/generate-register-options',
  'POST /passkey/verify-registration',
  'GET /passkey/generate-authenticate-options',
  'POST /passkey/verify-authentication',
  'GET /passkey/list-user-passkeys',
  'POST /passkey/update-passkey',
  'POST /passkey/delete-passkey',
]);

export function betterAuthAllowed(method: string, pathname: string): boolean {
  const path = pathname.startsWith('/api/auth') ? pathname.slice('/api/auth'.length) : pathname;
  return BETTER_AUTH_ALLOWED.has(`${method} ${path.replace(/\/+$/, '') || '/'}`);
}

/**
 * Wrong passwords per account, from any address: Better Auth limits sign-in
 * per client address only, and a client on the LAN can name any address in
 * X-Forwarded-For. The authenticator-code checks lock per account in Better
 * Auth (10 wrong codes), step-up per person (stepUp.ts); a passkey cannot be
 * guessed.
 */
export const SIGN_IN_FAILURES_PER_ACCOUNT = 10;
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
export const ACCOUNT_SIGN_IN_LIMITED = 'ACCOUNT_SIGN_IN_LIMITED';
const accountTries = new RateLimiter(SIGN_IN_FAILURES_PER_ACCOUNT, SIGN_IN_WINDOW_MS);

/** Tests only. */
export function resetAccountSignInLimits(): void {
  accountTries.reset();
}

/** The account a password try is for: the email of a sign-in, the person changing their password. */
function passwordTryKey(request: FastifyRequest, path: string, body: string | undefined): string | null {
  if (request.method !== 'POST') return null;
  if (path === '/sign-in/email') {
    try {
      const email = (JSON.parse(body ?? '') as { email?: unknown }).email;
      return typeof email === 'string' && email.trim() ? `email:${email.trim().toLowerCase()}` : null;
    } catch {
      return null;
    }
  }
  if (path === '/change-password' && request.user) return `user:${request.user.id}`;
  return null;
}

/**
 * Better Auth's HTTP surface at /api/auth/* (sign-in, sign-out, session,
 * two-factor, passkeys), handed to `auth.handler` as a Fetch Request.
 * Register it as a plugin: bodies reach Better Auth as the raw text the
 * browser sent (an empty JSON POST such as sign-out included).
 */
export async function createBetterAuthRoutes(fastify: FastifyInstance) {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { auth } = getAuthHandle();
      const url = new URL(request.url, `${request.protocol}://${request.headers.host ?? 'localhost'}`);
      if (!betterAuthAllowed(request.method, url.pathname)) {
        return reply.status(404).send({ status: 404, title: 'Not Found', detail: 'Not available on tagave' });
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(key, v);
        else headers.append(key, String(value));
      }
      const body = request.method !== 'GET' && typeof request.body === 'string' && request.body.length > 0 ? request.body : undefined;
      headers.delete('content-length');
      // a hit is taken before the try (tries at once cannot all pass) and handed back when it succeeds
      const tryKey = passwordTryKey(request, url.pathname.slice('/api/auth'.length).replace(/\/+$/, ''), body);
      const tryAt = Date.now();
      if (tryKey && !accountTries.allow(tryKey, tryAt)) {
        reply.header('retry-after', String(accountTries.retryAfterS(tryKey, tryAt)));
        return reply.status(429).send({ code: ACCOUNT_SIGN_IN_LIMITED, message: 'Too many wrong passwords for this account. Try again in 15 minutes.' });
      }
      const response = await auth.handler(
        new Request(url, { method: request.method, headers, ...(body !== undefined ? { body } : {}) }),
      );
      if (tryKey && response.ok) accountTries.release(tryKey, tryAt);
      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        if (key !== 'set-cookie' && key !== 'content-length') reply.header(key, value);
      });
      forwardSetCookies(reply, response.headers);
      return reply.send(response.body ? await response.text() : null);
    },
  });
}
