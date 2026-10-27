/**
 * Where the player module's server comes from: the bundled Navidrome (its
 * address and admin credentials are in the app's environment, written by
 * install-tagave.sh --with-player) or, when that is not set, the server the
 * owner saved in Settings › Playback (password sealed with APP_SECRET in
 * libraries.settings, like the other provider secrets).
 */
import { createHash } from 'node:crypto';
import { openSecret } from '../crypto/secretbox.js';
import type { SubsonicServer } from './subsonic.js';

export type PlayerManaged = 'bundled' | 'external';

export interface PlayerBackend {
  server: SubsonicServer;
  managed: PlayerManaged;
  /** names this server in player_track_map, so ids from another server are never reused */
  key: string;
}

/** The bundled server, when the app's environment names one. */
export function bundledPlayerServer(env: NodeJS.ProcessEnv = process.env): SubsonicServer | null {
  const url = env['TAGAVE_PLAYER_URL']?.trim();
  const username = env['TAGAVE_PLAYER_USER']?.trim();
  const password = env['TAGAVE_PLAYER_PASSWORD'];
  if (!url || !username || !password) return null;
  return { url, username, password };
}

/** The library settings keys of a bring-your-own server. */
export interface ExternalPlayerSettings {
  playerUrl?: unknown;
  playerUser?: unknown;
  /** sealed (enc:v1:…) */
  playerPassword?: unknown;
  /** before 0.13.2: the password's last four characters; dropped on the next save */
  playerPasswordHint?: unknown;
}

export function externalPlayerServer(settings: ExternalPlayerSettings | null | undefined, appSecret: string): SubsonicServer | null {
  if (!settings) return null;
  const { playerUrl, playerUser, playerPassword } = settings;
  if (typeof playerUrl !== 'string' || typeof playerUser !== 'string' || typeof playerPassword !== 'string') return null;
  if (!playerUrl || !playerUser || !playerPassword) return null;
  return { url: playerUrl, username: playerUser, password: openSecret(playerPassword, appSecret) };
}

export function playerServerKey(managed: PlayerManaged, server: Pick<SubsonicServer, 'url' | 'username'>): string {
  if (managed === 'bundled') return 'bundled';
  const h = createHash('sha256').update(`${server.url.trim().replace(/\/+$/, '')}|${server.username}`).digest('hex');
  return `ext:${h.slice(0, 16)}`;
}

/** The bundled server wins; otherwise the library's own. Throws only when a saved password cannot be opened. */
export function resolvePlayerBackend(
  settings: ExternalPlayerSettings | null | undefined,
  appSecret: string,
  env: NodeJS.ProcessEnv = process.env,
): PlayerBackend | null {
  const bundled = bundledPlayerServer(env);
  if (bundled) return { server: bundled, managed: 'bundled', key: playerServerKey('bundled', bundled) };
  const external = externalPlayerServer(settings, appSecret);
  if (external) return { server: external, managed: 'external', key: playerServerKey('external', external) };
  return null;
}
