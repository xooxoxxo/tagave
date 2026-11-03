/**
 * Get missing albums through Lidarr, the lidarr module (vault "tagave - Get
 * Missing Albums", part B).
 *
 *   GET    /api/v1/lidarr                                             catalog.read: is Get set up, may this person Get
 *   GET    /api/v1/libraries/:libraryId/artists/:artistId/lidarr      catalog.read: the artist's missing albums' requests
 *   GET    /api/v1/libraries/:libraryId/lidarr/requests               system.manage: Library care › Getting
 *   POST   /api/v1/libraries/:libraryId/lidarr/requests               system.manage: Get { releaseGroupId }
 *   POST   /api/v1/libraries/:libraryId/lidarr/requests/:id/retry     system.manage: search again
 *   DELETE /api/v1/libraries/:libraryId/lidarr/requests/:id           system.manage: Cancel (unmonitor in Lidarr)
 *   POST   /api/v1/libraries/:libraryId/artists/:artistId/lidarr/get-all  system.manage: Get all missing (one job)
 *   GET    /api/v1/settings/lidarr                                    system.manage: Settings › Connections › Lidarr
 *   PUT    /api/v1/settings/lidarr                                    system.manage + fresh step-up: { enabled }
 *   POST   /api/v1/settings/lidarr/test                               system.manage: { url, apiKey? } → version, folders, profiles
 *   PUT    /api/v1/settings/lidarr/connection                         system.manage + fresh step-up: save (tested first)
 *   DELETE /api/v1/settings/lidarr/connection                         system.manage + fresh step-up: disconnect
 *   POST   /api/v1/settings/lidarr/remove-data                        system.manage + fresh step-up: turn off, delete the requests
 *
 * Get spends disk and bandwidth, so it is the owner's (system.manage, the
 * route table), checked here again. The key is sealed with APP_SECRET and
 * never answered or logged; Lidarr is called from here and the worker only.
 * Connect, disconnect, Get and Cancel write audit_log rows.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sealSecret } from '@tagave/core';
import {
  LidarrClient, LidarrError, getAlbumInLidarr, inScanRoot, lidarrConnectionOf, lidarrErrorText, normalizeLidarrUrl,
  type LidarrConnection, type LidarrSettings,
} from '@tagave/core/lidarr';
import {
  forgetLidarrSettings, lidarrEnabled, lidarrStoredSettings, removeLidarrData, saveLidarrSettings, setLidarrEnabled, upsertLidarrRequest,
  type LidarrRequestRow,
} from '@tagave/db';
import {
  can, displayArtistName, lidarrConnectionSchema, lidarrGetSchema, lidarrModuleSchema, lidarrTestSchema,
  type ArtistLidarrView, type LidarrGettingView, type LidarrRequestView, type LidarrSettingsView, type LidarrStatusView, type LidarrTestResult,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { getBoss } from '../boss.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Sql = ReturnType<typeof getAuthHandle>['sql'];

const client = (conn: { server: LidarrConnection['server'] }) => new LidarrClient(conn.server);

function owner(request: FastifyRequest): { id: string } {
  const u = request.user;
  if (!u) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  if (!can(u.role, 'system.manage')) throw new ApiError(403, 'Forbidden', 'Only the owner can get albums');
  return u;
}

function appSecret(): string {
  const s = process.env['APP_SECRET'];
  if (!s) throw new ApiError(500, 'Internal Server Error', 'APP_SECRET is not set');
  return s;
}

/** The saved connection; null when none. A key that no longer opens reads as none (keyUnreadable in the settings). */
async function connection(sql: Sql): Promise<LidarrConnection | null> {
  try {
    return lidarrConnectionOf(await lidarrStoredSettings(sql) as LidarrSettings, appSecret());
  } catch {
    return null;
  }
}

async function library(sql: Sql, libraryId: string): Promise<void> {
  if (!UUID_RE.test(libraryId)) throw new ApiError(404, 'Not Found', 'Library not found');
  const [row] = await sql`select 1 from libraries where id = ${libraryId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'Library not found');
}

async function audit(sql: Sql, libraryId: string | null, actor: string, action: string, payload: Record<string, unknown>): Promise<void> {
  await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
            values (${libraryId}, ${actor}, ${action}, 'lidarr', ${JSON.stringify(payload)}::text::jsonb)`;
}

