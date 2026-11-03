/**
 * Get missing albums through Lidarr (the lidarr module; vault "tagave - Get
 * Missing Albums", part B): the connection as the owner saved it, what Get
 * asks of Lidarr, how a request's state follows from what Lidarr reports,
 * and where an imported album sits among tagave's music folders.
 */
import path from 'node:path';
import { openSecret } from '../crypto/secretbox.js';
import { LIDARR_ERRORS, LidarrClient, LidarrError, type LidarrAlbum, type LidarrQueueItem, type LidarrServer } from './client.js';

export * from './client.js';

/** The module's own settings (installed_modules.settings for 'lidarr'). */
export interface LidarrSettings {
  url?: unknown;
  /** sealed (enc:v1:…) */
  apiKey?: unknown;
  rootFolderPath?: unknown;
  qualityProfileId?: unknown;
  metadataProfileId?: unknown;
  version?: unknown;
}


/** A saved connection, ready to call: the address, the key opened, and where new albums go. */
export interface LidarrConnection {
  server: LidarrServer;
  rootFolderPath: string;
  qualityProfileId: number;
  metadataProfileId: number;
}

/** The saved connection, or null when none is saved (or it is incomplete). Throws when the key does not open. */
export function lidarrConnectionOf(settings: LidarrSettings | null | undefined, appSecret: string): LidarrConnection | null {
  if (!settings) return null;
  const { url, apiKey, rootFolderPath, qualityProfileId, metadataProfileId } = settings;
  if (typeof url !== 'string' || typeof apiKey !== 'string' || !url || !apiKey) return null;
  if (typeof rootFolderPath !== 'string' || !rootFolderPath) return null;
  if (!Number.isInteger(qualityProfileId) || !Number.isInteger(metadataProfileId)) return null;
  return {
    server: { url, apiKey: openSecret(apiKey, appSecret) },
    rootFolderPath,
    qualityProfileId: qualityProfileId as number,
    metadataProfileId: metadataProfileId as number,
  };
}

/** What Get asks for: the album's and its first artist's MusicBrainz ids. */
export interface LidarrWant {
  releaseGroupMbid: string;
  artistMbid: string;
  artistName: string;
}

/** What Lidarr made of a Get: its album id, and whether it searched already. */
export interface LidarrGetResult {
  albumId: number;
  artistId: number | null;
  /** the album was in Lidarr already */
  existed: boolean;
}

/**
 * Get one album: at most four calls.
 *
 *   in Lidarr already   monitor it (only it), then AlbumSearch
 *   not yet             POST /album with its artist: an artist Lidarr has
 *                       keeps its settings; a new one is added monitored
 *                       for this album alone (addOptions.monitor 'none',
 *                       albumsToMonitor, no search for the rest, new
 *                       releases not monitored), then AlbumSearch
 *
 * The rest of the discography is never monitored by tagave.
 */
export async function getAlbumInLidarr(client: LidarrClient, conn: LidarrConnection, want: LidarrWant): Promise<LidarrGetResult> {
  const found = await client.albumByMbid(want.releaseGroupMbid);
  if (found) {
    if (!found.monitored) await client.setMonitored([found.id], true);
    await client.searchAlbums([found.id]);
    return { albumId: found.id, artistId: found.artistId ?? null, existed: true };
  }
  const known = await client.artistByMbid(want.artistMbid);
  const artist = {
    foreignArtistId: want.artistMbid,
    artistName: known?.artistName ?? want.artistName,
    qualityProfileId: known?.qualityProfileId ?? conn.qualityProfileId,
    metadataProfileId: known?.metadataProfileId ?? conn.metadataProfileId,
    rootFolderPath: conn.rootFolderPath,
    monitored: true,
    monitorNewItems: 'none',
    addOptions: { monitor: 'none', albumsToMonitor: [want.releaseGroupMbid], monitored: true, searchForMissingAlbums: false },
  };
  const added = await client.addAlbum({
    foreignAlbumId: want.releaseGroupMbid,
    monitored: true,
    anyReleaseOk: true,
    artist,
    // the search is asked for below, once, whatever Lidarr does on add
    addOptions: { addType: 'manual', searchForNewAlbum: false },
  });
  if (!added.monitored) await client.setMonitored([added.id], true);
  await client.searchAlbums([added.id]);
  return { albumId: added.id, artistId: added.artistId ?? known?.id ?? null, existed: false };
}

