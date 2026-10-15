import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { forwardSetCookies, getAuthHandle } from '../middleware/auth.js';

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
      const response = await auth.handler(
        new Request(url, { method: request.method, headers, ...(body !== undefined ? { body } : {}) }),
      );
      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        if (key !== 'set-cookie' && key !== 'content-length') reply.header(key, value);
      });
      forwardSetCookies(reply, response.headers);
      return reply.send(response.body ? await response.text() : null);
    },
  });
}
