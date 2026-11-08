/**
 * Get missing albums through Lidarr (the lidarr module; vault "tagave - Get
 * Missing Albums", part B): the connection as the owner saved it, what Get
 * asks of Lidarr, how a request's state follows from what Lidarr reports,
 * and where an imported album sits among tagave's music folders.
 */
import path from 'node:path';
import { openSecret } from '../crypto/secretbox.js';
import { LIDARR_ERRORS, LidarrClient, LidarrError, type LidarrAlbum, type LidarrArtist, type LidarrQueueItem, type LidarrRootFolder, type LidarrServer } from './client.js';

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
  /** "Lidarr sees the music folder as": { lidarrPath, scanRootId } */
  pathMap?: unknown;
  /** the drop pool as Lidarr's root folder; absent: on while the pool is on */
  useDropPool?: unknown;
}

/**
 * The arr path mapping: the path in Lidarr's container that is tagave's
 * music folder (scan root). With it, /data/music/A/B in Lidarr is A/B in
 * that music folder, and the pool's folder is /data/music/_Inbox to Lidarr.
 */
export interface LidarrPathMap {
  lidarrPath: string;
  scanRootId: string;
}

/** A saved mapping, when it is one: an absolute path and a music folder's id. */
export function pathMapOf(v: unknown): LidarrPathMap | null {
  if (!v || typeof v !== 'object') return null;
  const { lidarrPath, scanRootId } = v as Record<string, unknown>;
  if (typeof lidarrPath !== 'string' || !lidarrPath.startsWith('/') || typeof scanRootId !== 'string' || !scanRootId) return null;
  return { lidarrPath: trimSlash(path.posix.normalize(lidarrPath)), scanRootId };
}


/** A saved connection, ready to call: the address, the key opened, and where new albums go. */
export interface LidarrConnection {
  server: LidarrServer;
  rootFolderPath: string;
  qualityProfileId: number;
  metadataProfileId: number;
  pathMap?: LidarrPathMap | null;
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
    pathMap: pathMapOf(settings.pathMap),
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
  const added = await addAlbumInLidarr(client, conn, want, known);
  if (!added.monitored) await client.setMonitored([added.id], true);
  await client.searchAlbums([added.id]);
  return { albumId: added.id, artistId: added.artistId ?? known?.id ?? null, existed: false };
}

/** Add to Lidarr without scheduling a search, so callers can verify the resulting location. */
export function addAlbumInLidarr(client: LidarrClient, conn: LidarrConnection, want: LidarrWant, known: LidarrArtist | null): Promise<LidarrAlbum> {
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
  return client.addAlbum({
    foreignAlbumId: want.releaseGroupMbid,
    monitored: true,
    anyReleaseOk: true,
    artist,
    // the search is asked for below, once, whatever Lidarr does on add
    addOptions: { addType: 'manual', searchForNewAlbum: false },
  });
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

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}
const clean = (p: string) => trimSlash(path.posix.normalize(p.replace(/\\/g, '/')).normalize('NFC'));

/**
 * The music folder a path Lidarr wrote is in, and the folder relative to it
 * (NFC, as scan.dir wants it). Lidarr and tagave each see their own mount, so
 * the path is tried against the mapping first (Lidarr sees the music folder
 * as …), then each root's path and its host path. Null: in none.
 */
export function inScanRoot(lidarrPath: string, roots: readonly ScanRootPath[], map: LidarrPathMap | null = null): { scanRootId: string; dirPath: string } | null {
  const p = clean(lidarrPath);
  if (map && roots.some((r) => r.id === map.scanRootId)) {
    const b = clean(map.lidarrPath);
    if (p === b) return { scanRootId: map.scanRootId, dirPath: '' };
    if (p.startsWith(b === '/' ? '/' : `${b}/`)) return { scanRootId: map.scanRootId, dirPath: p.slice(b === '/' ? 1 : b.length + 1) };
  }
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

/**
 * A folder of a music folder as Lidarr sees it: under the mapping when it is
 * for this music folder, else under the root's host path (the computer that
 * holds the music), else under its own path (Lidarr and tagave share paths).
 */
export function lidarrPathOf(root: ScanRootPath, rel: string, map: LidarrPathMap | null = null): string {
  const base = map && map.scanRootId === root.id ? map.lidarrPath : root.hostPath ?? root.path;
  return clean(rel ? path.posix.join(base, rel) : base);
}

/** Can Lidarr use its root folder: write in it, not see it, or see it without writing. */
export const LIDARR_REACH = ['writable', 'unseen', 'readonly'] as const;
export type LidarrReach = (typeof LIDARR_REACH)[number];

export interface LidarrRootReach {
  reach: LidarrReach;
  /** the root folder as Lidarr sees it */
  path: string;
  /** tagave added it to Lidarr just now */
  created: boolean;
}

/** Is a folder there for Lidarr: listed in its parent by Lidarr's own file browser. */
async function lidarrSees(client: LidarrClient, folder: string): Promise<boolean> {
  const p = clean(folder);
  if (p === '/') return true;
  const parent = path.posix.dirname(p);
  const kids = await client.folderListing(parent);
  return kids.some((k) => clean(k.path) === p || (k.name !== null && k.name === path.posix.basename(p)));
}

/**
 * Make `folder` one of Lidarr's root folders when `create` and it is not one
 * yet, then say what Lidarr can do there, from what its API reports:
 *
 *   a root folder Lidarr reports accessible, with free space    writable
 *   one it reports inaccessible                                 unseen
 *   not a root folder, and Lidarr refused to add it: its file
 *   browser lists the folder (there, not writable) or not       readonly / unseen
 *
 * Lidarr adds a root folder only when it can write there, so an accessible
 * one was writable; one without free space reads as read-only.
 */
export async function checkLidarrRoot(
  client: LidarrClient,
  folder: string,
  opts: { create: boolean; qualityProfileId: number; metadataProfileId: number; name?: string },
): Promise<LidarrRootReach> {
  const p = clean(folder);
  const find = (list: LidarrRootFolder[]) => list.find((f) => clean(f.path) === p) ?? null;
  let root = find(await client.rootFolders());
  let created = false;
  if (!root && opts.create) {
    try {
      root = await client.addRootFolder({ name: opts.name ?? 'tagave drop pool', path: p, defaultQualityProfileId: opts.qualityProfileId, defaultMetadataProfileId: opts.metadataProfileId });
      created = true;
    } catch (err) {
      if (!(err instanceof LidarrError) || err.code !== 'refused') throw err;
    }
  }
  if (root) {
    if (root.accessible === false) return { reach: 'unseen', path: p, created };
    if (root.freeSpace === 0) return { reach: 'readonly', path: p, created };
    return { reach: 'writable', path: p, created };
  }
  return { reach: (await lidarrSees(client, p)) ? 'readonly' : 'unseen', path: p, created };
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

