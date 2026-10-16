/**
 * Rebuild cover thumbnails that are missing from cover_thumbs. Backups leave
 * that table's rows out (0046), so after a restore every album has its
 * images row but no thumbnail; the api serves a placeholder meanwhile and
 * asks for a rebuild. Runs with art.fetch on worker-files, which holds the
 * full-size originals ($CACHE_DIR/covers/<libraryId>/<albumId>.jpg, the
 * image's local_path) on its cache volume.
 *
 * Nothing here deletes an images row. A cover whose original is gone is
 * sent to art.fetch as a refresh, which downloads the art again and updates
 * that same row; until then the cover shows the placeholder. A cache that
 * looks wrong (unmounted, empty, a fresh volume, another computer's) sends
 * nothing: see the proportion check in artThumbSweepJob.
 */
import path from 'node:path';
import { opendir, readFile, stat } from 'node:fs/promises';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { images } from '@tagave/db';
import { defaultCacheDir } from '@tagave/core';
import type { WorkerContext } from '../lib/context.js';
import { storeThumb, toThumb } from '../lib/coverThumbs.js';
import { REFETCH_BUDGET_PER_DAY, releaseRefetch, reserveRefetches } from '../lib/coverRebuildLog.js';
import { artRefreshKey } from './artFetch.js';

export interface ArtThumbJobData {
  imageId: string;
}
export interface ArtThumbSweepJobData {
  /** Only this library's covers (default: every library). */
  libraryId?: string;
  /** Most covers to look at in one run (default 50,000: every album of a big library). */
  limit?: number;
}

export const artThumbKey = (imageId: string) => `thumb:${imageId}`;

/** art.thumb jobs are inserted this many at a time. */
export const SWEEP_INSERT_CHUNK = 1000;
/** A library may have at most this many gone originals for a sweep to refetch any... */
export const SWEEP_MAX_MISSING = 50;
/** ... and at most this share of all its front covers (at least one). */
export const SWEEP_MAX_MISSING_SHARE = 0.02;
/** Refetches are spread out, this many seconds apart, so providers are not asked all at once. */
export const REFETCH_SPACING_SECONDS = 5;
/** Covers with a thumbnail whose originals are checked to tell a broken cache volume from a few lost files. */
export const SAMPLE_SIZE = 50;
/** Below the default 0: thumbnails and new art go first. */
export const REFETCH_PRIORITY = -1;

/** How many gone originals a library of this many front covers may have and still be refetched: 2 %, at least 1, at most 50. */
export function allowedMissing(frontCovers: number): number {
  return Math.min(SWEEP_MAX_MISSING, Math.max(1, Math.floor(frontCovers * SWEEP_MAX_MISSING_SHARE)));
}

/** This worker's cache folder, read on every call (as art.fetch resolves it). */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env['CACHE_DIR'] || defaultCacheDir(env['HOME'] || '/tmp'));
}

export interface CoverRow {
  id: string;
  libraryId: string;
  localAlbumId: string | null;
  localPath: string | null;
  origin?: string;
}

/**
 * Where a cover's original stands on this worker:
 * - found: at the stored local_path;
 * - fixable: not there, but at the standard covers/<libraryId>/<albumId>.jpg
 *   (art.thumb uses it and corrects local_path);
 * - gone: missing (ENOENT) at both, with the stored path under this
 *   worker's cache: a candidate for a refresh;
 * - elsewhere: the stored path is not under this worker's cache (another
 *   computer, an old layout): left to the worker that has it;
 * - error: anything but ENOENT (EACCES, EIO, ...): left as it is.
 */
export type OriginalState =
  | { state: 'found'; path: string }
  | { state: 'fixable'; path: string }
  | { state: 'gone' }
  | { state: 'elsewhere' }
  | { state: 'error'; code: string };

type Probe = (p: string) => Promise<'ok' | 'enoent' | string>;

