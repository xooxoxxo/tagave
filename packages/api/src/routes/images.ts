import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { coverThumbs, images, libraries } from '@tagave/db';
import { getDb, getSql } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { claimSweepRequest, makeThumbRebuildRequester, type ThumbRebuildRequester } from '../lib/thumbRebuild.js';

/**
 * Shown while a cover's thumbnail is being rebuilt (backups do not hold
 * thumbnails, so a restored library shows this for a few minutes). The
 * groove mark of the web placeholder on a transparent field: the cover's own
 * background shows through, in either theme. Never cached. Its intrinsic
 * size is 1×1 px: that is how the web's CoverArt, which cannot read the
 * X-Tagave-Placeholder header from an <img>, knows to show its own
 * placeholder and ask again later.
 */
export const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1" height="1">' +
  '<g fill="none" stroke="#8a8f98" stroke-opacity="0.35" stroke-width="0.6">' +
  '<circle cx="50" cy="50" r="31.2"/><circle cx="50" cy="50" r="25"/><circle cx="50" cy="50" r="18.7"/></g></svg>';

export interface ImageRoutesOptions {
  /** Test seam: what a missing thumbnail asks the worker to do. */
  requestRebuild?: ThumbRebuildRequester;
}

/** ETag of a stored thumbnail: its sha256, quoted. */
const etagOf = (sha256: Buffer) => `"${sha256.toString('hex')}"`;

/** Does an If-None-Match header name this ETag (or "*")? Weak validators compare equal too. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const values = (Array.isArray(header) ? header.join(',') : header).split(',').map((v) => v.trim().replace(/^W\//, ''));
  return values.includes('*') || values.includes(etag);
}

export async function createImageRoutes(fastify: FastifyInstance, opts: ImageRoutesOptions = {}) {
  const requestRebuild = opts.requestRebuild ?? makeThumbRebuildRequester({
    getBoss,
    claimSweep: () => claimSweepRequest(getSql()),
    log: (obj, msg) => fastify.log.warn(obj, msg),
  });

  /** 300px front-cover thumbnail for a local album (auth'd, cacheable, ETag). */
  fastify.get('/images/album/:albumId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { albumId } = request.params as { albumId: string };
    const db = getDb();

    const rows = await db
      .select({
        imageId: images.id,
        thumb: coverThumbs.bytes,
        sha256: coverThumbs.sha256,
      })
      .from(images)
      .innerJoin(libraries, eq(libraries.id, images.libraryId))
      .leftJoin(coverThumbs, eq(coverThumbs.imageId, images.id))
      .where(and(eq(images.localAlbumId, albumId), eq(images.kind, 'front')))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new ApiError(404, 'Not Found', 'No cover for this album');
    }

    if (!row.thumb || !row.sha256) {
      // The album has a cover but its thumbnail is not built (yet): after a
      // restore, or a lost row. Show the placeholder and have it rebuilt.
      void requestRebuild(row.imageId);
      return reply
        .header('Content-Type', 'image/svg+xml')
        .header('Cache-Control', 'no-store')
        .header('X-Tagave-Placeholder', 'rebuilding')
        .send(PLACEHOLDER_SVG);
    }

    // A changed cover gets a new hash, so the browser revalidates after a day
    // instead of keeping the old one (no `immutable`: the URL has no version).
    const etag = etagOf(Buffer.from(row.sha256 as unknown as Buffer));
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=86400');
    if (etagMatches(request.headers['if-none-match'], etag)) {
      return reply.status(304).send();
    }
    return reply.header('Content-Type', 'image/jpeg').send(Buffer.from(row.thumb as unknown as Buffer));
  });
}
