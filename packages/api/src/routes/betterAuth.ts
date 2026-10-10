import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { forwardSetCookies, getAuthHandle } from '../middleware/auth.js';

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
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie' && key !== 'content-length') reply.header(key, value);
      });
      forwardSetCookies(reply, response.headers);
      return reply.send(response.body ? await response.text() : null);
    },
  });
}
