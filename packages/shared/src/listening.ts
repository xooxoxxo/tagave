import { z } from 'zod';

/**
 * The player module per person: each person's account on the player
 * server, their plays and listens, and their own Last.fm / ListenBrainz.
 *
 * Who scrobbles: tagave, never the player server. Plays from tagave's web
 * player come from its play events; plays from phone apps come from the
 * person's play counts on the player server. Each play is one row however
 * often it is seen, and each row is scrobbled once per service.
 */

export const scrobbleServiceSchema = z.enum(['lastfm', 'listenbrainz']);
export type ScrobbleService = z.infer<typeof scrobbleServiceSchema>;

/** Settings › Playback › Scrobbling (owner): the Last.fm application tagave signs scrobbles with. */
export interface ScrobblingSettingsView {
  lastfm: {
    /** an API key is set (here, or TAGAVE_LASTFM_API_KEY in .env) */
    configured: boolean;
    /** where it comes from */
    source: 'settings' | 'env' | null;
    /** last four characters of the API key, for recognition */
    apiKeyHint: string | null;
  };
  /** ListenBrainz needs nothing from the owner: each person pastes a token */
  listenbrainz: { available: true };
}

/** PUT /api/v1/libraries/:libraryId/player/scrobbling */
export const saveLastfmAppSchema = z.object({
  apiKey: z.string().trim().regex(/^[0-9a-f]{32}$/i, 'A Last.fm API key is 32 letters and digits (0-9, a-f)'),
  secret: z.string().trim().regex(/^[0-9a-f]{32}$/i, 'A Last.fm shared secret is 32 letters and digits (0-9, a-f)'),
}).strict();
export type SaveLastfmApp = z.infer<typeof saveLastfmAppSchema>;

export interface ScrobbleAccountView {
  service: ScrobbleService;
  connected: boolean;
  /** the person's name on that service */
  accountName: string | null;
  connectedAt: string | null;
  lastOkAt: string | null;
  /** the last problem in plain words (cleared by the next success) */
  lastError: string | null;
  lastErrorAt: string | null;
  /** scrobbles waiting to be sent (retrying) */
  pending: number;
}

/** The person's account on the player server, as far as they may know it (never a password). */
export interface PlayerAccountView {
  /** bundled: tagave made it; own: the person's login on the owner's server; shared: everyone plays as the owner's account */
  kind: 'bundled' | 'own' | 'shared' | 'none';
  username: string | null;
  /** bundled: the person set a password for phone apps */
  phonePassword: boolean;
  /** own server: it scrobbles for this person already, so tagave does not */
  serverScrobbles: boolean;
  state: 'active' | 'disabled' | null;
  lastError: string | null;
}

/** GET /api/v1/me/listening */
export interface ListeningView {
  playerInstalled: boolean;
  account: PlayerAccountView;
  /** Last.fm can be connected (the owner set an API key) */
  lastfmAvailable: boolean;
  services: ScrobbleAccountView[];
  /** plays from other apps: when the player server was last looked at for this person */
  lastPollAt: string | null;
  pollError: string | null;
}

export interface PlayHistoryItem {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  localAlbumId: string | null;
  startedAt: string;
  /** web: tagave's player; server: another app through the player server */
  source: 'web' | 'server';
  /** it counted (heard half, or four minutes, of a track longer than 30 s) */
  scrobbles: boolean;
  scrobbled: Array<{ service: ScrobbleService; status: 'pending' | 'sending' | 'sent' | 'ignored' | 'failed'; error: string | null }>;
}

export interface ListenHistoryItem {
  id: string;
  localAlbumId: string;
  album: string | null;
  artist: string | null;
  startedAt: string;
  endedAt: string;
  tracksHeard: number;
  tracksTotal: number;
}

/** GET /api/v1/me/listening/history */
export interface ListeningHistoryView {
  plays: PlayHistoryItem[];
  listens: ListenHistoryItem[];
}

/** POST /api/v1/me/listening/listenbrainz */
export const connectListenbrainzSchema = z.object({
  token: z.string().trim().min(8, 'Paste the whole token').max(200),
}).strict();

/** PUT /api/v1/me/listening/phone-password (bundled player) */
export const phonePasswordSchema = z.object({
  password: z.string().min(12, 'Use at least 12 characters').max(256),
}).strict();

/** PUT /api/v1/me/listening/account (the owner's own server): this person's login there */
export const ownPlayerAccountSchema = z.object({
  username: z.string().trim().min(1).max(255),
  /** omitted keeps the saved password */
  password: z.string().min(1).max(1024).optional(),
  serverScrobbles: z.boolean().default(false),
}).strict();
export type OwnPlayerAccount = z.infer<typeof ownPlayerAccountSchema>;

/** POST /api/v1/me/listening/lastfm/start: where the browser goes to allow tagave on Last.fm */
export interface LastfmStartView {
  url: string;
}
