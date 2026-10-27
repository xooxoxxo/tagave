/**
 * Playlists, a module of their own (0056): each person's private lists.
 *
 *   GET    /api/v1/me/playlists                      the person's lists (name, count, length, mosaic covers)
 *   POST   /api/v1/me/playlists                      { name, trackIds? } a new list (Save as playlist starts it with the queue)
 *   GET    /api/v1/me/playlists/export               every list of the person's, one file
 *   POST   /api/v1/me/playlists/import               { content, fileName? } tagave's file, M3U / M3U8 or XSPF
 *   GET    /api/v1/me/playlists/:id                  one list and its items
 *   PATCH  /api/v1/me/playlists/:id                  { name?, order? } rename, reorder
 *   DELETE /api/v1/me/playlists/:id                  delete the list
 *   POST   /api/v1/me/playlists/:id/items            { trackIds } or { albumId } at the end
 *   DELETE /api/v1/me/playlists/:id/items/:itemId    take one out
 *   GET    /api/v1/me/playlists/:id/export           one list, one file
 *   GET    /api/v1/settings/playlists                system.manage: the Settings › Modules row
 *   PUT    /api/v1/settings/playlists                system.manage + fresh step-up: { enabled }
 *   GET    /api/v1/settings/playlists/export         system.manage: everyone's lists, one file (Export first, before deleting its data)
 *   POST   /api/v1/settings/playlists/remove-data    system.manage + fresh step-up: turn it off, delete its rows
 *
 * The export (*.tagave-playlist.json, version 1) names each track by its
 * MusicBrainz ids, disc and track, title, artist, album and length; never
 * a file path. Off: every /me route answers 409.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { playlistsEnabled, removePlaylistsData, setPlaylistsEnabled } from '@tagave/db';
import { readBuildInfo } from '@tagave/core';
import { parsePlaylistFile, PlaylistFileError } from '@tagave/core/playlists';
import {
  addPlaylistItemsSchema, createPlaylistSchema, importPlaylistsSchema, patchPlaylistSchema, playlistsModuleSchema,
  type PlaylistFile, type PlaylistImportResult, type PlaylistSummary, type PlaylistView, type PlaylistsModuleView,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';
import {
  addToPlaylist, createPlaylist, deletePlaylist, exportPlaylists, getPlaylist, importPlaylists, listPlaylists, patchPlaylist, removePlaylistItem,
} from '../lib/playlists.js';

function user(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

const notFound = () => new ApiError(404, 'Not Found', 'Playlist not found');
const sql = () => getAuthHandle().sql;

async function on(): Promise<void> {
  if (!(await playlistsEnabled(sql()))) throw new ApiError(409, 'Conflict', 'Playlists are turned off.');
}

function generator(): string {
  const v = readBuildInfo().version;
  return v ? `tagave ${v}` : 'tagave';
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'playlists'}.tagave-playlist.json`;

function sendFile(reply: FastifyReply, name: string, file: PlaylistFile): string {
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('cache-control', 'no-store');
  return JSON.stringify(file, null, 2);
}

async function moduleView(): Promise<PlaylistsModuleView> {
  const [c] = await sql()<Array<{ playlists: number; people: number }>>`
    select count(*)::int as playlists, count(distinct user_id)::int as people from playlists`;
  return { enabled: await playlistsEnabled(sql()), playlists: c!.playlists, people: c!.people };
}

export async function createPlaylistRoutes(fastify: FastifyInstance) {
  fastify.get('/me/playlists', async (request): Promise<{ playlists: PlaylistSummary[] }> => {
    const me = user(request);
    await on();
    return { playlists: await listPlaylists(sql(), me.id) };
  });

  fastify.post('/me/playlists', async (request, reply): Promise<PlaylistView> => {
    const me = user(request);
    sameSite(request);
    await on();
    const parsed = createPlaylistSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'name: 1 to 200 characters');
    const id = await createPlaylist(sql(), me.id, parsed.data.name, parsed.data.trackIds ?? []);
    reply.status(201);
    return (await getPlaylist(sql(), me.id, id))!;
  });

  fastify.get('/me/playlists/export', async (request, reply) => {
    const me = user(request);
    await on();
    return sendFile(reply, fileName('playlists'), await exportPlaylists(sql(), { userId: me.id }, generator()));
  });

  fastify.post('/me/playlists/import', { bodyLimit: 25 * 1024 * 1024 }, async (request): Promise<PlaylistImportResult> => {
    const me = user(request);
    sameSite(request);
    await on();
    const parsed = importPlaylistsSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'content: the playlist file');
    let lists;
    try {
      lists = parsePlaylistFile(parsed.data.content, parsed.data.fileName).playlists;
    } catch (err) {
      if (err instanceof PlaylistFileError) throw new ApiError(400, 'Bad Request', err.message);
      throw err;
    }
    if (lists.length === 0) throw new ApiError(400, 'Bad Request', 'The file has no playlists.');
    const result = await importPlaylists(sql(), me.id, lists);
    request.log.info({ event: 'playlists.import', userId: me.id, playlists: result.playlists.length, matched: result.playlists.reduce((n, p) => n + p.matched, 0) }, 'playlists imported');
    return result;
  });

  fastify.get('/me/playlists/:id', async (request): Promise<PlaylistView> => {
    const me = user(request);
    await on();
    const view = await getPlaylist(sql(), me.id, (request.params as { id: string }).id);
    if (!view) throw notFound();
    return view;
  });

  fastify.patch('/me/playlists/:id', async (request): Promise<PlaylistView> => {
    const me = user(request);
    sameSite(request);
    await on();
    const { id } = request.params as { id: string };
    const parsed = patchPlaylistSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'name (1 to 200 characters) or order (every item once)');
    const res = await patchPlaylist(sql(), me.id, id, parsed.data);
    if (res === 'not_found') throw notFound();
    if (res === 'bad_order') throw new ApiError(409, 'Conflict', 'The playlist changed. Reload it and try again.');
    return (await getPlaylist(sql(), me.id, id))!;
  });

  fastify.delete('/me/playlists/:id', async (request) => {
    const me = user(request);
    sameSite(request);
    await on();
    if (!(await deletePlaylist(sql(), me.id, (request.params as { id: string }).id))) throw notFound();
    return { ok: true };
  });

  fastify.post('/me/playlists/:id/items', async (request): Promise<PlaylistView> => {
    const me = user(request);
    sameSite(request);
    await on();
    const { id } = request.params as { id: string };
    const parsed = addPlaylistItemsSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'trackIds or albumId');
    const added = await addToPlaylist(sql(), me.id, id, parsed.data);
    if (added === null) throw notFound();
    return (await getPlaylist(sql(), me.id, id))!;
  });

  fastify.delete('/me/playlists/:id/items/:itemId', async (request): Promise<PlaylistView> => {
    const me = user(request);
    sameSite(request);
    await on();
    const { id, itemId } = request.params as { id: string; itemId: string };
    if (!(await removePlaylistItem(sql(), me.id, id, itemId))) throw notFound();
    return (await getPlaylist(sql(), me.id, id))!;
  });

  fastify.get('/me/playlists/:id/export', async (request, reply) => {
    const me = user(request);
    await on();
    const { id } = request.params as { id: string };
    const view = await getPlaylist(sql(), me.id, id);
    if (!view) throw notFound();
    return sendFile(reply, fileName(view.name), await exportPlaylists(sql(), { userId: me.id, playlistId: id }, generator()));
  });

  // ---- Settings › Modules ----

  fastify.get('/settings/playlists', async (): Promise<PlaylistsModuleView> => moduleView());

  fastify.put('/settings/playlists', async (request): Promise<PlaylistsModuleView> => {
    sameSite(request);
    const parsed = playlistsModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    await setPlaylistsEnabled(sql(), parsed.data.enabled);
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: 'playlists', userId: request.user?.id }, 'playlists switched');
    return moduleView();
  });

  fastify.get('/settings/playlists/export', async (_request, reply) => {
    return sendFile(reply, fileName('tagave playlists'), await exportPlaylists(sql(), { userId: null }, generator()));
  });

  fastify.post('/settings/playlists/remove-data', async (request): Promise<PlaylistsModuleView & { removed: Record<string, number> }> => {
    sameSite(request);
    await requireFreshStepUp(request);
    // off first: nothing adds a row while they go
    await setPlaylistsEnabled(sql(), false);
    const removed = await removePlaylistsData(sql());
    await sql()`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${request.user?.id ?? null}, 'module.remove_data', 'module', ${JSON.stringify({ module: 'playlists', ...removed })}::text::jsonb)`;
    request.log.info({ event: 'module.remove_data', module: 'playlists', userId: request.user?.id, ...removed }, 'playlists data removed');
    return { ...(await moduleView()), removed };
  });
}