async function statProbe(p: string): Promise<'ok' | 'enoent' | string> {
  try {
    return (await stat(p)).isFile() ? 'ok' : 'ENOTFILE';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    return code === 'ENOENT' ? 'enoent' : code;
  }
}

/**
 * A probe that lists each folder once (opendir, dotfiles skipped) and
 * answers from that listing: a sweep over 27,000 covers in one folder reads
 * the folder once instead of stat-ing 27,000 paths. A folder it cannot
 * read answers with that error for every file in it.
 */
export function folderProbe(): Probe {
  const listings = new Map<string, Promise<Set<string> | string>>();
  const list = (dir: string) => {
    let hit = listings.get(dir);
    if (!hit) {
      hit = (async () => {
        const names = new Set<string>();
        try {
          const d = await opendir(dir);
          for await (const e of d) {
            if (!e.name.startsWith('.') && e.isFile()) names.add(e.name);
          }
          return names;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
          return code === 'ENOENT' ? names : code;
        }
      })();
      listings.set(dir, hit);
    }
    return hit;
  };
  return async (p: string) => {
    const name = path.basename(p);
    if (name.startsWith('.')) return 'enoent';
    const names = await list(path.dirname(p));
    if (typeof names === 'string') return names;
    return names.has(name) ? 'ok' : 'enoent';
  };
}

function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function locateOriginal(img: CoverRow, root: string = cacheRoot(), probe: Probe = statProbe): Promise<OriginalState> {
  const stored = img.localPath ? path.resolve(img.localPath) : null;
  const local = stored !== null && isUnder(stored, root);
  if (stored && local) {
    const r = await probe(stored);
    if (r === 'ok') return { state: 'found', path: stored };
    if (r !== 'enoent') return { state: 'error', code: r };
  }
  const standard = img.localAlbumId ? path.join(root, 'covers', img.libraryId, `${img.localAlbumId}.jpg`) : null;
  if (standard && standard !== stored) {
    const r = await probe(standard);
    if (r === 'ok') return { state: 'fixable', path: standard };
    if (r !== 'enoent') return { state: 'error', code: r };
  }
  return local ? { state: 'gone' } : { state: 'elsewhere' };
}

export type ArtThumbOutcome = 'rebuilt' | 'present' | 'gone' | 'missing' | 'elsewhere' | 'error' | 'unreadable';

const COVER_COLUMNS = {
  id: images.id,
  libraryId: images.libraryId,
  localAlbumId: images.localAlbumId,
  localPath: images.localPath,
  origin: images.origin,
};

/** Rebuild one thumbnail from its original. A missing original is left to the sweep. */
export async function artThumbJob(ctx: WorkerContext, data: ArtThumbJobData, root: string = cacheRoot()): Promise<ArtThumbOutcome> {
  const rows = await ctx.db
    .select({ ...COVER_COLUMNS, has: dsql<boolean>`exists (select 1 from cover_thumbs ct where ct.image_id = ${images.id})` })
    .from(images)
    .where(eq(images.id, data.imageId))
    .limit(1);
  const img = rows[0];
  if (!img) return 'gone';
  if (img.has) return 'present';

  const where = await locateOriginal(img, root);
  if (where.state !== 'found' && where.state !== 'fixable') {
    ctx.logger.debug({ imageId: img.id, path: img.localPath, state: where.state }, 'art.thumb: no original here; left as it is');
    return where.state === 'gone' ? 'missing' : where.state;
  }
  try {
    const { thumb } = await toThumb(await readFile(where.path));
    await ctx.db.transaction(async (tx) => {
      await storeThumb(tx, img.id, thumb);
      if (where.state === 'fixable') await tx.update(images).set({ localPath: where.path }).where(eq(images.id, img.id));
    });
    return 'rebuilt';
  } catch (err) {
    ctx.logger.warn({ imageId: img.id, path: where.path, err: (err as Error).message }, 'art.thumb: original unreadable; left as it is');
    return 'unreadable';
  }
}

