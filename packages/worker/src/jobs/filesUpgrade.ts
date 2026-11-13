import path from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  addAlbumInLidarr, checkLidarrRoot, flacProfileIssue, inScanRoot, LidarrClient, lidarrConnectionOf, lidarrPathOf, observeLidarr,
  type LidarrAlbum, type LidarrArtist, type ScanRootPath,
} from '@tagave/core/lidarr';
import { flacUpgradeSource, lidarrEnabled, lidarrStoredSettings, type FlacUpgradeSource, type MaintenanceWork } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { fileDigest, fileStat, insideRoot } from '../lib/fileRecovery.js';
import { onDisk } from '../lib/deletions.js';
import { runMaintenance, type MaintenanceRun } from '../lib/maintenance.js';
import { continueSwap, restoreUpgrade, stageUpgrade, type UpgradeOriginal, type UpgradeSwap } from './flacUpgradeFiles.js';
import { dropPoolOf } from '../lib/naming.js';

export interface FilesUpgradeJobData {
  albumId: string;
  releaseId: string;
  fileIds: string[];
  userId: string;
  maintenance: MaintenanceWork;
}

type TrackFile = Awaited<ReturnType<LidarrClient['trackFiles']>>[number];
type PoolRoot = ScanRootPath & { dir: string; abs: string };
interface Acquisition {
  source: FlacUpgradeSource;
  originals: UpgradeOriginal[];
  server: string;
  pool: PoolRoot;
  albumId: number;
  artistId: number;
  baseline: string[];
  lastSearch: string | null;
  requestedAt: number;
  commandId: number | null;
  imports?: string[];
}
type Review = { state: 'review'; stage: string; error: string };

function review(error: string): Review {
  return { state: 'review', stage: 'FLAC upgrade needs review', error };
}

