/**
 * The lidarr module's switch, its connection and its requests (0075; vault
 * "tagave - Get Missing Albums", part B).
 *
 *   turn off          lidarr.poll and lidarr.get skip, Get hides; the
 *                     requests and the connection stay
 *   delete its data   lidarr_requests is emptied, nothing else (the
 *                     connection is the owner's setting, like the switch)
 *
 * The switch is the module ledger's row 'lidarr' (installed_modules), off
 * until the owner turns it on. The connection is that row's settings: the
 * address, the API key sealed with APP_SECRET (sealed and opened by the
 * callers, @tagave/core › lidarr), the root folder and the two profiles,
 * whether the root folder is the drop pool, and the path mapping.
 */
import type postgres from 'postgres';
import { moduleEnabled, moduleSettings, setModuleEnabled, setModuleSettings } from './modules.js';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;
type Q = Sql | Tx;

export const LIDARR_MODULE_ID = 'lidarr';
export const LIDARR_TABLES = ['lidarr_requests'] as const;

export async function lidarrEnabled(sql: Q): Promise<boolean> {
  return moduleEnabled(sql, LIDARR_MODULE_ID);
}

export async function setLidarrEnabled(sql: Q, enabled: boolean): Promise<void> {
  await setModuleEnabled(sql, LIDARR_MODULE_ID, enabled);
}

/** The saved connection as stored (the key still sealed). */
export async function lidarrStoredSettings(sql: Q): Promise<Record<string, unknown>> {
  return moduleSettings(sql, LIDARR_MODULE_ID);
}

export interface LidarrStored {
  url: string;
  /** sealed */
  apiKey: string;
  rootFolderPath: string;
  qualityProfileId: number;
  metadataProfileId: number;
  version: string | null;
  qualityProfileName: string;
  metadataProfileName: string;
  /** the drop pool is the root folder (absent: on while the pool is on) */
  useDropPool?: boolean | null;
  /** "Lidarr sees the music folder as" */
  pathMap?: { lidarrPath: string; scanRootId: string } | null;
}

export async function saveLidarrSettings(sql: Q, s: LidarrStored): Promise<void> {
  await setModuleSettings(sql, LIDARR_MODULE_ID, { ...s, version: s.version ?? null });
}

export async function forgetLidarrSettings(sql: Q): Promise<void> {
  await setModuleSettings(sql, LIDARR_MODULE_ID, { url: null, apiKey: null, rootFolderPath: null, qualityProfileId: null, metadataProfileId: null, version: null, qualityProfileName: null, metadataProfileName: null, useDropPool: null, pathMap: null });
}

/** Delete the module's data: exactly its rows. Idempotent. */
export async function removeLidarrData(sql: Sql): Promise<Record<(typeof LIDARR_TABLES)[number], number>> {
  return sql.begin(async (tx) => {
    const out = {} as Record<(typeof LIDARR_TABLES)[number], number>;
    for (const t of LIDARR_TABLES) out[t] = (await tx`delete from ${tx(t)}`).count;
    return out;
  });
}

export type LidarrRequestState = 'wanted' | 'downloading' | 'imported' | 'done' | 'not_found';

export interface LidarrRequestRow {
  id: string;
  library_id: string;
  release_group_id: string;
  state: LidarrRequestState;
  progress: number | null;
  lidarr_album_id: number | null;
  lidarr_artist_id: number | null;
  lidarr_path: string | null;
  outside_roots: boolean;
  scan_requested_at: Date | null;
  last_error: string | null;
  requested_by: string | null;
  requested_at: Date;
  updated_at: Date;
  done_at: Date | null;
}

/**
 * Record a Get (a new row, or a request asked again: back to wanted, the
 * Not found wait started over). Returns the row.
 */
export async function upsertLidarrRequest(sql: Q, r: {
  libraryId: string;
  releaseGroupId: string;
  lidarrAlbumId: number | null;
  lidarrArtistId: number | null;
  requestedBy: string | null;
  error?: string | null;
}): Promise<LidarrRequestRow> {
  const [row] = await sql<LidarrRequestRow[]>`
    insert into lidarr_requests (library_id, release_group_id, state, lidarr_album_id, lidarr_artist_id, requested_by, last_error)
    values (${r.libraryId}, ${r.releaseGroupId}, 'wanted', ${r.lidarrAlbumId}, ${r.lidarrArtistId}, ${r.requestedBy}, ${r.error ?? null})
    on conflict (library_id, release_group_id) do update set
      state = 'wanted', progress = null,
      lidarr_album_id = coalesce(excluded.lidarr_album_id, lidarr_requests.lidarr_album_id),
      lidarr_artist_id = coalesce(excluded.lidarr_artist_id, lidarr_requests.lidarr_artist_id),
      requested_by = coalesce(excluded.requested_by, lidarr_requests.requested_by),
      last_error = excluded.last_error, requested_at = now(), updated_at = now(), done_at = null
    returning *`;
  return row!;
}

/** Requests not done yet (the poll's work and the Getting list), oldest first. */
export async function openLidarrRequests(sql: Q, libraryId?: string): Promise<LidarrRequestRow[]> {
  return libraryId
    ? sql<LidarrRequestRow[]>`select * from lidarr_requests where state <> 'done' and library_id = ${libraryId} order by requested_at, id`
    : sql<LidarrRequestRow[]>`select * from lidarr_requests where state <> 'done' order by requested_at, id`;
}