export interface LibrarySweep {
  libraryId: string;
  /** Every front cover of the library (the 2 % is counted on these). */
  frontCovers: number;
  /** Covers without a thumbnail, by where their original stands. */
  found: number;
  gone: number;
  /** Elsewhere, unreadable, or the owner's own cover. */
  skipped: number;
  /** Covers with a thumbnail whose original was checked, and how many of those were missing. */
  sampled: number;
  sampledMissing: number;
  /** Gone originals sent to art.fetch as a refresh. */
  refetched: number;
  /** The cache volume looks broken: nothing was refetched. */
  suspicious: boolean;
  /** Gone covers left for a later sweep (the daily budget, or past allowedMissing). */
  overBudget: number;
}

export interface ThumbSweepResult {
  covers: number;
  /** art.thumb jobs inserted (pg-boss drops ones already queued for the same image). */
  queued: number;
  refetched: number;
  libraries: LibrarySweep[];
}

/**
 * Per library. Pass 1 classifies every cover without a thumbnail; the ones
 * whose original is here get an art.thumb job. Before any gone original is
 * fetched again, the cache volume itself is checked: the originals of up to
 * SAMPLE_SIZE covers that do have a thumbnail (spread across the library)
 * are looked up, and if more than half are missing the volume is not the
 * one these covers were made on (unmounted, an empty new volume, another
 * computer): no refetch, one loud warning naming the sample. A library with
 * no thumbnail to compare with (a fresh restore) falls back to the gone
 * covers themselves: more gone than found, or more than allowedMissing(),
 * blocks. Otherwise pass 2 sends up to allowedMissing() gone covers to
 * art.fetch as a refresh, within the install's daily budget, spread out, at
 * low priority. The owner's own covers are never refetched, and nothing is
 * ever deleted.
 */
