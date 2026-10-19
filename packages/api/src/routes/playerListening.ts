/**
 * Listening, per person, and the owner's Last.fm application:
 *
 *   GET    /api/v1/libraries/:libraryId/player/scrobbling   owner: is a Last.fm API key set (never the key)
 *   PUT    /api/v1/libraries/:libraryId/player/scrobbling   owner: save the API key + shared secret (checked with Last.fm first)
 *   DELETE /api/v1/libraries/:libraryId/player/scrobbling   owner: forget them
 *
 *   GET    /api/v1/me/listening                            the person's player account and scrobbling connections
 *   GET    /api/v1/me/listening/history                    their recent plays and album listens
 *   POST   /api/v1/me/listening/lastfm/start               where to send the browser to allow tagave on Last.fm
 *   GET    /api/v1/me/listening/lastfm/callback            Last.fm sends the browser back here (?token=…);
 *                                                           connecting queues the last 14 days' plays (&queued=n)
 *   DELETE /api/v1/me/listening/lastfm                     disconnect
 *   POST   /api/v1/me/listening/listenbrainz               connect with a pasted token (checked first); { services, queued }
 *   DELETE /api/v1/me/listening/listenbrainz               disconnect
 *   PUT    /api/v1/me/listening/phone-password             bundled player: a password for phone apps
 *   DELETE /api/v1/me/listening/phone-password             back to a random one
 *   PUT    /api/v1/me/listening/account                    the owner's own server: this person's login there
 *   DELETE /api/v1/me/listening/account                    forget it (back to the shared account)
 *
 * Everything under /me acts on the caller's own rows only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { lastfmAuthorizeUrl, lastfmCheckApp, lastfmSession, listenbrainzValidate } from '@tagave/core/scrobble';
import { NavidromeError } from '@tagave/core/player';
import {
  connectListenbrainzSchema,
  ownPlayerAccountSchema,
  phonePasswordSchema,
  saveLastfmAppSchema,
  scrobbleServiceSchema,
  type ListeningHistoryView,
  type ListeningView,
  type ScrobbleService,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getSql } from '../db.js';
import { backendFor, capabilityOf, firstLibrary, libraryById, type PlayerLibrarySettings } from '../lib/player.js';
import { permission, requirePlayer } from '../lib/playerAccess.js';
import { PlayerAccountError, accountView, clearPhonePassword, removeOwnAccount, saveOwnAccount, setPhonePassword } from '../lib/playerPeople.js';
import { pollStateOf } from '../lib/playerPlays.js';
import {
  accountViews,
  checkLastfmState,
  connectAccount,
  disconnectAccount,
  installLastfmApp,
  lastfmAppFrom,
  lastfmState,
  listenbrainzUrl,
  publicOrigin,
  scrobblingSettingsView,
  sealLastfmApp,
  type LastfmAppSettings,
} from '../lib/scrobbling.js';

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ApiError(400, 'Bad Request', r.error.issues[0]?.message ?? 'Invalid body');
  return r.data;
}

function accountError(err: unknown): never {
  if (err instanceof PlayerAccountError) throw new ApiError(err.status, err.status === 400 ? 'Bad Request' : err.status === 403 ? 'Forbidden' : 'Conflict', err.message);
  if (err instanceof NavidromeError) throw new ApiError(502, 'Bad Gateway', err.message);
  throw err;
}

async function libraryOf(request: FastifyRequest) {
  const q = request.query as { libraryId?: string };
  const sql = getSql();
  return q.libraryId ? libraryById(sql, q.libraryId) : firstLibrary(sql);
}

export async function createPlayerListeningRoutes(fastify: FastifyInstance) {
  // ---- the owner's Last.fm application ----

  fastify.get('/libraries/:libraryId/player/scrobbling', permission('system.manage'), async (request: FastifyRequest) => {
    requirePlayer(request, 'system.manage');
    const lib = await libraryById(getSql(), (request.params as { libraryId: string }).libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    return scrobblingSettingsView(lib.settings as unknown as LastfmAppSettings);
  });

  fastify.put('/libraries/:libraryId/player/scrobbling', permission('system.manage'), async (request: FastifyRequest) => {
    requirePlayer(request, 'system.manage');
    const { libraryId } = request.params as { libraryId: string };
    const body = parse(saveLastfmAppSchema, request.body);
    const sql = getSql();
    const lib = await libraryById(sql, libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    const probe = lastfmAppFrom({}, { ...process.env, TAGAVE_LASTFM_API_KEY: body.apiKey, TAGAVE_LASTFM_SECRET: body.secret });
    const checked = await lastfmCheckApp(probe!.app);
    if (!checked.ok) throw new ApiError(400, 'Bad Request', checked.reason);
    const next: PlayerLibrarySettings & LastfmAppSettings = { ...lib.settings, ...sealLastfmApp(body.apiKey, body.secret) };
    await sql`update libraries set settings = ${JSON.stringify(next)}::jsonb where id = ${libraryId}`;
    return scrobblingSettingsView(next);
  });

  fastify.delete('/libraries/:libraryId/player/scrobbling', permission('system.manage'), async (request: FastifyRequest) => {
    requirePlayer(request, 'system.manage');
    const { libraryId } = request.params as { libraryId: string };
    const sql = getSql();
    const lib = await libraryById(sql, libraryId);
    if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
    const { lastfmApiKey: _k, lastfmSecret: _s, lastfmApiKeyHint: _h, ...rest } = lib.settings as unknown as PlayerLibrarySettings & LastfmAppSettings;
    await sql`update libraries set settings = ${JSON.stringify(rest)}::jsonb where id = ${libraryId}`;
    return scrobblingSettingsView({});
  });

  // ---- the person's own ----

  fastify.get('/me/listening', permission('player.use'), async (request: FastifyRequest): Promise<ListeningView> => {
    const user = requirePlayer(request);
    const sql = getSql();
    const lib = await libraryOf(request);
    const backend = backendFor(lib?.settings ?? {});
    const cap = await capabilityOf(backend);
    const poll = backend ? await pollStateOf(sql, user.id, backend.key) : null;
    return {
      playerInstalled: cap.installed,
      account: await accountView(sql, backend, user.id),
      lastfmAvailable: !!(await installLastfmApp(sql, process.env, lib?.id ?? null)),
      services: await accountViews(sql, user.id),
      lastPollAt: poll?.last_poll_at ? new Date(poll.last_poll_at).toISOString() : null,
      pollError: poll?.last_error ?? null,
    };
  });

  fastify.get('/me/listening/history', permission('player.use'), async (request: FastifyRequest): Promise<ListeningHistoryView> => {
    const user = requirePlayer(request);
    const sql = getSql();
    const limit = Math.min(100, Math.max(1, Number((request.query as { limit?: string }).limit) || 30));
    const plays = await sql<Array<{ id: string; title: string; artist: string | null; album: string | null; local_album_id: string | null; started_at: Date; source: 'web' | 'server'; scrobbles: boolean }>>`
      select id, title, artist, album, local_album_id, started_at, source, scrobbles
      from player_plays where user_id = ${user.id} order by started_at desc limit ${limit}`;
    const scrobbles = plays.length
      ? await sql<Array<{ play_id: string; service: ScrobbleService; status: ListeningHistoryView['plays'][number]['scrobbled'][number]['status']; last_error: string | null }>>`
          select play_id, service, status, last_error from player_scrobbles where play_id = any(${plays.map((p) => p.id)}::uuid[])`
      : [];
    const listens = await sql<Array<{ id: string; local_album_id: string; album: string | null; artist: string | null; started_at: Date; ended_at: Date; tracks_heard: number; tracks_total: number }>>`
      select pl.id, pl.local_album_id, coalesce(r.title, la.title_guess) as album, la.artist_guess as artist,
             pl.started_at, pl.ended_at, pl.tracks_heard, pl.tracks_total
      from player_listens pl
      join local_albums la on la.id = pl.local_album_id
      left join releases r on r.id = pl.release_id
      where pl.user_id = ${user.id} order by pl.started_at desc limit ${limit}`;
    return {
      plays: plays.map((p) => ({
        id: p.id,
        title: p.title,
        artist: p.artist,
        album: p.album,
        localAlbumId: p.local_album_id,
        startedAt: new Date(p.started_at).toISOString(),
        source: p.source,
        scrobbles: p.scrobbles,
        scrobbled: scrobbles.filter((s) => s.play_id === p.id).map((s) => ({ service: s.service, status: s.status, error: s.last_error })),
      })),
      listens: listens.map((l) => ({
        id: l.id,
        localAlbumId: l.local_album_id,
        album: l.album,
        artist: l.artist,
        startedAt: new Date(l.started_at).toISOString(),
        endedAt: new Date(l.ended_at).toISOString(),
        tracksHeard: l.tracks_heard,
        tracksTotal: l.tracks_total,
      })),
    };
  });

  fastify.post('/me/listening/lastfm/start', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const lib = await libraryOf(request);
    const app = await installLastfmApp(getSql(), process.env, lib?.id ?? null);
    if (!app) throw new ApiError(409, 'Conflict', 'Last.fm is not set up on this server yet; the owner adds an API key in Settings › Playback');
    const origin = publicOrigin();
    if (!origin) throw new ApiError(500, 'Internal Server Error', 'PUBLIC_URL is not set');
    const cb = `${origin}/api/v1/me/listening/lastfm/callback?state=${encodeURIComponent(lastfmState(user.id))}`;
    return { url: lastfmAuthorizeUrl(app, cb) };
  });

  // The browser comes back from Last.fm: a page load, so it answers with a redirect to Settings.
  fastify.get('/me/listening/lastfm/callback', permission('self'), async (request: FastifyRequest, reply: FastifyReply) => {
    const back = (result: string, queued?: number) => reply.redirect(`/settings/listening?lastfm=${result}${queued ? `&queued=${queued}` : ''}`, 303);
    const user = request.user;
    if (!user) return reply.redirect('/login', 303);
    const { state, token } = request.query as { state?: string; token?: string };
    if (!checkLastfmState(state, user.id)) return back('expired');
    if (!token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) return back('refused');
    const sql = getSql();
    const app = await installLastfmApp(sql);
    if (!app) return back('unavailable');
    let queued: number;
    try {
      const session = await lastfmSession(app, token);
      queued = await connectAccount(sql, user.id, 'lastfm', session.name, session.key);
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'Last.fm connect');
      return back('failed');
    }
    return back('connected', queued);
  });

  fastify.post('/me/listening/listenbrainz', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const { token } = parse(connectListenbrainzSchema, request.body);
    let name: string | null;
    try {
      const apiUrl = listenbrainzUrl();
      name = await listenbrainzValidate(token, apiUrl ? { apiUrl } : {});
    } catch (err) {
      throw new ApiError(502, 'Bad Gateway', `ListenBrainz could not check the token: ${(err as Error).message}`);
    }
    if (!name) throw new ApiError(400, 'Bad Request', 'ListenBrainz does not accept this token. Copy it again from listenbrainz.org › Settings.');
    const sql = getSql();
    const queued = await connectAccount(sql, user.id, 'listenbrainz', name, token);
    return { services: await accountViews(sql, user.id), queued };
  });

  fastify.delete('/me/listening/:service', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const parsed = scrobbleServiceSchema.safeParse((request.params as { service: string }).service);
    if (!parsed.success) throw new ApiError(404, 'Not Found', 'No such service');
    const sql = getSql();
    await disconnectAccount(sql, user.id, parsed.data);
    return { services: await accountViews(sql, user.id) };
  });

  // ---- the person's account on the player server ----

  const backendOrFail = async (request: FastifyRequest) => {
    const lib = await libraryOf(request);
    const backend = backendFor(lib?.settings ?? {});
    if (!backend) throw new ApiError(404, 'Not Found', 'The player is not installed on this server');
    return backend;
  };

  fastify.put('/me/listening/phone-password', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const { password } = parse(phonePasswordSchema, request.body);
    const backend = await backendOrFail(request);
    const sql = getSql();
    try { await setPhonePassword(sql, backend, user.id, password); } catch (err) { accountError(err); }
    return { account: await accountView(sql, backend, user.id) };
  });

  fastify.delete('/me/listening/phone-password', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const backend = await backendOrFail(request);
    const sql = getSql();
    try { await clearPhonePassword(sql, backend, user.id); } catch (err) { accountError(err); }
    return { account: await accountView(sql, backend, user.id) };
  });

  fastify.put('/me/listening/account', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const body = parse(ownPlayerAccountSchema, request.body);
    const backend = await backendOrFail(request);
    const sql = getSql();
    try { await saveOwnAccount(sql, backend, user.id, body); } catch (err) { accountError(err); }
    return { account: await accountView(sql, backend, user.id) };
  });

  fastify.delete('/me/listening/account', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const backend = await backendOrFail(request);
    const sql = getSql();
    try { await removeOwnAccount(sql, backend, user.id); } catch (err) { accountError(err); }
    return { account: await accountView(sql, backend, user.id) };
  });
}
