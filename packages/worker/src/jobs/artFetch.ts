import path from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import { and, eq, inArray, isNotNull, isNull, sql as dsql } from 'drizzle-orm';
import {
  files, images, imageSources, localAlbums, localTracks, releases, scanRoots, sidecarFiles,
} from '@tagave/db';
import { storeThumb, toThumb } from '../lib/coverThumbs.js';
import { defaultCacheDir } from '@tagave/core';
import type { WorkerContext } from '../lib/context.js';
import { relDirname } from '../lib/helpers.js';
import { cached, cacheKey, TTLs, stripDiscogs } from '../lib/providerCache.js';
import { libraryProviderSettings, getProviders, discogsCall } from '../lib/providers.js';

export interface ArtFetchJobData {
  localAlbumId: string;
  /**
   * The album has its images row but the original is gone from the cache
   * (art.thumbSweep): fetch the art again into the standard path and update
   * that same row (its id, and so every link to it, stays) and its
   * thumbnail. Never deletes.
   */
  refresh?: boolean;
}

/** singletonKey of a refresh, apart from art:<id> (the album page watches that one). */
export const artRefreshKey = (albumId: string) => `artRefresh:${albumId}`;
export interface ArtSweepJobData {
  /** Only this library; every library when left out. */
  libraryId?: string;
  limit?: number;
}

// absolute, so the local_path stored with each image is too
const CACHE_ROOT = path.resolve(process.env.CACHE_DIR || defaultCacheDir(process.env.HOME || '/tmp'));

/** Cover Art Archive: no rate limit documented; keep modest concurrency via
 * job settings and be a good citizen with a real UA. */
const CAA_UA = 'tagave/0.1 (+tagave-worker)';
const DISCOGS_IMAGE_LICENSE = 'Discogs user-posted image (Restricted Data): cached for display in this library only; not redistributed';

/** images.origin='provider' requires an image_sources row (CHECK constraint). */
async function upsertImageSource(ctx: WorkerContext, releaseId: string, provider: string, url: string, license: string): Promise<string> {
  const rows = await ctx.db.insert(imageSources)
    .values({ entityType: 'release', entityId: releaseId, kind: 'front', provider, sourceUrl: url, licenseNote: license, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [imageSources.entityType, imageSources.entityId, imageSources.provider, imageSources.kind],
      set: { sourceUrl: url, fetchedAt: new Date() },
    })
    .returning({ id: imageSources.id });
  return rows[0]!.id;
}

async function openVariant(p: string): Promise<string | null> {
  for (const cand of [p, p.normalize('NFD'), p.normalize('NFC')]) {
    try {
      await access(cand);
      return cand;
    } catch { /* next */ }
  }
  return null;
}

/**
 * ENR-2 resolution order: embedded artwork -> sidecar image in the album
 * folder -> Cover Art Archive (matched albums only). First hit wins.
 */
