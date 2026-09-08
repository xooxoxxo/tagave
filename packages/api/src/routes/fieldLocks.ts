import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { fieldLocks, auditLog, libraries, localAlbums } from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

export async function createFieldLocksRoutes(fastify: FastifyInstance) {
  // Get all field locks for an album
  fastify.get(
    '/libraries/:libraryId/albums/:albumId/locks',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };

      const db = getDb();

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      // Verify album belongs to the specified library
      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');

      // Get all field locks for the album
      const locks = await db
        .select()
        .from(fieldLocks)
        .where(
          and(
            eq(fieldLocks.libraryId, libraryId),
            eq(fieldLocks.scope, 'album'),
            eq(fieldLocks.scopeId, albumId)
          )
        )
        .orderBy(desc(fieldLocks.createdAt));

      reply.status(200).send(locks);
    }
  );

  // Delete all field locks for an album
  fastify.delete(
    '/libraries/:libraryId/albums/:albumId/locks',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };

      const db = getDb();

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      // Verify album belongs to the specified library
      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');

      // Get count of locks to delete
      const locksToDelete = await db
        .select()
        .from(fieldLocks)
        .where(
          and(
            eq(fieldLocks.libraryId, libraryId),
            eq(fieldLocks.scope, 'album'),
            eq(fieldLocks.scopeId, albumId)
          )
        );

      // Delete all field locks for the album
      await db
        .delete(fieldLocks)
        .where(
          and(
            eq(fieldLocks.libraryId, libraryId),
            eq(fieldLocks.scope, 'album'),
            eq(fieldLocks.scopeId, albumId)
          )
        );

      reply.status(200).send({ deletedCount: locksToDelete.length });
    }
  );

  // Delete a single field lock
  fastify.delete(
    '/libraries/:libraryId/locks/:lockId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, lockId } = request.params as { libraryId: string; lockId: string };

      const db = getDb();

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      // Verify lock belongs to the specified library
      const locks = await db
        .select()
        .from(fieldLocks)
        .where(and(eq(fieldLocks.id, lockId), eq(fieldLocks.libraryId, libraryId)))
        .limit(1);
      if (locks.length === 0) throw new ApiError(404, 'Not Found', 'Lock not found');

      // Delete the lock
      await db.delete(fieldLocks).where(eq(fieldLocks.id, lockId));

      reply.status(200).send({ success: true });
    }
  );

  // Get history for an album (including lock events)
  fastify.get(
    '/libraries/:libraryId/albums/:albumId/history',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };

      const db = getDb();

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      // Verify album belongs to the specified library
      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');

      // Get all lock creation events for the album from audit log
      const events = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.libraryId, libraryId),
            eq(auditLog.action, 'lock.create'),
            eq(auditLog.subjectType, 'field')
          )
        )
        .orderBy(desc(auditLog.at));

      // Filter to only events for locks related to this album
      const albumEvents = events.filter((e) => {
        const payload = e.payload as Record<string, any> | null;
        return payload?.album_id === albumId;
      });

      // Transform to history format
      const history = albumEvents.map((e) => {
        const payload = e.payload as Record<string, any> | null || {};
        return {
          eventType: 'lock',
          field: payload.field,
          value: payload.value,
          createdAt: e.at,
        };
      });

      reply.status(200).send(history);
    }
  );
}
