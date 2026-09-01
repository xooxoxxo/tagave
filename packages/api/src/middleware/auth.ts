import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SessionUser } from '@liner/shared/auth';
import { makeDb, sessions, users } from '@liner/db';
import { eq } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser | undefined;
    sessionId?: string | undefined;
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// last_seen_at is bumped at most once per minute to keep reads cheap
const TOUCH_INTERVAL_MS = 60 * 1000;

type Db = Awaited<ReturnType<typeof makeDb>>['db'];

let db: Db | undefined;
function getDb(): Db {
  if (!db) {
    throw new Error('auth middleware used before init(db)');
  }
  return db;
}

export function initAuth(database: Db): void {
  db = database;
}

export async function authMiddleware(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionCookie = request.cookies['sessionId'];
    if (!sessionCookie) {
      request.user = undefined;
      return;
    }

    const rows = await getDb()
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, sessionCookie))
      .limit(1);

    const row = rows[0];
    if (!row || row.expiresAt.getTime() < Date.now()) {
      if (row) {
        await getDb().delete(sessions).where(eq(sessions.id, row.sessionId));
      }
      reply.clearCookie('sessionId');
      request.user = undefined;
      return;
    }

    if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await getDb()
        .update(sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(sessions.id, row.sessionId));
    }

    request.sessionId = row.sessionId;
    request.user = {
      id: row.userId,
      email: row.email,
      displayName: row.displayName ?? row.email,
      role: row.role as SessionUser['role'],
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function createSession(userId: string): Promise<string> {
  const inserted = await getDb()
    .insert(sessions)
    .values({ userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .returning({ id: sessions.id });
  const row = inserted[0];
  if (!row) {
    throw new Error('session insert returned no row');
  }
  return row.id;
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.id, sessionId));
}