export async function artThumbSweepJob(ctx: WorkerContext, data: ArtThumbSweepJobData = {}, root: string = cacheRoot()): Promise<ThumbSweepResult> {
  const limit = data.limit ?? 50_000;
  const covers = await ctx.db
    .select(COVER_COLUMNS)
    .from(images)
    .where(and(
      eq(images.kind, 'front'),
      dsql`${images.localAlbumId} is not null`,
      dsql`not exists (select 1 from cover_thumbs ct where ct.image_id = ${images.id})`,
      data.libraryId ? eq(images.libraryId, data.libraryId) : undefined,
    ))
    .orderBy(images.createdAt)
    .limit(limit);

  const result: ThumbSweepResult = { covers: covers.length, queued: 0, refetched: 0, libraries: [] };
  const byLibrary = new Map<string, CoverRow[]>();
  for (const c of covers) {
    const list = byLibrary.get(c.libraryId) ?? [];
    list.push(c);
    byLibrary.set(c.libraryId, list);
  }

  let batch: Array<{ data: ArtThumbJobData; singletonKey: string }> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await ctx.boss.insert('art.thumb', batch);
    result.queued += batch.length;
    batch = [];
  };

  const probe = folderProbe();
  let spacing = 0;
  for (const [libraryId, rows] of byLibrary) {
    const [count] = await ctx.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(images)
      .where(and(eq(images.libraryId, libraryId), eq(images.kind, 'front'), dsql`${images.localAlbumId} is not null`));
    const lib: LibrarySweep = {
      libraryId, frontCovers: Number(count?.n ?? 0), found: 0, gone: 0, skipped: 0, sampled: 0, sampledMissing: 0,
      refetched: 0, suspicious: false, overBudget: 0,
    };
    result.libraries.push(lib);

    // pass 1: classify
    const gone: CoverRow[] = [];
    for (const img of rows) {
      const where = await locateOriginal(img, root, probe);
      if (where.state === 'found' || where.state === 'fixable') {
        lib.found++;
        batch.push({ data: { imageId: img.id }, singletonKey: artThumbKey(img.id) });
        if (batch.length >= SWEEP_INSERT_CHUNK) await flush();
      } else if (where.state === 'gone' && img.origin !== 'owner') {
        lib.gone++;
        gone.push(img);
      } else {
        lib.skipped++;
      }
    }
    if (gone.length === 0) continue;

    // is the volume broken? check originals of covers that have a thumbnail
    const sample = await ctx.db
      .select(COVER_COLUMNS)
      .from(images)
      .where(and(
        eq(images.libraryId, libraryId),
        eq(images.kind, 'front'),
        dsql`${images.localAlbumId} is not null`,
        dsql`exists (select 1 from cover_thumbs ct where ct.image_id = ${images.id})`,
      ))
      .orderBy(dsql`md5(${images.id}::text)`)
      .limit(SAMPLE_SIZE);
    for (const img of sample) {
      const where = await locateOriginal(img, root, probe);
      if (where.state === 'elsewhere') continue;
      lib.sampled++;
      if (where.state === 'gone' || where.state === 'error') lib.sampledMissing++;
    }
    const allowed = allowedMissing(lib.frontCovers);
    if (lib.sampled > 0) {
      if (lib.sampledMissing * 2 > lib.sampled) {
        lib.suspicious = true;
        ctx.logger.warn({ libraryId, root, sampled: lib.sampled, sampledMissing: lib.sampledMissing, gone: lib.gone },
          `art.thumb sweep: ${lib.sampledMissing} of ${lib.sampled} sampled originals missing in library ${libraryId}; ` +
          `check that the cache volume is mounted at ${root}. Not fetching the ${lib.gone} missing cover(s) again; they show a placeholder meanwhile`);
        continue;
      }
    } else if (lib.gone > lib.found || lib.gone > allowed) {
      lib.suspicious = true;
      ctx.logger.warn({ libraryId, root, found: lib.found, gone: lib.gone, allowed },
        `art.thumb sweep: ${lib.gone} of ${lib.gone + lib.found} originals missing in library ${libraryId}, and no cover with a ` +
        `thumbnail to compare with; check that the cache volume is mounted at ${root}. Not fetching them again; they show a placeholder meanwhile`);
      continue;
    }

    // pass 2: refresh the gone ones, up to allowedMissing and within the daily budget
    const wanted = gone.slice(0, allowed);
    const granted = new Set(await reserveRefetches(ctx.sql, wanted.map((g) => g.localAlbumId!), REFETCH_BUDGET_PER_DAY));
    for (const img of wanted) {
      const albumId = img.localAlbumId!;
      if (!granted.has(albumId)) continue;
      let jobId: string | null = null;
      try {
        jobId = await ctx.boss.send('art.fetch', { localAlbumId: albumId, refresh: true }, {
          singletonKey: artRefreshKey(albumId),
          startAfter: spacing * REFETCH_SPACING_SECONDS,
          priority: REFETCH_PRIORITY,
        });
      } catch (err) {
        ctx.logger.warn({ libraryId, albumId, err: (err as Error).message }, 'art.thumb sweep: could not queue a cover refetch');
      }
      if (!jobId) {
        // already queued, or the queue refused it: the reservation goes back
        await releaseRefetch(ctx.sql, albumId);
        continue;
      }
      spacing++;
      lib.refetched++;
      result.refetched++;
    }
    lib.overBudget = gone.length - lib.refetched;
    if (lib.overBudget > 0) {
      ctx.logger.info({ libraryId, waiting: lib.overBudget, allowed, budget: REFETCH_BUDGET_PER_DAY },
        'art.thumb sweep: more missing covers than one sweep sends; the rest waits for a later sweep');
    }
  }
  await flush();
  if (result.covers > 0) ctx.logger.info({ covers: result.covers, queued: result.queued, refetched: result.refetched }, 'art.thumb sweep');
  return result;
}
