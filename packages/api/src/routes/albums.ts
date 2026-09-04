import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { libraries, localAlbums, audioFiles } from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

export async function createAlbumRoutes(fastify: FastifyInstance) {
  // Get albums for a library with pagination and filters
  fastify.get('/libraries/:libraryId/albums', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const { limit = '50', offset = '0', sort = 'added_date', filter, artist, search } =
      request.query as Record<string, string>;

    const db = getDb();

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
    const conds = [eq(localAlbums.libraryId, libraryId)];
    if (artist) conds.push(eq(localAlbums.artistGuess, artist));
    if (search) {
      conds.push(
        sql`(title_guess ilike ${'%' + search + '%'} or artist_guess ilike ${'%' + search + '%'})`,
      );
    }
    const albums = await db
      .select()
      .from(localAlbums)
      .where(and(...conds))
      .orderBy(sql`lower(coalesce(artist_guess, '')), year_guess nulls last, lower(coalesce(title_guess, ''))`)
      .limit(Math.min(parseInt(limit, 10), 500))
      .offset(parseInt(offset, 10));

    const limitN = parseInt(limit, 10);
    const offsetN = parseInt(offset, 10);
    // Shared contract (spec §13): cursor envelope { items, nextCursor }.
    // Cursor is the next offset until true keyset pagination lands.
    reply.status(200).send({
      items: await (async () => {
        const withArt = new Set(
          (
            await db.execute(
              sql`select local_album_id from images where kind = 'front' and local_album_id = any(${albums.map((a) => a.id)})`,
            ) as unknown as { local_album_id: string }[]
          ).map((r) => r.local_album_id),
        );
        return albums.map((album) => ({
        id: album.id,
        libraryId: album.libraryId,
        localAlbumId: album.id,
        title: album.titleGuess ?? 'Unknown Album',
        artistCredit: album.artistGuess ?? 'Unknown Artist',
        ...(album.yearGuess ? { year: album.yearGuess } : {}),
        formats: album.formats ?? [],
        state: album.state,
        trackCount: album.trackCount ?? 0,
        totalDurationMs: album.totalDurationMs ?? 0,
        coverUrl: withArt.has(album.id) ? `/api/v1/images/album/${album.id}` : null,
        ...(album.releaseId ? { releaseId: album.releaseId } : {}),
        ...(album.releaseGroupId ? { releaseGroupId: album.releaseGroupId } : {}),
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
        }));
      })(),
      nextCursor: albums.length === limitN ? String(offsetN + limitN) : null,
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

      const db = getDb();

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

    const db = getDb();

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
