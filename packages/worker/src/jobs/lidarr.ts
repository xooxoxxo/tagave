/**
 * The lidarr module's jobs (vault "tagave - Get Missing Albums", part B), on
 * the identify worker (outside calls, like Music Connections' pulls).
 *
 *   lidarr.poll   every 5 minutes, and soon after a Get: one queue call and
 *                 one album call for every open request, then each request's
 *                 state (Wanted, Downloading, Importing, Not found). An album
 *                 Lidarr imported gets a scan of the folder its files are in,
 *                 when that folder is inside a music folder (as the path
 *                 mapping, "Lidarr sees the music folder as", turns Lidarr's
 *                 path into tagave's); otherwise the request says so
 *                 (Settings warns). A request is done when
 *                 tagave holds a local album of its release group. Nothing
 *                 open: nothing is asked.
 *   lidarr.get    Get all missing: the artist's missing albums, one after
 *                 another (a few calls each), at most GET_ALL_MAX a run.
 *
 * Off (Settings › Modules), with no connection, or with a key this host's
 * APP_SECRET cannot open: both skip. The key is never logged.
 */
import {
  LidarrClient, LidarrError, albumFolderOf, getAlbumInLidarr, inScanRoot, lidarrConnectionOf, lidarrErrorText, observeLidarr,
  type LidarrAlbum, type LidarrConnection, type LidarrQueueItem, type LidarrSettings,
} from '@tagave/core/lidarr';
import { lidarrEnabled, lidarrStoredSettings, openLidarrRequests, upsertLidarrRequest, type LidarrRequestRow } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { insideAny, poolDirsOfRoot } from '../lib/naming.js';

export interface LidarrPollJobData {
  /** tests */
  now?: number;
}

export interface LidarrGetJobData {
  libraryId: string;
  artistId: string;
  userId: string | null;
}

export const GET_ALL_MAX = 50;
/** Albums whose Lidarr id is still unknown (a new artist's albums arrive after Lidarr refreshes it), looked up per run. */
const LOOKUPS_PER_RUN = 20;
/** An imported album tagave has not matched yet: its folder is scanned again after this. */
const RESCAN_AFTER_MS = 6 * 3600_000;


async function setup(ctx: WorkerContext): Promise<{ conn: LidarrConnection; client: LidarrClient } | { skipped: string }> {
  if (!(await lidarrEnabled(ctx.sql))) return { skipped: 'off' };
  const appSecret = process.env['APP_SECRET'];
  if (!appSecret) return { skipped: 'no APP_SECRET on this host' };
  let conn: LidarrConnection | null;
  try {
    conn = lidarrConnectionOf(await lidarrStoredSettings(ctx.sql) as LidarrSettings, appSecret);
  } catch {
    return { skipped: 'the saved API key does not open with this APP_SECRET' };
  }
  if (!conn) return { skipped: 'not connected' };
  return { conn, client: new LidarrClient(conn.server) };
}

type PollResult = { skipped: string } | { checked: number; done: number; scans: number };