const view = (r: LidarrRequestRow): LidarrRequestView => ({
  id: r.id,
  releaseGroupId: r.release_group_id,
  state: r.state,
  progress: r.state === 'downloading' ? r.progress : null,
  error: r.last_error,
  requestedAt: new Date(r.requested_at).toISOString(),
});

/** What Get asks Lidarr for: the album's and its first artist's MBIDs. Null: Get cannot ask for it. */
async function wantOf(sql: Sql, releaseGroupId: string) {
  const [rg] = await sql<Array<{ title: string; mbid: string | null; artist_mbid: string | null; artist: string | null }>>`
    select rg.title, rg.mbid::text as mbid, a.mbid::text as artist_mbid, a.name as artist
      from release_groups rg
      left join lateral (select * from release_group_artists x where x.release_group_id = rg.id order by x.position limit 1) rga on true
      left join artists a on a.id = rga.artist_id
     where rg.id = ${releaseGroupId}`;
  if (!rg) return null;
  if (!rg.mbid || !rg.artist_mbid) return { title: rg.title, want: null };
  return { title: rg.title, want: { releaseGroupMbid: rg.mbid, artistMbid: rg.artist_mbid, artistName: rg.artist ?? '' } };
}

async function scanRoots(sql: Sql) {
  return sql<Array<{ id: string; path: string; host_path: string | null }>>`
    select id::text as id, path, host_path from scan_roots where enabled order by path`;
}

async function settingsView(sql: Sql): Promise<LidarrSettingsView> {
  const s = await lidarrStoredSettings(sql);
  const roots = await scanRoots(sql);
  let keyUnreadable = false;
  if (typeof s['apiKey'] === 'string') {
    try {
      lidarrConnectionOf(s as LidarrSettings, appSecret());
    } catch {
      keyUnreadable = true;
    }
  }
  const saved = typeof s['url'] === 'string' && typeof s['rootFolderPath'] === 'string';
  const rootPath = saved ? String(s['rootFolderPath']) : null;
  const [counts] = await sql<Array<{ open: number; outside: number }>>`
    select count(*) filter (where state <> 'done')::int as open, count(*) filter (where outside_roots and state <> 'done')::int as outside
      from lidarr_requests`;
  const rootsList = roots.map((r) => ({ id: r.id, path: r.path, hostPath: r.host_path }));
  return {
    enabled: await lidarrEnabled(sql),
    connection: saved ? {
      url: String(s['url']),
      keySaved: typeof s['apiKey'] === 'string',
      keyUnreadable,
      rootFolderPath: rootPath!,
      qualityProfileId: Number(s['qualityProfileId']),
      metadataProfileId: Number(s['metadataProfileId']),
      version: typeof s['version'] === 'string' ? s['version'] : null,
      qualityProfileName: typeof s['qualityProfileName'] === 'string' ? s['qualityProfileName'] : null,
      metadataProfileName: typeof s['metadataProfileName'] === 'string' ? s['metadataProfileName'] : null,
    } : null,
    scanRoots: roots.map((r) => r.path),
    rootFolderOutside: (rootPath !== null && roots.length > 0 && !inScanRoot(rootPath, rootsList)) || (counts?.outside ?? 0) > 0,
    open: counts?.open ?? 0,
  };
}

/** Test a connection: the version and what the selects offer. */
async function test(server: { url: string; apiKey: string }): Promise<LidarrTestResult> {
  const c = client({ server });
  try {
    const status = await c.status();
    const [folders, quality, metadata] = await Promise.all([c.rootFolders(), c.qualityProfiles(), c.metadataProfiles()]);
    return {
      version: status.version,
      rootFolders: folders.map((f) => f.path),
      qualityProfiles: quality.map((p) => ({ id: p.id, name: p.name })),
      metadataProfiles: metadata.map((p) => ({ id: p.id, name: p.name })),
    };
  } catch (err) {
    if (err instanceof LidarrError) throw new ApiError(400, 'Bad Request', err.message);
    throw err;
  }
}

