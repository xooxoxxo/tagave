import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SessionUser } from '@liner/shared/auth';

// Session storage (in production, consider Redis or similar)
const sessions = new Map<string, { user: SessionUser; expiresAt: number }>();

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function authMiddleware(fastify: FastifyInstance) {
  // Extend FastifyRequest to include user
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionCookie = request.cookies.sessionId;

    if (!sessionCookie) {
      request.user = undefined;
      return;
    }

    const session = sessions.get(sessionCookie);

    if (!session || session.expiresAt < Date.now()) {
      sessions.delete(sessionCookie);
      reply.clearCookie('sessionId');
      request.user = undefined;
      return;
    }

    // Store user in request context
    request.user = session.user;
  });
}

export function createSession(user: SessionUser): string {
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

  sessions.set(sessionId, {
    user,
    expiresAt,
  });

  return sessionId;
}

export function invalidateSession(sessionId: string) {
  sessions.delete(sessionId);
}
