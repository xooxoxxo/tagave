/**
 * The opt-in player module (bundled Navidrome, or a Subsonic-compatible
 * server the owner runs):
 *
 *   GET    /api/v1/capabilities?libraryId=…             is a player set up, and does it answer
 *   GET    /api/v1/libraries/:libraryId/player          Settings › Playback (never a password)
 *   PUT    /api/v1/libraries/:libraryId/player/server   owner: bring your own server (tested before it is saved)
 *   DELETE /api/v1/libraries/:libraryId/player/server   owner: forget it
 *   POST   /api/v1/libraries/:libraryId/player/scan     owner: ask the server to look for changes now
 *   GET    /api/v1/libraries/:libraryId/player/scan-status  is the server scanning, and how far (first scan: a percent)
 *   GET    /api/v1/player/albums/:albumId/availability  can Play start on this album now (read-only, never scans)
 *   GET    /api/v1/player/albums/:albumId/queue         the album as a play queue (tracks matched to songs)
 *   GET    /api/v1/player/stream/:localTrackId          the audio, proxied (ranges for the original file)
 *   POST   /api/v1/player/events                        now playing / completed / skipped (playerSync turns them into plays)
 *
 * Every signed-in person may play (player.use); the server settings are the
 * owner's (system.manage). Streams and play reports use the person's own
 * account on the server (lib/playerPeople.ts), never the admin's.
 *
 * The browser only ever talks to tagave: the server's address and password
 * stay here, every stream needs a tagave session, and each user may hold a
 * few streams at once.
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { computeHint, sealSecret } from '@tagave/core';
import { ping, streamUrl, SubsonicError } from '@tagave/core/player';
import {
  playEventSchema,
  savePlayerServerSchema,
  streamQuerySchema,
  type CapabilitiesView,
  type PlayerSettingsView,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getSql } from '../db.js';
import { getBoss } from '../boss.js';
import {
  StreamLimiter,
  WindowLimiter,
  albumAvailability,
  albumById,
  albumQueue,
  backendFor,
  capabilityOf,
  clearCapabilityCache,
  firstLibrary,
  forgetSong,
  libraryById,
  playerScanStatus,
  requestPlayerScan,
  songIdFor,
  trackById,
  type PlayerLibrarySettings,
} from '../lib/player.js';
import { hasPlayerPermission, permission, requirePlayer } from '../lib/playerAccess.js';
import { PlayerAccountError, personServer } from '../lib/playerPeople.js';
import { kickPlayerSync } from '../lib/playerSync.js';
import { NavidromeError } from '@tagave/core/player';

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Per user: the track playing, the next one preloading, and a seek overlapping them. */
export const userStreams = new StreamLimiter(intEnv('TAGAVE_PLAYER_MAX_STREAMS', 4));
/** For the whole server, so a few users cannot tie up the player server. */
export const allStreams = new StreamLimiter(intEnv('TAGAVE_PLAYER_MAX_STREAMS_TOTAL', 24));
const eventLimit = new WindowLimiter(120, 60_000);
/** Headers from the player server must arrive within this. */
const UPSTREAM_HEADERS_MS = 20_000;
/** A stream that sends nothing for this long is cut (a stalled server or a stuck transcode). */
const UPSTREAM_IDLE_MS = 60_000;

const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

const requireUser = (request: FastifyRequest) => requirePlayer(request, 'player.use');
const requireOwnerRole = (request: FastifyRequest) => requirePlayer(request, 'system.manage');

const notInstalled = () => new ApiError(404, 'Not Found', 'The player is not installed on this server');

function appSecretValue(): string {
  const s = process.env['APP_SECRET'];
  if (!s) throw new ApiError(500, 'Internal Server Error', 'APP_SECRET is not set');
  return s;
}

async function settingsView(settings: PlayerLibrarySettings, fresh = false): Promise<PlayerSettingsView> {
  const backend = backendFor(settings);
  const capability = await capabilityOf(backend, { fresh });
  const bundled = backend?.managed === 'bundled';
  const external = typeof settings.playerUrl === 'string' && typeof settings.playerUser === 'string'
    ? { url: settings.playerUrl, username: settings.playerUser, passwordHint: typeof settings.playerPasswordHint === 'string' ? settings.playerPasswordHint : null }
    : null;
  return { capability, bundled, external, lastScan: settings.playerLastScan ?? null };
}

