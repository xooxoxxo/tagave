import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, like } from 'drizzle-orm';
import { makeDb, libraries, localAlbums, audioFiles } from '@liner/db';
import { ApiError } from '../middleware/errorHandler.js';

export async function createAlbumRoutes(fastify: FastifyInstance) {
  // Get albums for a library with pagination and filters
  fastify.get('/libraries/:libraryId/albums', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const { limit = '50', offset = '0', sort = 'added_date', filter } = request.query as Record<
      string,
      string
    >;

    const { db } = await makeDb(process.env.DATABASE_URL!);

    // Verify library ownership
    const lib = await db
      .select()
      .from(libraries)
      .where(
        and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
      );

    if (lib.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    // Query local albums
    const albums = await db
      .select()
      .from(localAlbums)
      .where(eq(localAlbums.libraryId, libraryId))
      .limit(Math.min(parseInt(limit, 10), 500))
      .offset(parseInt(offset, 10));

    const totalResult = await db
      .select()
      .from(localAlbums)
      .where(eq(localAlbums.libraryId, libraryId));

    reply.status(200).send({
      data: albums.map((album) => ({
        id: album.id,
        libraryId: album.libraryId,
        folderPaths: album.dirPaths,
        albumArtist: album.artistGuess,
        albumTitle: album.titleGuess,
        trackCount: album.trackCount,
        year: album.yearGuess,
        state: album.state,
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
      })),
      pagination: {
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        total: totalResult.length,
      },
    });
  });

  // Get single album details
  fastify.get(
    '/libraries/:libraryId/albums/:albumId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };

      const { db } = await makeDb(process.env.DATABASE_URL!);

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(
          and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
        );

      if (lib.length === 0) {
        throw new ApiError(404, 'Not Found', 'Library not found');
      }

      // Get album
      const albums = await db
        .select()
        .from(localAlbums)
        .where(
          and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId))
        );

      if (albums.length === 0) {
        throw new ApiError(404, 'Not Found', 'Album not found');
      }

      const album = albums[0];
      if (!album) {
        // Invariant: this should never happen since we checked albums.length > 0 above
        throw new ApiError(404, 'Not Found', 'Album not found');
      }

      // Get files in album
      const files = await db
        .select()
        .from(audioFiles)
        .where(eq(audioFiles.libraryId, libraryId));

      // Filter files belonging to this album's directories
      const albumFiles = files.filter((f) =>
        album.dirPaths?.some((dir) => f.relPath?.startsWith(dir))
      );

      reply.status(200).send({
        id: album.id,
        libraryId: album.libraryId,
        folderPaths: album.dirPaths,
        albumArtist: album.artistGuess,
        albumTitle: album.titleGuess,
        trackCount: album.trackCount,
        year: album.yearGuess,
        state: album.state,
        releaseId: album.releaseId,
        releaseGroupId: album.releaseGroupId,
        files: albumFiles.map((f) => ({
          id: f.id,
          path: f.relPath,
          container: f.container,
          codec: f.codec,
          duration: f.durationMs,
          bitrate: f.bitrateKbps,
          sampleRate: f.sampleRate,
          lossless: f.lossless,
        })),
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
      });
    }
  );

  // Search albums
  fastify.get('/search', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { q, type = 'album', limit = '20' } = request.query as Record<string, string>;

    if (!q) {
      throw new ApiError(400, 'Bad Request', 'Search query required');
    }

    const { db } = await makeDb(process.env.DATABASE_URL!);

    // Get user's libraries
    const userLibraries = await db
      .select()
      .from(libraries)
      .where(eq(libraries.ownerUserId, request.user.id));

    const libraryIds = userLibraries.map((l) => l.id);

    // Search albums across libraries
    const results: any[] = [];

    if (type === 'album' || type === 'all') {
      const albums = await db
        .select()
        .from(localAlbums)
        .limit(parseInt(limit, 10));

      const filtered = albums.filter(
        (a) =>
          libraryIds.includes(a.libraryId) &&
          (a.titleGuess?.toLowerCase().includes(q.toLowerCase()) ||
            a.artistGuess?.toLowerCase().includes(q.toLowerCase()))
      );

      results.push(
        ...filtered.map((a) => ({
          type: 'album',
          id: a.id,
          title: a.titleGuess,
          artist: a.artistGuess,
          libraryId: a.libraryId,
        }))
      );
    }

    reply.status(200).send({ results: results.slice(0, parseInt(limit, 10)) });
  });
}