/** The key to test or save with: the one typed, or the saved one while the address is the same. */
async function keyFor(sql: Sql, url: string, typed: string | undefined): Promise<string> {
  if (typed) return typed;
  const s = await lidarrStoredSettings(sql);
  if (typeof s['url'] === 'string' && s['url'] === url && typeof s['apiKey'] === 'string') {
    const conn = await connection(sql);
    if (conn) return conn.server.apiKey;
  }
  throw new ApiError(400, 'Bad Request', 'Enter the API key');
}

const normalized = (raw: string) => {
  try {
    return normalizeLidarrUrl(raw);
  } catch (err) {
    throw new ApiError(400, 'Bad Request', (err as Error).message);
  }
};

/** Get one album: ask Lidarr, then record the request. A Lidarr failure is a 502 with its one line. */
export async function getOne(sql: Sql, conn: LidarrConnection, libraryId: string, releaseGroupId: string, userId: string | null): Promise<LidarrRequestRow> {
  const w = await wantOf(sql, releaseGroupId);
  if (!w) throw new ApiError(404, 'Not Found', 'Release group not found');
  if (!w.want) throw new ApiError(409, 'Conflict', 'No MusicBrainz id for this album or its artist');
  try {
    const got = await getAlbumInLidarr(client(conn), conn, w.want);
    return await upsertLidarrRequest(sql, { libraryId, releaseGroupId, lidarrAlbumId: got.albumId, lidarrArtistId: got.artistId, requestedBy: userId });
  } catch (err) {
    if (err instanceof LidarrError) throw new ApiError(502, 'Bad Gateway', lidarrErrorText(err));
    throw err;
  }
}