/** A request's state, one word each on the card. */
export const LIDARR_STATES = ['wanted', 'downloading', 'imported', 'done', 'not_found'] as const;
export type LidarrState = (typeof LIDARR_STATES)[number];

/** A search that finds nothing for this long: Not found (Retry searches again and starts the wait over). */
export const LIDARR_NOT_FOUND_AFTER_MS = 3 * 86_400_000;

export interface LidarrObservation {
  state: Exclude<LidarrState, 'done'>;
  /** 0–100 while downloading; null otherwise or when Lidarr gives no size */
  progress: number | null;
  error: string | null;
}

/** What Lidarr's album statistics and queue say about one request. */
export function observeLidarr(album: LidarrAlbum | null, queued: readonly LidarrQueueItem[], requestedAt: Date, now = Date.now()): LidarrObservation {
  const files = album?.statistics?.trackFileCount ?? 0;
  if (queued.length > 0) {
    let size = 0;
    let left = 0;
    for (const q of queued) {
      size += q.size ?? 0;
      left += q.sizeleft ?? 0;
    }
    const progress = size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 100))) : null;
    const failed = queued.find((q) => q.trackedDownloadState === 'importFailed' || q.trackedDownloadState === 'failed' || q.status === 'failed');
    // Lidarr's own words stay in Lidarr: the card says only that the import failed
    return { state: 'downloading', progress, error: failed ? 'Import failed' : null };
  }
  if (files > 0) return { state: 'imported', progress: null, error: null };
  if (now - requestedAt.getTime() > LIDARR_NOT_FOUND_AFTER_MS) return { state: 'not_found', progress: null, error: null };
  return { state: 'wanted', progress: null, error: null };
}

/** A music folder as tagave knows it: its own path and, when known, where it is on the computer that holds the music. */
export interface ScanRootPath {
  id: string;
  path: string;
  hostPath?: string | null;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * The music folder a path Lidarr wrote is in, and the folder relative to it
 * (NFC, as scan.dir wants it). Lidarr and tagave each see their own mount, so
 * the path is tried against each root's path and its host path. Null: in none.
 */
export function inScanRoot(lidarrPath: string, roots: readonly ScanRootPath[]): { scanRootId: string; dirPath: string } | null {
  const p = trimSlash(path.posix.normalize(lidarrPath.replace(/\\/g, '/')).normalize('NFC'));
  let best: { scanRootId: string; dirPath: string; len: number } | null = null;
  for (const r of roots) {
    for (const base of [r.path, r.hostPath]) {
      if (!base) continue;
      const b = trimSlash(path.posix.normalize(base.replace(/\\/g, '/')).normalize('NFC'));
      if (p === b || p.startsWith(`${b}/`)) {
        const rel = p === b ? '' : p.slice(b.length + 1);
        if (!best || b.length > best.len) best = { scanRootId: r.id, dirPath: rel, len: b.length };
      }
    }
  }
  return best ? { scanRootId: best.scanRootId, dirPath: best.dirPath } : null;
}

/** The folder that holds an album's files: the deepest folder they share. */
export function albumFolderOf(filePaths: readonly string[]): string | null {
  const dirs = filePaths.map((f) => path.posix.dirname(f.replace(/\\/g, '/')));
  if (dirs.length === 0) return null;
  let common = dirs[0]!.split('/');
  for (const d of dirs.slice(1)) {
    const parts = d.split('/');
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  const out = common.join('/');
  return out || '/';
}

/** A Lidarr failure as the card and the Getting list show it: one short line, never the key. */
export function lidarrErrorText(err: unknown): string {
  if (err instanceof LidarrError) return err.message;
  return LIDARR_ERRORS.unreachable;
}

