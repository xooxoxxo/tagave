/**
 * The play queue per person, on the server (player module, 0055), so it
 * follows the person across devices, and their history:
 *
 *   POST   /api/v1/player/tracks              tracks by id, as the queue plays them (Play next, Add to queue, a playlist)
 *   GET    /api/v1/me/player/queue            the queue, each track resolved, and which device wrote it last
 *   GET    /api/v1/me/player/queue/stamp      which device plays and the revision (a device checks this to follow changes)
 *   PUT    /api/v1/me/player/queue            mode play (this device plays now), save (the device that plays: its place,
 *                                              its track, its own edits) or edit (another device changes the queue; the
 *                                              device that plays and its place stay). save and edit are refused (409)
 *                                              when the queue changed since their revision, save also once another device plays
 *   DELETE /api/v1/me/player/queue            stop: forget the queue
 *   GET    /api/v1/me/player/history          the person's plays, newest first
 *
 * Only the device that wrote last plays: another one that sees a newer stamp
 * from a different device pauses and takes the queue over (the web player).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { queueStateSchema, queueTracksRequestSchema, type PlayHistoryEntry, type QueueStampView, type QueueStateView, type QueueTrack } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getSql } from '../db.js';
import { getBoss } from '../boss.js';
import { permission, requirePlayer } from '../lib/playerAccess.js';
import { PlayerNotInstalled, queueTracks, readQueue, writeQueue } from '../lib/playQueue.js';
import { SubsonicError } from '@tagave/core/player';

const notInstalled = () => new ApiError(404, 'Not Found', 'The player is not installed on this server');

async function boss() {
  return getBoss().catch(() => null);
}

/** The player's own failures, as the album queue reports them. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PlayerNotInstalled) throw notInstalled();
    if (err instanceof SubsonicError) throw new ApiError(502, 'Bad Gateway', err.message);
    throw err;
  }
}

export async function createPlayerQueueRoutes(fastify: FastifyInstance) {
  fastify.post('/player/tracks', permission('player.use'), async (request: FastifyRequest): Promise<{ tracks: QueueTrack[] }> => {
    requirePlayer(request);
    const parsed = queueTracksRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'ids: a list of track ids');
    const sql = getSql();
    return { tracks: await guarded(async () => queueTracks({ sql, boss: await boss() }, parsed.data.ids)) };
  });

  fastify.get('/me/player/queue', permission('player.use'), async (request: FastifyRequest): Promise<QueueStateView> => {
    const user = requirePlayer(request);
    const sql = getSql();
    return guarded(async () => readQueue({ sql, boss: await boss() }, user.id));
  });

  fastify.get('/me/player/queue/stamp', permission('player.use'), async (request: FastifyRequest): Promise<QueueStampView> => {
    const user = requirePlayer(request);
    const [row] = await getSql()<Array<{ device_id: string; revision: number | string; updated_at: Date }>>`select device_id, revision, updated_at from player_queue_state where user_id = ${user.id}`;
    return { deviceId: row?.device_id ?? null, revision: row ? Number(row.revision) : 0, updatedAt: row ? new Date(row.updated_at).toISOString() : null };
  });

  fastify.put('/me/player/queue', permission('player.use'), async (request: FastifyRequest): Promise<{ updatedAt: string; revision: number }> => {
    const user = requirePlayer(request);
    const parsed = queueStateSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Not a queue');
    const saved = await writeQueue(getSql(), user.id, parsed.data);
    if (!saved.ok) throw new ApiError(409, 'Conflict', saved.reason === 'taken' ? 'Another device is playing this queue now.' : 'The queue changed on another device.');
    return { updatedAt: saved.updatedAt, revision: saved.revision };
  });

  fastify.delete('/me/player/queue', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    await getSql()`delete from player_queue_state where user_id = ${user.id}`;
    return { ok: true };
  });

  fastify.get('/me/player/history', permission('player.use'), async (request: FastifyRequest): Promise<{ plays: PlayHistoryEntry[] }> => {
    const user = requirePlayer(request);
    const limit = Math.min(200, Math.max(1, Number((request.query as { limit?: string }).limit) || 50));
    const rows = await getSql()<Array<{ id: string; local_track_id: string | null; local_album_id: string | null; title: string; artist: string | null; album: string | null; duration_ms: number | null; started_at: Date; has_art: boolean }>>`
      select p.id, p.local_track_id, p.local_album_id, p.title, p.artist, p.album, p.duration_ms, p.started_at,
             exists (select 1 from images i where i.local_album_id = p.local_album_id and i.kind = 'front') as has_art
        from player_plays p
       where p.user_id = ${user.id}
       order by p.started_at desc
       limit ${limit}`;
    return {
      plays: rows.map((r) => ({
        id: r.id,
        localTrackId: r.local_track_id,
        albumId: r.local_album_id,
        title: r.title,
        artist: r.artist,
        album: r.album,
        coverUrl: r.has_art && r.local_album_id ? `/api/v1/images/album/${r.local_album_id}` : null,
        durationMs: r.duration_ms,
        playedAt: new Date(r.started_at).toISOString(),
      })),
    };
  });
}