export async function artFetchJob(ctx: WorkerContext, data: ArtFetchJobData): Promise<void> {
  const albumRows = await ctx.db
    .select()
    .from(localAlbums)
    .where(eq(localAlbums.id, data.localAlbumId))
    .limit(1);
  const album = albumRows[0];
  if (!album) return;

  const existing = await ctx.db
    .select({ id: images.id, origin: images.origin, imageSourceId: images.imageSourceId, licenseNote: images.licenseNote })
    .from(images)
    .where(and(eq(images.localAlbumId, album.id), eq(images.kind, 'front')))
    .limit(1);
  if (data.refresh && existing[0]?.origin === 'owner') {
    // the owner's own cover: never replaced by one found elsewhere
    ctx.logger.debug({ album: album.titleGuess }, 'art.fetch refresh: the owner\'s cover is left as it is');
    return;
  }
  const refreshId = data.refresh ? existing[0]?.id : undefined;
  if (existing.length > 0 && !refreshId) {
    // the art is already here: a noCover flag left from before it landed is stale
    await settleCoverGap(ctx, album.libraryId, album.id);
    return;
  }

  const tracks = await ctx.db
    .select({ audioFileId: localTracks.audioFileId })
    .from(localTracks)
    .where(eq(localTracks.localAlbumId, album.id));
  if (tracks.length === 0) return;
  const fileRows = await ctx.db
    .select({
      id: files.id,
      relPath: files.relPath,
      scanRootId: files.scanRootId,
      hasArt: files.hasEmbeddedArt,
    })
    .from(files)
    .where(inArray(files.id, tracks.map((t) => t.audioFileId)));
  const rootIds = [...new Set(fileRows.map((f) => f.scanRootId))];
  const roots = await ctx.db
    .select({ id: scanRoots.id, path: scanRoots.path })
    .from(scanRoots)
    .where(inArray(scanRoots.id, rootIds));
  const rootPath = new Map(roots.map((r) => [r.id, r.path]));

  let source: Buffer | null = null;
  let origin = '';
  let license = '';
  let audioFileId: string | null = null;
  let sidecarFileId: string | null = null;
  let imageSourceId: string | null = null;

  // 0. a refresh of a provider cover: the same image again, from where it came
  const prior = refreshId ? existing[0] : undefined;
  if (prior?.origin === 'provider' && prior.imageSourceId) {
    try {
      const [src] = await ctx.db
        .select({ url: imageSources.sourceUrl })
        .from(imageSources)
        .where(eq(imageSources.id, prior.imageSourceId))
        .limit(1);
      if (src?.url) {
        const resp = await fetch(src.url, { headers: { 'User-Agent': CAA_UA }, redirect: 'follow' });
        if (resp.ok) {
          source = Buffer.from(await resp.arrayBuffer());
          origin = 'provider';
          license = prior.licenseNote;
          imageSourceId = prior.imageSourceId;
        }
      }
    } catch (err) {
      ctx.logger.debug({ album: album.titleGuess, err: (err as Error).message }, 'art.fetch refresh: the stored source failed; trying the usual order');
    }
  }

  // 1. embedded artwork (largest picture of the first art-bearing file)
  const withArt = fileRows.find((f) => f.hasArt);
  if (!source && withArt) {
    const abs = await openVariant(path.join(rootPath.get(withArt.scanRootId) ?? '', withArt.relPath));
    if (abs) {
      try {
        const meta = await parseFile(abs, { skipPostHeaders: false });
        const pics = meta.common.picture ?? [];
        const best = pics.sort((a, b) => (b.data?.length ?? 0) - (a.data?.length ?? 0))[0];
        if (best?.data?.length) {
          source = Buffer.from(best.data);
          origin = 'embedded';
          license = 'embedded in owned file';
          audioFileId = withArt.id;
        }
      } catch { /* fall through */ }
    }
  }

  // 2. sidecar image in any of the album's directories
  if (!source) {
    const anyFile = fileRows[0];
    if (anyFile) {
      const dirs = [...new Set(fileRows.map((f) => relDirname(f.relPath)))];
      const sidecars = await ctx.db
        .select()
        .from(sidecarFiles)
        .where(and(eq(sidecarFiles.scanRootId, anyFile.scanRootId), eq(sidecarFiles.kind, 'image')));
      const preferred = ['cover', 'front', 'folder', 'album'];
      const inDirs = sidecars
        .filter((s) => dirs.includes(relDirname(s.relPath)))
        .sort((a, b) => {
          const an = path.basename(a.relPath).toLowerCase();
          const bn = path.basename(b.relPath).toLowerCase();
          const ap = preferred.findIndex((p2) => an.startsWith(p2));
          const bp = preferred.findIndex((p2) => bn.startsWith(p2));
          return (ap < 0 ? 99 : ap) - (bp < 0 ? 99 : bp) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
        });
      const pick = inDirs[0];
      if (pick) {
        const abs = await openVariant(path.join(rootPath.get(pick.scanRootId) ?? '', pick.relPath));
        if (abs) {
          try {
            const { readFile } = await import('node:fs/promises');
            source = await readFile(abs);
            origin = 'sidecar';
            license = 'sidecar file in owned folder';
            sidecarFileId = pick.id;
          } catch { /* fall through */ }
        }
      }
    }
  }

  // 3. Cover Art Archive by release (matched albums only)
  if (!source && album.releaseId) {
    const rel = await ctx.db
      .select({ mbid: releases.mbid })
      .from(releases)
      .where(eq(releases.id, album.releaseId))
      .limit(1);
    const mbid = rel[0]?.mbid;
    if (mbid) {
      try {
        const resp = await fetch(`https://coverartarchive.org/release/${mbid}/front-500`, {
          headers: { 'User-Agent': CAA_UA },
          redirect: 'follow',
        });
        if (resp.ok) {
          source = Buffer.from(await resp.arrayBuffer());
          origin = 'provider';
          license = 'Cover Art Archive — display only, do not redistribute';
          imageSourceId = await upsertImageSource(ctx, album.releaseId, 'caa',
            `https://coverartarchive.org/release/${mbid}/front-500`, license);
        }
      } catch { /* leave flagged */ }
    }
  }

  // 4. Discogs primary image (ENR-2 step 4). image_sources rows exist only
  // when the release was fetched with a token (Discogs omits image URLs
  // otherwise); signed CDN URLs expire, so a 403/404 refreshes the release
  // once through the shared pacer.
  if (!source && album.releaseId) {
    try {
      const rows = await ctx.db
        .select({ id: imageSources.id, sourceUrl: imageSources.sourceUrl })
        .from(imageSources)
        .where(and(
          eq(imageSources.entityType, 'release'),
          eq(imageSources.entityId, album.releaseId),
          eq(imageSources.provider, 'discogs'),
          eq(imageSources.kind, 'front'),
        ))
        .limit(1);
      const row = rows[0];
      if (row?.sourceUrl) {
        let url: string | null = row.sourceUrl;
        for (let attempt = 1; attempt <= 2 && url && !source; attempt++) {
          const resp = await fetch(url, { headers: { 'User-Agent': CAA_UA } });
          if (resp.ok) {
            source = Buffer.from(await resp.arrayBuffer());
            origin = 'provider';
            license = DISCOGS_IMAGE_LICENSE;
            imageSourceId = row.id;
            break;
          }
          url = null;
          if (attempt === 1 && [403, 404, 410].includes(resp.status)) {
            const settings = await libraryProviderSettings(ctx, album.libraryId);
            if (!settings.contactString || !settings.discogsToken) break;
            const p = getProviders(settings);
            const relRow = await ctx.db
              .select({ discogsReleaseId: releases.discogsReleaseId })
              .from(releases).where(eq(releases.id, album.releaseId)).limit(1);
            const discogsId = relRow[0]?.discogsReleaseId;
            if (!discogsId) break;
            const fresh = await cached(ctx.sql, 'discogs', cacheKey('release', discogsId), TTLs.discogsEntity,
              () => discogsCall(ctx, p, () => p.discogs.getRelease(String(discogsId), { priority: 'background' })),
              { strip: stripDiscogs, bypass: true });
            const primary = fresh.images?.find((i) => i.primary) ?? fresh.images?.[0];
            if (primary) {
              url = primary.url;
              await ctx.db.update(imageSources)
                .set({ sourceUrl: primary.url, fetchedAt: new Date() })
                .where(eq(imageSources.id, row.id));
            }
          }
        }
      }
    } catch (err) {
      ctx.logger.debug({ album: album.titleGuess, err: (err as Error).message }, 'discogs image fetch failed');
    }
  }

  if (!source) {
    ctx.logger.debug({ album: album.titleGuess }, 'no cover art found (quality flag material)');
    return;
  }

  let thumb: Buffer, width: number, height: number;
  try {
    ({ thumb, width, height } = await toThumb(source));
  } catch (err) {
    ctx.logger.warn({ album: album.titleGuess, err: (err as Error).message }, 'artwork unreadable');
    return;
  }

  const dir = path.join(CACHE_ROOT, 'covers', album.libraryId);
  await mkdir(dir, { recursive: true });
  const localPath = path.join(dir, `${album.id}.jpg`);
  await writeFile(localPath, source);

  // The image row and its thumbnail land together (thumbnails live in
  // cover_thumbs since 0046; images.thumb_bytes is no longer written).
  if (refreshId) {
    // the same row, updated in place: its id and the album's link to it stay
    await ctx.db.transaction(async (tx) => {
      await tx.update(images).set({
        origin, audioFileId, sidecarFileId, imageSourceId, localPath, width, height, licenseNote: license, fetchedAt: new Date(),
      }).where(eq(images.id, refreshId));
      await storeThumb(tx, refreshId, thumb);
    });
    await settleCoverGap(ctx, album.libraryId, album.id);
    return;
  }
  await ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(images)
      .values({
        libraryId: album.libraryId,
        entityType: 'local_album',
        entityId: album.id,
        localAlbumId: album.id,
        kind: 'front',
        origin,
        audioFileId,
        sidecarFileId,
        imageSourceId,
        localPath,
        width,
        height,
        licenseNote: license,
        fetchedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: images.id });
    // a concurrent run stored this album's art first: keep that one
    if (inserted[0]) await storeThumb(tx, inserted[0].id, thumb);
  });

  await settleCoverGap(ctx, album.libraryId, album.id);
}

