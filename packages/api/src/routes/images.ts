import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { images, libraries, localAlbums } from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

export async function createImageRoutes(fastify: FastifyInstance) {
  /** 300px front-cover thumbnail for a local album (auth'd, cacheable). */
  fastify.get('/images/album/:albumId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId } = request.params as { albumId: string };
    const db = getDb();

    const rows = await db
      .select({
        thumb: images.thumbBytes,
        libraryId: images.libraryId,
        owner: libraries.ownerUserId,
      })
      .from(images)
      .innerJoin(libraries, eq(libraries.id, images.libraryId))
      .where(and(eq(images.localAlbumId, albumId), eq(images.kind, 'front')))
      .limit(1);
    const row = rows[0];
    if (!row || row.owner !== request.user.id) {
      throw new ApiError(404, 'Not Found', 'No cover for this album');
    }
    if (!row.thumb) throw new ApiError(404, 'Not Found', 'No thumbnail stored');

    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'private, max-age=86400, immutable')
      .send(Buffer.from(row.thumb as unknown as Buffer));
  });
}

void localAlbums;