export async function lidarrPollJob(ctx: WorkerContext, data: LidarrPollJobData = {}): Promise<PollResult> {
  const now = data.now ?? Date.now();
  const s = await setup(ctx);
  if ('skipped' in s) return s;
  const rows = await openLidarrRequests(ctx.sql);
  if (rows.length === 0) return { skipped: 'nothing open' };
  const { client } = s;
  const { sql } = ctx;

  let queue: LidarrQueueItem[];
  try {
    queue = (await client.queue(500)).records;
  } catch (err) {
    ctx.logger.warn({ err: lidarrErrorText(err) }, 'lidarr.poll: queue not read');
    return { skipped: lidarrErrorText(err) };
  }
  const queuedBy = new Map<number, LidarrQueueItem[]>();
  for (const q of queue) if (q.albumId != null) queuedBy.set(q.albumId, [...(queuedBy.get(q.albumId) ?? []), q]);

  // albums Lidarr did not have an id for yet
  let lookups = 0;
  for (const r of rows) {
    if (r.lidarr_album_id !== null || lookups >= LOOKUPS_PER_RUN) continue;
    lookups++;
    const [rg] = await sql<Array<{ mbid: string | null }>>`select mbid::text as mbid from release_groups where id = ${r.release_group_id}`;
    if (!rg?.mbid) continue;
    try {
      const a = await client.albumByMbid(rg.mbid);
      if (a) {
        if (!a.monitored) await client.setMonitored([a.id], true);
        await client.searchAlbums([a.id]);
        r.lidarr_album_id = a.id;
        await sql`update lidarr_requests set lidarr_album_id = ${a.id}, updated_at = now() where id = ${r.id}`;
      }
    } catch (err) {
      ctx.logger.warn({ requestId: r.id, err: lidarrErrorText(err) }, 'lidarr.poll: album lookup failed');
    }
  }

  const ids = [...new Set(rows.map((r) => r.lidarr_album_id).filter((i): i is number => i !== null))];
  const albums = new Map<number, LidarrAlbum>();
  try {
    for (let i = 0; i < ids.length; i += 100) for (const a of await client.albumsById(ids.slice(i, i + 100))) albums.set(a.id, a);
  } catch (err) {
    ctx.logger.warn({ err: lidarrErrorText(err) }, 'lidarr.poll: albums not read');
    return { skipped: lidarrErrorText(err) };
  }

  const roots = (await sql<Array<{ id: string; path: string; host_path: string | null }>>`
    select id::text as id, path, host_path from scan_roots where enabled`).map((r) => ({ id: r.id, path: r.path, hostPath: r.host_path }));

  let done = 0;
  let scans = 0;
  for (const r of rows) {
    const [held] = await sql`select 1 from local_albums where release_group_id = ${r.release_group_id} and library_id = ${r.library_id} limit 1`;
    if (held) {
      await sql`update lidarr_requests set state = 'done', progress = null, last_error = null, done_at = now(), updated_at = now() where id = ${r.id}`;
      done++;
      continue;
    }
    const album = r.lidarr_album_id !== null ? albums.get(r.lidarr_album_id) ?? null : null;
    const obs = observeLidarr(album, r.lidarr_album_id !== null ? queuedBy.get(r.lidarr_album_id) ?? [] : [], new Date(r.requested_at), now);
    let error = obs.error;
    if (r.lidarr_album_id !== null && !album) error = 'Not in Lidarr';
    let path = r.lidarr_path;
    let outside = r.outside_roots;
    let scanAt = r.scan_requested_at;
    if (obs.state === 'imported' && album) {
      if (!path) {
        try {
          path = albumFolderOf((await client.trackFiles(album.id)).map((f) => f.path));
        } catch (err) {
          ctx.logger.warn({ requestId: r.id, err: lidarrErrorText(err) }, 'lidarr.poll: files not read');
        }
      }
      if (path) {
        // through the mapping when one is saved: Lidarr's /data/music/A/B is A/B of that music folder
        const where = inScanRoot(path, roots, s.conn.pathMap ?? null);
        outside = where === null;
        if (where && (!scanAt || now - new Date(scanAt).getTime() > RESCAN_AFTER_MS)) {
          // Lidarr's root folder may be the drop pool (0081): the pool imports
          // the album through the naming rules, and the request is done when
          // the album is in the library (the check above)
          if (insideAny(where.dirPath, await poolDirsOfRoot(ctx, where.scanRootId))) {
            await ctx.boss.send('pool.scan', { libraryId: r.library_id }, { singletonKey: `pool.scan:${r.library_id}` });
          } else {
            await ctx.boss.send('scan.dir', { ...where, reason: 'lidarr' }, { singletonKey: `scan.dir:${where.scanRootId}:${where.dirPath}` });
          }
          scanAt = new Date(now);
          scans++;
        }
      }
    }
    await sql`
      update lidarr_requests set state = ${obs.state}, progress = ${obs.progress}, last_error = ${error?.slice(0, 300) ?? null},
             lidarr_path = ${path}, outside_roots = ${outside}, scan_requested_at = ${scanAt ? new Date(scanAt).toISOString() : null}::timestamptz, updated_at = now()
       where id = ${r.id} and state <> 'done'`;
  }
  return { checked: rows.length, done, scans };
}

type GetResult = { skipped: string } | { asked: number; failed: number; stopped: string | null };

/** Get all missing: the artist's missing albums that are not asked for yet, one after another. */
export async function lidarrGetJob(ctx: WorkerContext, data: LidarrGetJobData): Promise<GetResult> {
  const s = await setup(ctx);
  if ('skipped' in s) return s;
  const { sql } = ctx;
  const wants = await sql<Array<{ id: string; mbid: string; artist_mbid: string; artist: string }>>`
    select rg.id::text as id, rg.mbid::text as mbid, a.mbid::text as artist_mbid, a.name as artist
      from gaps g
      join release_groups rg on rg.id = g.subject_id
      join lateral (select * from release_group_artists x where x.release_group_id = rg.id order by x.position limit 1) rga on true
      join artists a on a.id = rga.artist_id
     where g.library_id = ${data.libraryId} and g.kind = 'missing_album' and g.state in ('open', 'todo')
       and rg.mbid is not null and a.mbid is not null
       and exists (select 1 from release_group_artists x where x.release_group_id = rg.id and x.artist_id = ${data.artistId})
       and not exists (select 1 from local_albums la where la.release_group_id = rg.id and la.library_id = ${data.libraryId})
       and not exists (select 1 from lidarr_requests r where r.release_group_id = rg.id and r.library_id = ${data.libraryId} and r.state <> 'not_found')
     order by rg.first_release_date nulls last, rg.title
     limit ${GET_ALL_MAX}`;
  let asked = 0;
  let failed = 0;
  for (const w of wants) {
    if (!(await lidarrEnabled(sql))) return { asked, failed, stopped: 'turned off' };
    try {
      const got = await getAlbumInLidarr(s.client, s.conn, { releaseGroupMbid: w.mbid, artistMbid: w.artist_mbid, artistName: w.artist });
      await upsertLidarrRequest(sql, { libraryId: data.libraryId, releaseGroupId: w.id, lidarrAlbumId: got.albumId, lidarrArtistId: got.artistId, requestedBy: data.userId });
      asked++;
    } catch (err) {
      if (!(err instanceof LidarrError)) throw err;
      failed++;
      // Lidarr down or the key refused: the rest would fail the same way
      if (err.status === null || err.status === 401 || err.status === 403) return { asked, failed, stopped: err.message };
      ctx.logger.warn({ releaseGroupId: w.id, err: err.message }, 'lidarr.get: one album not asked');
    }
  }
  if (asked > 0) await ctx.boss.send('lidarr.poll', {}, { singletonKey: 'lidarr.poll', startAfter: 20 });
  return { asked, failed, stopped: null };
}

export type { LidarrRequestRow };
