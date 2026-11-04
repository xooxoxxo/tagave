/**
 * Likes (0085; lib/likes.ts): each person's own hearts.
 *
 *   GET    /api/v1/me/likes                 { songs, albums, artists }: the ids the app marks liked
 *   GET    /api/v1/me/likes/songs           Liked songs, newest first
 *   PUT    /api/v1/me/likes/:kind/:id       like: song (a local track), album (a local album), artist
 *   DELETE /api/v1/me/likes/:kind/:id       unlike
 *
 * Both writes answer the new keys, so the app sets them at once. A thing
 * that is not in the library answers 404.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { likeKindSchema, type LikeKeysView, type LikedSongsView } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getSql } from '../db.js';
import { addLike, likeKeys, likedSongs, removeLike, targetOf } from '../lib/likes.js';
import { bustFilterCountsCache } from './albums.js';

function user(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

const sql = () => getSql();

async function target(request: FastifyRequest) {
  const { kind, id } = request.params as { kind: string; id: string };
  const k = likeKindSchema.safeParse(kind);
  if (!k.success) throw new ApiError(404, 'Not Found', 'Nothing to like there');
  const t = await targetOf(sql(), k.data, id);
  if (!t) throw new ApiError(404, 'Not Found', k.data === 'song' ? 'Song not found' : k.data === 'album' ? 'Album not found' : 'Artist not found');
  return t;
}

export async function createLikeRoutes(fastify: FastifyInstance) {
  fastify.get('/me/likes', async (request): Promise<LikeKeysView> => likeKeys(sql(), user(request).id));

  fastify.get('/me/likes/songs', async (request): Promise<LikedSongsView> => likedSongs(sql(), user(request).id));

  fastify.put('/me/likes/:kind/:id', async (request): Promise<LikeKeysView> => {
    const me = user(request);
    const t = await target(request);
    await addLike(sql(), me.id, t);
    if (t.kind === 'album') bustFilterCountsCache();
    return likeKeys(sql(), me.id);
  });

  fastify.delete('/me/likes/:kind/:id', async (request): Promise<LikeKeysView> => {
    const me = user(request);
    const t = await target(request);
    await removeLike(sql(), me.id, t);
    if (t.kind === 'album') bustFilterCountsCache();
    return likeKeys(sql(), me.id);
  });
}