async function requestRow(sql: Sql, libraryId: string, id: string): Promise<LidarrRequestRow> {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'Not Found', 'No such request');
  const [row] = await sql<LidarrRequestRow[]>`select * from lidarr_requests where id = ${id} and library_id = ${libraryId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'No such request');
  return row;
}

async function ready(sql: Sql): Promise<LidarrConnection> {
  if (!(await lidarrEnabled(sql))) throw new ApiError(409, 'Conflict', 'Lidarr is turned off');
  const conn = await connection(sql);
  if (!conn) throw new ApiError(409, 'Conflict', 'Connect Lidarr first');
  return conn;
}

export async function createLidarrRoutes(fastify: FastifyInstance) {
  fastify.get('/lidarr', async (request): Promise<LidarrStatusView> => {
    const { sql } = getAuthHandle();
    const available = (await lidarrEnabled(sql)) && (await connection(sql)) !== null;
    return { available, canGet: available && can(request.user?.role, 'system.manage') };
  });

  fastify.get('/libraries/:libraryId/artists/:artistId/lidarr', async (request): Promise<ArtistLidarrView> => {
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    if (!UUID_RE.test(artistId)) throw new ApiError(404, 'Not Found', 'Artist not found');
    const on = await lidarrEnabled(sql);
    if (!on) return { available: false, canGet: false, requests: {}, gettable: [] };
    const available = (await connection(sql)) !== null;
    const rows = await sql<Array<LidarrRequestRow & { gettable: boolean }>>`
      select r.* from lidarr_requests r
       where r.library_id = ${libraryId}
         and exists (select 1 from release_group_artists x where x.release_group_id = r.release_group_id and x.artist_id = ${artistId})`;
    // what the artist page lists as missing (lib/artistAlbums.ts), with MBIDs for the album and its first artist
    const gettable = await sql<Array<{ id: string }>>`
      select rg.id::text as id
        from gaps g
        join release_groups rg on rg.id = g.subject_id
        left join lateral (select * from release_group_artists x where x.release_group_id = rg.id order by x.position limit 1) rga on true
        left join artists a on a.id = rga.artist_id
       where g.library_id = ${libraryId} and g.kind = 'missing_album' and g.state in ('open', 'todo')
         and rg.mbid is not null and a.mbid is not null
         and exists (select 1 from release_group_artists x where x.release_group_id = rg.id and x.artist_id = ${artistId})
         and not exists (select 1 from local_albums la where la.release_group_id = rg.id and la.library_id = ${libraryId})`;
    return {
      available,
      canGet: available && can(request.user?.role, 'system.manage'),
      requests: Object.fromEntries(rows.map((r) => [r.release_group_id, view(r)])),
      gettable: gettable.map((g) => g.id),
    };
  });

  fastify.get('/libraries/:libraryId/lidarr/requests', async (request): Promise<LidarrGettingView> => {
    owner(request);
    const { libraryId } = request.params as { libraryId: string };
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    const available = (await lidarrEnabled(sql)) && (await connection(sql)) !== null;
    const rows = await sql<Array<LidarrRequestRow & { title: string; artist: string | null; artist_id: string | null }>>`
      select r.*, rg.title, coalesce(rga.credited_name, a.name) as artist, a.id::text as artist_id
        from lidarr_requests r
        join release_groups rg on rg.id = r.release_group_id
        left join lateral (select * from release_group_artists x where x.release_group_id = rg.id order by x.position limit 1) rga on true
        left join artists a on a.id = rga.artist_id
       where r.library_id = ${libraryId} and r.state <> 'done'
       order by r.requested_at desc, r.id
       limit 500`;
    return { available, items: rows.map((r) => ({ ...view(r), title: r.title, artist: displayArtistName(r.artist) ?? r.artist, artistId: r.artist_id })) };
  });

  fastify.post('/libraries/:libraryId/lidarr/requests', async (request, reply) => {
    const me = owner(request);
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    const parsed = lidarrGetSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'releaseGroupId is required');
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    const conn = await ready(sql);
    const row = await getOne(sql, conn, libraryId, parsed.data.releaseGroupId, me.id);
    await audit(sql, libraryId, me.id, 'lidarr.get', { releaseGroupId: row.release_group_id, lidarrAlbumId: row.lidarr_album_id });
    request.log.info({ event: 'lidarr.get', userId: me.id, releaseGroupId: row.release_group_id }, 'album asked of lidarr');
    await kickPoll(request);
    return reply.status(201).send(view(row));
  });

  fastify.post('/libraries/:libraryId/lidarr/requests/:id/retry', async (request) => {
    const me = owner(request);
    sameSite(request);
    const { libraryId, id } = request.params as { libraryId: string; id: string };
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    const conn = await ready(sql);
    const row = await requestRow(sql, libraryId, id);
    const next = await getOne(sql, conn, libraryId, row.release_group_id, me.id);
    await audit(sql, libraryId, me.id, 'lidarr.retry', { releaseGroupId: row.release_group_id });
    return view(next);
  });

  fastify.delete('/libraries/:libraryId/lidarr/requests/:id', async (request, reply) => {
    const me = owner(request);
    sameSite(request);
    const { libraryId, id } = request.params as { libraryId: string; id: string };
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    const row = await requestRow(sql, libraryId, id);
    const conn = await connection(sql);
    // unmonitor only: no files, no artist are ever deleted in Lidarr
    let unmonitored = false;
    if (conn && row.lidarr_album_id !== null) {
      try {
        await client(conn).setMonitored([row.lidarr_album_id], false);
        unmonitored = true;
      } catch (err) {
        if (!(err instanceof LidarrError)) throw err;
        throw new ApiError(502, 'Bad Gateway', lidarrErrorText(err));
      }
    }
    await sql`delete from lidarr_requests where id = ${row.id}`;
    await audit(sql, libraryId, me.id, 'lidarr.cancel', { releaseGroupId: row.release_group_id, lidarrAlbumId: row.lidarr_album_id, unmonitored });
    request.log.info({ event: 'lidarr.cancel', userId: me.id, releaseGroupId: row.release_group_id }, 'lidarr request cancelled');
    return reply.status(204).send();
  });

  fastify.post('/libraries/:libraryId/artists/:artistId/lidarr/get-all', async (request, reply) => {
    const me = owner(request);
    sameSite(request);
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    if (!UUID_RE.test(artistId)) throw new ApiError(404, 'Not Found', 'Artist not found');
    await ready(sql);
    const boss = await getBoss();
    const jobId = await boss.send('lidarr.get', { libraryId, artistId, userId: me.id }, { singletonKey: `lidarr.get:${libraryId}:${artistId}`, retryLimit: 0 });
    await audit(sql, libraryId, me.id, 'lidarr.get', { artistId, all: true });
    request.log.info({ event: 'lidarr.get_all', userId: me.id, artistId }, 'all missing albums asked of lidarr');
    return reply.status(202).send({ queued: jobId !== null });
  });

  fastify.get('/settings/lidarr', async (request): Promise<LidarrSettingsView> => {
    owner(request);
    return settingsView(getAuthHandle().sql);
  });

  fastify.put('/settings/lidarr', async (request): Promise<LidarrSettingsView> => {
    const me = owner(request);
    sameSite(request);
    const parsed = lidarrModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    await setLidarrEnabled(sql, parsed.data.enabled);
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: 'lidarr', userId: me.id }, 'lidarr switched');
    return settingsView(sql);
  });

  fastify.post('/settings/lidarr/test', async (request): Promise<LidarrTestResult> => {
    owner(request);
    sameSite(request);
    const parsed = lidarrTestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'url is required');
    const { sql } = getAuthHandle();
    const url = normalized(parsed.data.url);
    return test({ url, apiKey: await keyFor(sql, url, parsed.data.apiKey) });
  });

  fastify.put('/settings/lidarr/connection', async (request): Promise<LidarrSettingsView> => {
    const me = owner(request);
    sameSite(request);
    const parsed = lidarrConnectionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    const url = normalized(parsed.data.url);
    const apiKey = await keyFor(sql, url, parsed.data.apiKey);
    const found = await test({ url, apiKey });
    if (!found.rootFolders.includes(parsed.data.rootFolderPath)) throw new ApiError(400, 'Bad Request', 'Pick a root folder Lidarr has');
    if (!found.qualityProfiles.some((p) => p.id === parsed.data.qualityProfileId)) throw new ApiError(400, 'Bad Request', 'Pick a quality profile Lidarr has');
    if (!found.metadataProfiles.some((p) => p.id === parsed.data.metadataProfileId)) throw new ApiError(400, 'Bad Request', 'Pick a metadata profile Lidarr has');
    await saveLidarrSettings(sql, {
      url,
      apiKey: sealSecret(apiKey, appSecret()),
      rootFolderPath: parsed.data.rootFolderPath,
      qualityProfileId: parsed.data.qualityProfileId,
      metadataProfileId: parsed.data.metadataProfileId,
      version: found.version,
      qualityProfileName: found.qualityProfiles.find((p) => p.id === parsed.data.qualityProfileId)!.name,
      metadataProfileName: found.metadataProfiles.find((p) => p.id === parsed.data.metadataProfileId)!.name,
    });
    await audit(sql, null, me.id, 'lidarr.connect', { version: found.version, key: parsed.data.apiKey ? 'set' : 'kept' });
    request.log.info({ event: 'lidarr.connect', userId: me.id, version: found.version }, 'lidarr connected');
    return settingsView(sql);
  });

  fastify.delete('/settings/lidarr/connection', async (request): Promise<LidarrSettingsView> => {
    const me = owner(request);
    sameSite(request);
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    await forgetLidarrSettings(sql);
    await audit(sql, null, me.id, 'lidarr.disconnect', {});
    request.log.info({ event: 'lidarr.disconnect', userId: me.id }, 'lidarr disconnected');
    return settingsView(sql);
  });

  fastify.post('/settings/lidarr/remove-data', async (request): Promise<LidarrSettingsView & { removed: Record<string, number> }> => {
    const me = owner(request);
    sameSite(request);
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    await setLidarrEnabled(sql, false);
    const removed = await removeLidarrData(sql);
    await audit(sql, null, me.id, 'module.remove_data', { module: 'lidarr', ...removed });
    request.log.info({ event: 'module.remove_data', module: 'lidarr', userId: me.id, ...removed }, 'lidarr data removed');
    return { ...(await settingsView(sql)), removed };
  });
}

/** A Get starts the poll at once, so Downloading shows without waiting for the schedule. Never fails the Get. */
async function kickPoll(request: FastifyRequest): Promise<void> {
  try {
    await (await getBoss()).send('lidarr.poll', {}, { singletonKey: 'lidarr.poll', startAfter: 20 });
  } catch (err) {
    request.log.warn({ err }, 'lidarr.poll not queued');
  }
}
