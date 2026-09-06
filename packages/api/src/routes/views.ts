/**
 * Saved album-grid views (spec BRW-1 P1): a name plus the URL query of the
 * grid, per library.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { libraries, savedViews } from '@liner/db';
import { albumsQuerySchema, createSavedViewSchema, type SavedView } from '@liner/shared';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

async function assertLibrary(userId: string, libraryId: string) {
  const rows = await getDb()
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (rows.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
}

function toView(row: typeof savedViews.$inferSelect): SavedView {
  const parsed = albumsQuerySchema.safeParse(row.query ?? {});
  return {
    id: row.id,
    name: row.name,
    query: parsed.success ? parsed.data : {},
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createViewRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/saved-views', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    const rows = await getDb().select().from(savedViews).where(eq(savedViews.libraryId, libraryId)).orderBy(asc(savedViews.name));
    reply.send({ items: rows.map(toView) });
  });

  fastify.post('/libraries/:libraryId/saved-views', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(request.user.id, libraryId);
    const parsed = createSavedViewSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
    }
    const inserted = (await getDb()
      .insert(savedViews)
      .values({ libraryId, name: parsed.data.name.trim(), query: parsed.data.query })
      .returning())[0]!;
    reply.status(201).send(toView(inserted));
  });

  fastify.delete('/saved-views/:viewId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { viewId } = request.params as { viewId: string };
    const db = getDb();
    const row = (await db.select({ id: savedViews.id, libraryId: savedViews.libraryId }).from(savedViews).where(eq(savedViews.id, viewId)).limit(1))[0];
    if (!row) throw new ApiError(404, 'Not Found', 'Saved view not found');
    await assertLibrary(request.user.id, row.libraryId);
    await db.delete(savedViews).where(eq(savedViews.id, viewId));
    reply.send({ ok: true });
  });
}