function descendant(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function trackVersion(file: TrackFile): string {
  return JSON.stringify([file.id, file.path, file.dateAdded ?? null, file.size ?? null]);
}

async function poolRoot(ctx: WorkerContext, libraryId: string): Promise<PoolRoot> {
  const settings = await dropPoolOf(ctx, libraryId);
  if (!settings.enabled || !settings.scanRootId || !settings.dirPath) throw new Error('Enable a Lidarr drop pool first.');
  const [root] = await ctx.sql<ScanRootPath[]>`
    select id, path, host_path as "hostPath" from scan_roots
    where id = ${settings.scanRootId} and library_id = ${libraryId} and enabled and writable`;
  if (!root) throw new Error('The drop pool’s music folder is unavailable.');
  const abs = path.resolve(root.path, settings.dirPath);
  if (!descendant(root.path, abs) || !(await fileStat(abs))?.isDirectory()) throw new Error('The drop pool is unavailable on the file worker.');
  if (!descendant(await realpath(root.path), await realpath(abs))) throw new Error('The drop pool leaves the music folder.');
  return { ...root, dir: path.relative(root.path, abs), abs };
}

function mappedFile(file: string, pool: PoolRoot, map: Parameters<typeof inScanRoot>[2]): string {
  const mapped = inScanRoot(file, [pool], map);
  const abs = mapped && path.resolve(pool.path, mapped.dirPath);
  if (!abs || !descendant(pool.abs, abs)) throw new Error('Lidarr points outside the Tagave drop pool.');
  return abs;
}

async function requireStagedPath(file: string, pool: PoolRoot): Promise<void> {
  // An artist directory can be missing before its first import.
  let existing = file;
  while (!(await fileStat(existing))) existing = path.dirname(existing);
  if (existing !== pool.abs) await insideRoot(pool.abs, existing);
  const resolved = await realpath(existing);
  const base = await realpath(pool.abs);
  if (resolved !== base && !descendant(base, resolved)) throw new Error('Lidarr’s path leaves the Tagave drop pool.');
}

async function requireStagedArtist(artist: LidarrArtist | null, album: LidarrAlbum | null, source: FlacUpgradeSource, pool: PoolRoot, map: Parameters<typeof inScanRoot>[2]): Promise<LidarrArtist> {
  if (!artist?.path || artist.foreignArtistId !== source.artistMbid || (album && album.artistId !== artist.id)) {
    throw new Error('Lidarr could not confirm the matched album’s artist and folder.');
  }
  await requireStagedPath(mappedFile(artist.path, pool, map), pool);
  return artist;
}

async function acquire(ctx: WorkerContext, data: FilesUpgradeJobData, claim: MaintenanceRun, saved: Acquisition | null) {
  if (!await lidarrEnabled(ctx.sql)) return review('Enable Lidarr to continue the upgrade.');
  const stored = await lidarrStoredSettings(ctx.sql);
  const conn = lidarrConnectionOf(stored, process.env.APP_SECRET ?? '');
  if (!conn || stored.useDropPool === false) return review('Connect Lidarr to the drop pool first.');
  const client = new LidarrClient(conn.server);
  const pool = await poolRoot(ctx, claim.row.library_id);
  const map = conn.pathMap ?? null;
  const target = lidarrPathOf(pool, pool.dir, map);
  if (target !== conn.rootFolderPath.replace(/\/$/, '')) return review('Set Lidarr’s root folder to this library’s drop pool.');
  if (saved && (saved.server !== conn.server.url || saved.pool.abs !== pool.abs || saved.pool.id !== pool.id)) {
    return review('The Lidarr server or drop pool changed. Reconnect the original staging location to continue.');
  }
  const source = await flacUpgradeSource(ctx.sql, claim.row.library_id, data.albumId);
  if (!source || source.releaseId !== data.releaseId || source.files.map((f) => f.id).join() !== data.fileIds.join() ||
      (saved && (source.root !== saved.source.root || source.files.some((file, i) => file.rel !== saved.source.files[i]?.rel)))) {
    return review('The owned album changed after this upgrade was requested.');
  }

  let acquisition = saved;
  let artist = await client.artistByMbid(source.artistMbid);
  let album = await client.albumByMbid(source.groupMbid);
  if (!acquisition) {
    const root = await checkLidarrRoot(client, target, { ...conn, create: false });
    if (root.reach !== 'writable') return review('Lidarr cannot write to the Tagave drop pool.');
    if (album || artist) artist = await requireStagedArtist(artist, album, source, pool, map);
    const profileIssue = await flacProfileIssue(client, artist?.qualityProfileId ?? conn.qualityProfileId);
    if (profileIssue) return review(profileIssue);
    const originals: UpgradeOriginal[] = [];
    for (const file of source.files) {
      const actual = await onDisk(source.root, file.rel);
      if (!actual) return review('An original album file is unavailable.');
      await insideRoot(source.root, actual);
      originals.push({ path: actual, hash: await fileDigest(actual) });
    }
    await claim.current();
    album ??= await addAlbumInLidarr(client, conn, {
      releaseGroupMbid: source.groupMbid, artistMbid: source.artistMbid, artistName: source.artistName,
    }, artist);
    if (!artist) artist = await client.artistByMbid(source.artistMbid);
    const stagedArtist = await requireStagedArtist(artist, album, source, pool, map);
    const baseline = await client.trackFiles(album.id);
    for (const file of baseline) await requireStagedPath(mappedFile(file.path, pool, map), pool);

    const active = (await client.queue(500)).records.some((item) => item.albumId === album!.id);
    acquisition = {
      source, originals, pool, server: conn.server.url, albumId: album.id, artistId: stagedArtist.id,
      baseline: baseline.map(trackVersion), lastSearch: album.lastSearchTime ?? null,
      requestedAt: Date.now(), commandId: null,
    };
    // Commit before calling Lidarr. A crash or timeout can leave delivery uncertain.
    // A subsequent attempt observes this album and never sends that command again.
    await claim.update({ stage: 'Requesting FLAC from Lidarr', checkpoint: { ...acquisition } });
    if (!active) {
      await claim.current();
      if (!album.monitored) await client.setMonitored([album.id], true);
      const command = await client.requestAlbumSearch([album.id]);
      acquisition.commandId = command.id;
      await claim.update({ stage: 'Waiting for Lidarr', checkpoint: { ...acquisition } });
    }
  }
  if (!album || album.id !== acquisition.albumId || artist?.id !== acquisition.artistId) {
    return review('The original Lidarr album or artist is unavailable.');
  }
  await requireStagedArtist(artist, album, source, pool, map);
  const queued = (await client.queue(500)).records.filter((item) => item.albumId === album.id);
  const trackFiles = await client.trackFiles(album.id);
  const imports: string[] = [];
  for (const file of trackFiles) {
    const staged = mappedFile(file.path, pool, map);
    await requireStagedPath(staged, pool);
    if (!acquisition.baseline.includes(trackVersion(file))) imports.push(staged);
  }
  const observation = observeLidarr(null, queued, new Date(acquisition.requestedAt));
  if (observation.error) return review('Lidarr reported a failed import. Check the download in Lidarr.');
  if (queued.length) {
    return {
      stage: observation.progress === 100 ? 'Importing in Lidarr' : 'Downloading through Lidarr',
      progress: observation.progress === null ? null : { done: observation.progress, total: 100 },
      error: null, pollAfterMs: 20_000,
    };
  }
  if (imports.length === source.files.length && imports.length === trackFiles.length) {
    return { ...acquisition, imports };
  }
  if (imports.length && Date.now() - acquisition.requestedAt > 2 * 60_000) {
    return review('Lidarr imported an incomplete edition. Check the files in the drop pool.');
  }
  if (observation.state === 'not_found') {
    return review('Lidarr has no complete new download for this album. Check the search in Lidarr.');
  }
  const acknowledged = acquisition.commandId !== null || (album.lastSearchTime ?? null) !== acquisition.lastSearch;
  return { stage: acknowledged ? 'Waiting for Lidarr to find a FLAC download' : 'Checking the original Lidarr request',
    progress: null, error: null, pollAfterMs: 30_000 };
}

export async function filesUpgradeJob(ctx: WorkerContext, data: FilesUpgradeJobData): Promise<void> {
  await runMaintenance(ctx, data.maintenance, async (claim) => {
    const saved = claim.row.checkpoint as Acquisition | { swap: UpgradeSwap; restoreOriginal?: boolean } | null;
    if (saved && 'swap' in saved) {
      if (saved.restoreOriginal) return restoreUpgrade(ctx, claim, saved.swap);
      return continueSwap(ctx, claim, saved.swap, data.releaseId, data.userId);
    }
    const acquisition = await acquire(ctx, data, claim, saved);
    if (!('imports' in acquisition) || !acquisition.imports) return acquisition;
    await claim.update({ stage: 'Checking the FLAC edition', checkpoint: { ...acquisition } });
    let swap: UpgradeSwap;
    try {
      swap = await stageUpgrade(ctx, claim, acquisition.source, acquisition.originals, acquisition.imports);
    } catch (err) {
      return review((err as Error).message);
    }
    await claim.update({ stage: 'FLAC edition verified and tagged', checkpoint: { swap } });
    return continueSwap(ctx, claim, swap, data.releaseId, data.userId);
  });
}
