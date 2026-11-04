/**
 * Play in one place (Spotify Connect, within one person's own sessions).
 * Every tab or app session that has the player is a device; one of them
 * plays (the queue's device, PUT /me/player/queue mode play), the others
 * show what it plays and control it.
 *
 *   PUT    /api/v1/me/player/device             this device's state, every few seconds and on a change (its heartbeat)
 *   DELETE /api/v1/me/player/device/:deviceId   this device closed (pagehide)
 *   POST   /api/v1/me/player/command            play, pause, next, ... on another device of the person's
 *   GET    /api/v1/me/player/events             server-sent events: devices, queue, command
 */
import { z } from 'zod';

export const PLAYER_DEVICE_NAME_MAX = 60;

const trackSummarySchema = z.object({
  localTrackId: z.string().uuid(),
  title: z.string().max(500),
  artist: z.string().max(500),
  album: z.string().max(500),
  albumId: z.string().max(64).nullable(),
  coverUrl: z.string().max(500).nullable(),
  durationMs: z.number().int().min(0).nullable(),
}).strict();
export type PlayerTrackSummary = z.infer<typeof trackSummarySchema>;

/** PUT /api/v1/me/player/device */
export const playerDeviceStateSchema = z.object({
  /** a random id per tab (sessionStorage) */
  deviceId: z.string().min(8).max(64),
  /** "Chrome on Mac", or the name the person gave this browser */
  name: z.string().trim().min(1).max(PLAYER_DEVICE_NAME_MAX),
  /** what this device has loaded and plays (null on a device that only shows another one) */
  track: trackSummarySchema.nullable(),
  /** the queue entry it plays, -1 for none */
  index: z.number().int().min(-1),
  positionMs: z.number().int().min(0).max(24 * 3600_000),
  playing: z.boolean(),
  /** handed playback, the browser would not start it without a tap */
  blocked: z.boolean().default(false),
  volume: z.number().min(0).max(1),
  /** the page is in the background (its timers may run once a minute) */
  hidden: z.boolean().default(false),
  /** "Casting to …" while this device casts */
  casting: z.string().max(120).nullable().default(null),
}).strict();
export type PlayerDeviceState = z.infer<typeof playerDeviceStateSchema>;

export const PLAYER_COMMANDS = ['play', 'pause', 'next', 'previous', 'seek', 'volume', 'index', 'transfer'] as const;
export type PlayerCommandAction = (typeof PLAYER_COMMANDS)[number];

/**
 * POST /api/v1/me/player/command: sent to `deviceId`, one of the person's
 * devices.
 *   seek      value: seconds
 *   volume    value: 0 to 1
 *   index     index: the queue entry to play
 *   transfer  index and value (seconds): load the queue there and play
 */
export const playerCommandSchema = z.object({
  deviceId: z.string().min(8).max(64),
  action: z.enum(PLAYER_COMMANDS),
  value: z.number().min(0).max(24 * 3600).optional(),
  index: z.number().int().min(0).optional(),
  /** the device that sent it */
  from: z.string().min(8).max(64).optional(),
}).strict();
export type PlayerCommand = z.infer<typeof playerCommandSchema>;

/** One device as the events list it. */
export interface PlayerDeviceView extends PlayerDeviceState {
  /** a heartbeat within the last 20 s (90 s for a page in the background that does not play) */
  online: boolean;
  /** how long ago its state arrived, when the event was sent (no clocks are compared) */
  ageMs: number;
}

/** The device that plays the queue (its row, 0055) and the revision that made it so. */
export interface PlayerActive {
  deviceId: string;
  revision: number;
}

/** event: devices (on connect and on every change) */
export interface PlayerDevicesEvent {
  devices: PlayerDeviceView[];
  active: PlayerActive | null;
}

/** event: queue (the queue was written: follow it when `revision` is newer than yours) */
export interface PlayerQueueEvent {
  deviceId: string | null;
  revision: number;
  mode: 'play' | 'save' | 'edit' | 'clear';
}

/** event: command (only the device it names acts on it) */
export interface PlayerCommandEvent {
  to: string;
  from: string | null;
  action: PlayerCommandAction;
  value: number | null;
  index: number | null;
}

export const PLAYER_EVENT_TYPES = ['hello', 'devices', 'queue', 'command'] as const;
export type PlayerEventType = (typeof PLAYER_EVENT_TYPES)[number];

/** Postgres NOTIFY channel the api processes share presence on. */
export const PLAYER_EVENTS_CHANNEL = 'tagave_player';