/**
 * The album has a front image now, so its "No cover art" flag no longer
 * holds. gaps.recompute would clear it, but that runs after a scan and every
 * night; until then the album page said "No cover art · Fetch art" under the
 * cover it was showing. Resolve the flag at once (as the recompute's sweep
 * would: a hidden flag or a task included, the task keeping accepted_at so
 * it reads as done), then re-lint just this album. (noEmbeddedArt reads the
 * files, not this cover, so a cover found online leaves it as it is.)
 */
export async function settleCoverGap(ctx: WorkerContext, libraryId: string, albumId: string): Promise<void> {
  await ctx.sql`
    update gaps set state = 'resolved', resolved_at = coalesce(resolved_at, now())
    where library_id = ${libraryId} and kind = 'quality' and flag = 'noCover'
      and subject_id = ${albumId} and state != 'resolved'`;
  try {
    await ctx.boss.send('gaps.recompute', { libraryId, albumIds: [albumId] }, {});
  } catch (error) {
    ctx.logger.warn({ libraryId, albumId, error: String(error) }, 'art.fetch: could not queue re-lint');
  }
}

/**
 * Enqueue art.fetch for albums without a front image yet, each once: an album
 * looked up since it last changed (a match, a rescan) is left until it
 * changes again. This is what reads a newly scanned album's embedded art or
 * folder image; it runs every few minutes, so a first scan shows its local
 * covers without anyone pressing Fetch art. pg-boss drops a finished job
 * after its retention, so an album with no art anywhere is tried again then.
 * Without a library: every library.
 */
export async function artSweepJob(ctx: WorkerContext, data: ArtSweepJobData): Promise<void> {
  const limit = data.limit ?? 2000;
  const libraryId = data.libraryId ?? null;
  const rows = await ctx.db.execute(dsql`
    select la.id from local_albums la
    where (${libraryId}::uuid is null or la.library_id = ${libraryId}::uuid)
      and la.state != 'ignored'
      and not exists (select 1 from images i where i.local_album_id = la.id and i.kind = 'front')
      and not exists (
        select 1 from pgboss.job j
        where j.name = 'art.fetch' and j.singleton_key = 'art:' || la.id::text
          and j.created_on >= la.updated_at)
    order by la.state = 'matched' desc, la.created_at
    limit ${limit}`) as unknown as { id: string }[];
  for (const r of rows) {
    await ctx.boss.send('art.fetch', { localAlbumId: r.id }, { singletonKey: `art:${r.id}` });
  }
  if (rows.length > 0) ctx.logger.info({ libraryId, enqueued: rows.length }, 'art sweep');
}
