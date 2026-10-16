/**
 * Cover thumbnails (cover_thumbs, migration 0046): 300px JPEGs the api
 * serves. Backups leave the table's rows out, so this is also the code that
 * rebuilds them from the originals on the cache volume (art.thumb).
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { sql as dsql } from 'drizzle-orm';
import { coverThumbs } from '@tagave/db';
import type { WorkerContext } from './context.js';

export const THUMB_SIZE = 300;

/** 300px square JPEG (fit cover, q82) plus the original's dimensions. */
export async function toThumb(buf: Buffer): Promise<{ thumb: Buffer; width: number; height: number }> {
  const img = sharp(buf, { failOn: 'none' });
  const meta = await img.metadata();
  const thumb = await img.resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
  return { thumb, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** A drizzle handle or a transaction on it. */
type Db = Pick<WorkerContext['db'], 'insert'>;

/** Store (or replace) an image's thumbnail; its hash is the ETag the api serves. */
export async function storeThumb(db: Db, imageId: string, thumb: Buffer): Promise<void> {
  const sha256 = createHash('sha256').update(thumb).digest();
  await db
    .insert(coverThumbs)
    .values({ imageId, size: THUMB_SIZE, bytes: thumb, sha256 })
    .onConflictDoUpdate({
      target: [coverThumbs.imageId, coverThumbs.size],
      set: { bytes: thumb, sha256, createdAt: dsql`now()` },
    });
}
