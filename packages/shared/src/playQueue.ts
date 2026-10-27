/**
 * The play queue per person, kept on the server (player module, 0055) so it
 * follows the person across devices; only the device that wrote it last
 * plays. And the person's history (their plays, newest first).
 */
import { z } from 'zod';
import type { PlayerQueueTrack } from './player.js';

/** Where a queue entry came from: added by hand (Play next, Add to queue), or the album or playlist that was started. */
export const queueOriginSchema = z.enum(['queued', 'context']);
export type QueueOrigin = z.infer<typeof queueOriginSchema>;

export const queueContextSchema = z.object({
  kind: z.enum(['album', 'playlist']),
  id: z.string().min(1).max(64),
  name: z.string().max(500),
}).strict();
export type QueueContext = z.infer<typeof queueContextSchema>;

export const QUEUE_MAX_ITEMS = 2000;

/** PUT /api/v1/me/player/queue */
export const queueStateSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), origin: queueOriginSchema }).strict()).max(QUEUE_MAX_ITEMS),
  context: queueContextSchema.nullable(),
  /** the playing entry, -1 for none */
  index: z.number().int().min(-1),
  positionMs: z.number().int().min(0).max(24 * 3600_000),
  /** a random id per browser: the device that wrote last is the one that plays */
  deviceId: z.string().min(8).max(64),
  /**
   * This device starts playing, or the person changed the queue here: it
   * becomes the device in use. Without it (a position saved while playing)
   * the write only lands while this device is still the one in use; else 409.
   */
  claim: z.boolean().optional(),
}).strict();
export type QueueStateInput = z.infer<typeof queueStateSchema>;

/** One entry of the queue: the track as the player plays it, with its album. */
export interface QueueTrack extends PlayerQueueTrack {
  /** local_albums.id */
  albumId: string;
  coverUrl: string | null;
  /** the album's credited artists with their ids (links), in credit order */
  artists: Array<{ id: string; name: string }>;
  /** release year, when known */
  year: number | null;
}

/** GET /api/v1/me/player/queue */
export interface QueueStateView {
  items: Array<QueueTrack & { origin: QueueOrigin }>;
  context: QueueContext | null;
  index: number;
  positionMs: number;
  deviceId: string | null;
  updatedAt: string | null;
}

/** POST /api/v1/player/tracks: tracks by id, as the queue plays them (in the order asked, unknown ids left out). */
export const queueTracksRequestSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(QUEUE_MAX_ITEMS) }).strict();

/** GET /api/v1/me/player/history: the person's plays, newest first. */
export interface PlayHistoryEntry {
  id: string;
  /** null when the track is no longer in the library */
  localTrackId: string | null;
  albumId: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  coverUrl: string | null;
  durationMs: number | null;
  playedAt: string;
}