export async function createPlayerRoutes(fastify: FastifyInstance) {
  fastify.get('/capabilities', permission('player.use'), async (request: FastifyRequest) => {
    requireUser(request);
    const sql = getSql();
    const q = request.query as { libraryId?: string };
    const settings: PlayerLibrarySettings | null = (q.libraryId ? await libraryById(sql, q.libraryId) : await firstLibrary(sql))?.settings ?? null;
    const player = settings ? await capabilityOf(backendFor(settings)) : await capabilityOf(backendFor({}));
    return { player } satisfies CapabilitiesView;
  });

  fastify.get('/libraries/:libraryId/player', permission('player.use'), async (request: FastifyRequest) => {
    const user = requireUser(request);
    const { libraryId } = request.params as { libraryId: string };
    const lib = await libraryById(getSql(), libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    const view = await settingsView(lib.settings, (request.query as { fresh?: string }).fresh === '1');
    return hasPlayerPermission(user.role, 'system.manage') ? view : { ...view, external: null };
  });

  fastify.put('/libraries/:libraryId/player/server', permission('system.manage'), async (request: FastifyRequest) => {
    requireOwnerRole(request);
    const { libraryId } = request.params as { libraryId: string };
    const parsed = savePlayerServerSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    const sql = getSql();
    const lib = await libraryById(sql, libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    if (backendFor({})?.managed === 'bundled') {
      throw new ApiError(409, 'Conflict', 'This install runs the bundled player; its address and password are set in .env');
    }
    const saved = backendFor(lib.settings);
    const password = parsed.data.password ?? (saved?.managed === 'external' ? saved.server.password : undefined);
    if (!password) throw new ApiError(400, 'Bad Request', 'Enter the password for this user');
    const url = parsed.data.url.replace(/\/+$/, '');
    try {
      await ping({ url, username: parsed.data.username, password }, { timeoutMs: 8000 });
    } catch (err) {
      throw new ApiError(400, 'Bad Request', `Could not connect: ${(err as Error).message}`);
    }
    const next: PlayerLibrarySettings = {
      ...lib.settings,
      playerUrl: url,
      playerUser: parsed.data.username,
      playerPassword: sealSecret(password, appSecretValue()),
      playerPasswordHint: computeHint(password),
    };
    await sql`update libraries set settings = ${JSON.stringify(next)}::text::jsonb where id = ${libraryId}`;
    clearCapabilityCache();
    return settingsView(next, true);
  });

  fastify.delete('/libraries/:libraryId/player/server', permission('system.manage'), async (request: FastifyRequest) => {
    requireOwnerRole(request);
    const { libraryId } = request.params as { libraryId: string };
    const sql = getSql();
    const lib = await libraryById(sql, libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    const { playerUrl: _u, playerUser: _n, playerPassword: _p, playerPasswordHint: _h, ...rest } = lib.settings;
    await sql`update libraries set settings = ${JSON.stringify(rest)}::text::jsonb where id = ${libraryId}`;
    clearCapabilityCache();
    return settingsView(rest, true);
  });

  fastify.post('/libraries/:libraryId/player/scan', permission('system.manage'), async (request: FastifyRequest, reply: FastifyReply) => {
    requireOwnerRole(request);
    const { libraryId } = request.params as { libraryId: string };
    const sql = getSql();
    const lib = await libraryById(sql, libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    if (!backendFor(lib.settings)) throw notInstalled();
    await requestPlayerScan(sql, await getBoss(), libraryId, [''], 0);
    return reply.status(202).send({ requested: true });
  });

  fastify.get('/libraries/:libraryId/player/scan-status', permission('player.use'), async (request: FastifyRequest) => {
    requireUser(request);
    const { libraryId } = request.params as { libraryId: string };
    const sql = getSql();
    const lib = await libraryById(sql, libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    const backend = backendFor(lib.settings);
    if (!backend) throw notInstalled();
    try {
      return await playerScanStatus(sql, backend, libraryId);
    } catch (err) {
      if (err instanceof SubsonicError) throw new ApiError(502, 'Bad Gateway', err.message);
      throw err;
    }
  });

  fastify.get('/player/albums/:albumId/availability', permission('player.use'), async (request: FastifyRequest) => {
    requireUser(request);
    const { albumId } = request.params as { albumId: string };
    const sql = getSql();
    const album = await albumById(sql, albumId);
    if (!album) throw new ApiError(404, 'Not Found', 'Album not found');
    const lib = await libraryById(sql, album.library_id);
    const backend = backendFor(lib?.settings);
    if (!backend) throw notInstalled();
    try {
      return await albumAvailability({ sql, boss: null }, backend, album);
    } catch (err) {
      if (err instanceof SubsonicError) throw new ApiError(502, 'Bad Gateway', err.message);
      throw err;
    }
  });

  fastify.get('/player/albums/:albumId/queue', permission('player.use'), async (request: FastifyRequest) => {
    requireUser(request);
    const { albumId } = request.params as { albumId: string };
    const sql = getSql();
    const album = await albumById(sql, albumId);
    if (!album) throw new ApiError(404, 'Not Found', 'Album not found');
    const lib = await libraryById(sql, album.library_id);
    const backend = backendFor(lib?.settings);
    if (!backend) throw notInstalled();
    try {
      return await albumQueue({ sql, boss: await getBoss().catch(() => null) }, backend, album);
    } catch (err) {
      if (err instanceof SubsonicError) throw new ApiError(502, 'Bad Gateway', err.message);
      throw err;
    }
  });

  fastify.get('/player/stream/:localTrackId', { exposeHeadRoute: false, ...permission('player.use') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { localTrackId } = request.params as { localTrackId: string };
    const query = streamQuerySchema.safeParse(request.query ?? {});
    if (!query.success) throw new ApiError(400, 'Bad Request', query.error.issues[0]?.message ?? 'Invalid query');
    const sql = getSql();
    const track = await trackById(sql, localTrackId);
    if (!track) throw new ApiError(404, 'Not Found', 'Track not found');
    const backend = backendFor(track.settings);
    if (!backend) throw notInstalled();
    // the stream is this person's on the server (their account, made on their first play)
    let person;
    try {
      person = await personServer(sql, backend, user.id, { create: true });
    } catch (err) {
      if (err instanceof PlayerAccountError) throw new ApiError(err.status, err.status === 403 ? 'Forbidden' : 'Conflict', err.message);
      if (err instanceof NavidromeError) throw new ApiError(502, 'Bad Gateway', `The player could not make your account: ${err.message}`);
      throw err;
    }
    const as = person!.server;

    const releaseUser = userStreams.acquire(user.id);
    if (!releaseUser) {
      reply.header('retry-after', '2');
      throw new ApiError(429, 'Too Many Requests', `At most ${userStreams.max} streams at once per user`);
    }
    const releaseAll = allStreams.acquire('*');
    if (!releaseAll) {
      releaseUser();
      reply.header('retry-after', '5');
      throw new ApiError(429, 'Too Many Requests', 'The player is busy; try again in a moment');
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseUser();
      releaseAll();
    };
    const upstreamAbort = new AbortController();
    // the listener left (skipped, seeked, closed the tab): stop reading from the server
    reply.raw.on('close', () => {
      upstreamAbort.abort();
      release();
    });

    try {
      const resolve = async (): Promise<string | null> => {
        const known = await songIdFor(sql, localTrackId, backend.key);
        if (known) return known;
        const album = await albumById(sql, track.local_album_id);
        if (!album) return null;
        await albumQueue({ sql, boss: await getBoss().catch(() => null) }, backend, album);
        return songIdFor(sql, localTrackId, backend.key);
      };
      const { format, maxBitRate, offset } = query.data;
      const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;

      const open = async (songId: string) => {
        const timer = setTimeout(() => upstreamAbort.abort(), UPSTREAM_HEADERS_MS);
        try {
          return await fetch(streamUrl(as, songId, {
            format: format === 'original' ? 'raw' : format,
            ...(maxBitRate ? { maxBitRate } : {}),
            ...(offset ? { timeOffset: offset } : {}),
          }), {
            signal: upstreamAbort.signal,
            // a transcode is a new stream each time: only the original file can be read by ranges
            headers: format === 'original' && range ? { range } : {},
          });
        } finally {
          clearTimeout(timer);
        }
      };
      /** A Subsonic error comes back as JSON instead of audio. */
      const failure = async (res: Response): Promise<SubsonicError | null> => {
        const type = res.headers.get('content-type') ?? '';
        if (res.ok && !/json|xml/i.test(type)) return null;
        const body = await res.json().catch(() => null) as { 'subsonic-response'?: { error?: { code?: number; message?: string } } } | null;
        const e = body?.['subsonic-response']?.error;
        return new SubsonicError(e?.message ?? `The player server answered ${res.status}`, { code: e?.code ?? null, httpStatus: res.status });
      };

      let songId = await resolve();
      if (!songId) throw new ApiError(409, 'Conflict', 'This track is not on the player yet; tagave asked it to scan. Try again in a minute.');
      let res = await open(songId);
      let err = await failure(res);
      if (err?.code === 70) {
        // the server gave the file a new id (re-read after a tag change): match it again once
        await forgetSong(sql, localTrackId);
        songId = await resolve();
        if (!songId) throw new ApiError(409, 'Conflict', 'This track is not on the player yet; tagave asked it to scan. Try again in a minute.');
        res = await open(songId);
        err = await failure(res);
      }
      if (err) throw new ApiError(502, 'Bad Gateway', err.message);
      if (!res.body) throw new ApiError(502, 'Bad Gateway', 'The player server sent no audio');

      reply.status(res.status);
      for (const h of PASSTHROUGH_HEADERS) {
        const v = res.headers.get(h);
        if (v) reply.header(h, v);
      }
      if (format === 'original' && !res.headers.get('accept-ranges')) reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'private, no-cache');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-disposition', 'inline');

      // Streamed through as it arrives (pipe applies backpressure: nothing is
      // read from the server faster than the browser takes it); cut when the
      // server goes quiet.
      const body = Readable.fromWeb(res.body as never);
      let idle = setTimeout(() => body.destroy(new Error('the player server stopped sending')), UPSTREAM_IDLE_MS);
      body.on('data', () => {
        clearTimeout(idle);
        idle = setTimeout(() => body.destroy(new Error('the player server stopped sending')), UPSTREAM_IDLE_MS);
      });
      body.on('close', () => { clearTimeout(idle); release(); });
      body.on('error', () => { clearTimeout(idle); upstreamAbort.abort(); release(); });
      return reply.send(body);
    } catch (err) {
      release();
      if (err instanceof ApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        if (reply.raw.destroyed) return reply;
        throw new ApiError(504, 'Gateway Timeout', 'The player server did not answer in time');
      }
      if (err instanceof SubsonicError) throw new ApiError(502, 'Bad Gateway', err.message);
      throw new ApiError(502, 'Bad Gateway', `The player server could not be reached (${(err as Error).message})`);
    }
  });

  fastify.post('/player/events', permission('player.use'), async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    if (!eventLimit.allow(user.id)) throw new ApiError(429, 'Too Many Requests', 'Too many play events');
    const parsed = playEventSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    const e = parsed.data;
    const sql = getSql();
    const track = await trackById(sql, e.localTrackId);
    if (!track) throw new ApiError(404, 'Not Found', 'Track not found');
    const backend = backendFor(track.settings);
    const songId = backend ? await songIdFor(sql, e.localTrackId, backend.key) : null;
    // the client's clock is a hint: a time more than a day away is replaced by now
    const now = Date.now();
    const at = e.at ? Date.parse(e.at) : now;
    const occurredAt = new Date(Number.isFinite(at) && Math.abs(at - now) < 86_400_000 ? at : now);
    await sql`
      insert into player_events (user_id, library_id, local_track_id, local_album_id, release_id, recording_mbid,
                                 server_key, server_song_id, queue_id, kind, played_ms, position_ms, duration_ms, occurred_at)
      values (${user.id}, ${track.library_id}, ${track.id}, ${track.local_album_id}, ${track.release_id}, ${track.recording_mbid},
              ${backend?.key ?? null}, ${songId}, ${e.queueId}, ${e.kind}, ${e.playedMs}, ${e.positionMs}, ${track.duration_ms}, ${occurredAt.toISOString()})`;
    // plays, now playing and scrobbles go out within seconds
    kickPlayerSync();
    return reply.status(202).send({ recorded: true });
  });
}

