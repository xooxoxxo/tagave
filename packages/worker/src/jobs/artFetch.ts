import path from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import { and, eq, inArray, isNotNull, isNull, sql as dsql } from 'drizzle-orm';
import {
  audioFiles, images, imageSources, localAlbums, localTracks, releases, scanRoots, sidecarFiles,
} from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { relDirname } from '../lib/helpers.js';
import { cached, cacheKey, TTLs, stripDiscogs } from '../lib/providerCache.js';
import { libraryProviderSettings, getProviders, discogsCall } from '../lib/providers.js';

export interface ArtFetchJobData {
  localAlbumId: string;
}
export interface ArtSweepJobData {
  libraryId: string;
  limit?: number;
}

const CACHE_ROOT = process.env.CACHE_DIR || path.join(process.env.HOME || '/tmp', 'liner-cache');
const THUMB_SIZE = 300;

/** Cover Art Archive: no rate limit documented; keep modest concurrency via
 * job settings and be a good citizen with a real UA. */
const CAA_UA = 'Liner/0.1 (+liner-worker)';
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

async function toThumb(buf: Buffer): Promise<{ thumb: Buffer; width: number; height: number }> {
  const img = sharp(buf, { failOn: 'none' });
  const meta = await img.metadata();
  const thumb = await img.resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
  return { thumb, width: meta.width ?? 0, height: meta.height ?? 0 };
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
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.localAlbumId, album.id), eq(images.kind, 'front')))
    .limit(1);
  if (existing.length > 0) return;

  const tracks = await ctx.db
    .select({ audioFileId: localTracks.audioFileId })
    .from(localTracks)
    .where(eq(localTracks.localAlbumId, album.id));
  if (tracks.length === 0) return;
  const fileRows = await ctx.db
    .select({
      id: audioFiles.id,
      relPath: audioFiles.relPath,
      scanRootId: audioFiles.scanRootId,
      hasArt: audioFiles.hasEmbeddedArt,
    })
    .from(audioFiles)
    .where(inArray(audioFiles.id, tracks.map((t) => t.audioFileId)));
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

  // 1. embedded artwork (largest picture of the first art-bearing file)
  const withArt = fileRows.find((f) => f.hasArt);
  if (withArt) {
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

  await ctx.db
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
      thumbBytes: thumb,
      licenseNote: license,
      fetchedAt: new Date(),
    })
    .onConflictDoNothing();
}

/** Enqueue art.fetch for albums without a front image yet. */
export async function artSweepJob(ctx: WorkerContext, data: ArtSweepJobData): Promise<void> {
  const limit = data.limit ?? 2000;
  const rows = await ctx.db.execute(dsql`
    select la.id from local_albums la
    where la.library_id = ${data.libraryId}
      and la.state != 'ignored'
      and not exists (select 1 from images i where i.local_album_id = la.id and i.kind = 'front')
    order by la.state = 'matched' desc, la.created_at
    limit ${limit}`) as unknown as { id: string }[];
  for (const r of rows) {
    await ctx.boss.send('art.fetch', { localAlbumId: r.id }, { singletonKey: `art:${r.id}` });
  }
  ctx.logger.info({ libraryId: data.libraryId, enqueued: rows.length }, 'art sweep');
}
