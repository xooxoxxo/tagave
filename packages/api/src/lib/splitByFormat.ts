/**
 * Split a mixed album (lossless and lossy copies of the same release in one
 * folder) into two local albums, and merge it back.
 *
 * The moved files are pinned to the new album through cluster_overrides
 * (IDN-4), so the next cluster.dir run — and every scan after it — keeps
 * them apart. Both albums then identify on their own and the duplicate gap
 * flags the pair; the owner deletes at leisure (file deletion is not a v1
 * feature). Merge back removes the pins and the split-off album; the folder
 * re-clusters into one album again.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { audioFiles, clusterOverrides, localAlbums, localTracks } from '@liner/db';
import type { getDb } from '../db.js';

type Db = ReturnType<typeof getDb>;

export const SPLIT_KEY_PREFIX = 'split:';

/** original album id when `clusterKey` marks a split-off album, else null */
export function splitOriginOf(clusterKey: string | null | undefined): string | null {
  if (!clusterKey || !clusterKey.startsWith(SPLIT_KEY_PREFIX)) return null;
  const [, original] = clusterKey.split(':');
  return original && /^[0-9a-f-]{36}$/i.test(original) ? original : null;
}

export interface SplitResult {
  newAlbumId: string;
  movedFileIds: string[];
  keptFileIds: string[];
  /** (scanRootId, rel dir) pairs to re-cluster */
  dirs: Array<{ scanRootId: string; dirPath: string }>;
}

export class SplitError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const relDirname = (relPath: string) => {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
};
const extOf = (relPath: string) => {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
};

export async function splitAlbumByFormat(
  db: Db,
  input: { libraryId: string; albumId: string; userId: string; keep: 'lossless' | 'lossy' },
): Promise<SplitResult> {
  const [album] = await db.select().from(localAlbums)
    .where(and(eq(localAlbums.id, input.albumId), eq(localAlbums.libraryId, input.libraryId)));
  if (!album) throw new SplitError(404, 'Album not found');
  if (splitOriginOf(album.clusterKey)) throw new SplitError(409, 'This album is already a split-off copy; merge it back first');

  const files = await db
    .select({
      id: audioFiles.id,
      relPath: audioFiles.relPath,
      scanRootId: audioFiles.scanRootId,
      lossless: audioFiles.lossless,
      durationMs: audioFiles.durationMs,
    })
    .from(localTracks)
    .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
    .where(eq(localTracks.localAlbumId, input.albumId));
  const unique = [...new Map(files.map((f) => [f.id, f])).values()];
  const lossless = unique.filter((f) => f.lossless === true);
  const lossy = unique.filter((f) => f.lossless !== true);
  if (lossless.length === 0 || lossy.length === 0) {
    throw new SplitError(409, 'Album is not mixed: it has no lossless and lossy copies side by side');
  }
  const moving = input.keep === 'lossless' ? lossy : lossless;
  const staying = input.keep === 'lossless' ? lossless : lossy;
  const movingIds = moving.map((f) => f.id);

  const dirs = [...new Map(moving.map((f) => [`${f.scanRootId}\n${relDirname(f.relPath)}`, { scanRootId: f.scanRootId, dirPath: relDirname(f.relPath) }])).values()];
  const formatsOf = (fs: typeof moving) => [...new Set(fs.map((f) => extOf(f.relPath)).filter(Boolean))].sort();
  const durationOf = (fs: typeof moving) => fs.reduce((s, f) => s + (f.durationMs ?? 0), 0);
  // A cue-split image file carries several track rows; count rows, not files.
  const trackRowsOf = async (fs: typeof moving) => {
    if (fs.length === 0) return 0;
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(localTracks)
      .where(inArray(localTracks.audioFileId, fs.map((f) => f.id)));
    return row?.n ?? fs.length;
  };
  const [movingTracks, stayingTracks] = await Promise.all([trackRowsOf(moving), trackRowsOf(staying)]);

  const [created] = await db.insert(localAlbums).values({
    libraryId: input.libraryId,
    clusterKey: `${SPLIT_KEY_PREFIX}${album.id}:${input.keep === 'lossless' ? 'lossy' : 'lossless'}`,
    dirPaths: album.dirPaths,
    titleGuess: album.titleGuess,
    artistGuess: album.artistGuess,
    yearGuess: album.yearGuess,
    discCount: album.discCount,
    trackCount: movingTracks,
    totalDurationMs: durationOf(moving),
    formats: formatsOf(moving),
    state: 'pending',
  }).returning({ id: localAlbums.id });
  if (!created) throw new SplitError(500, 'Could not create the split-off album');

  // Pin the moved files (replace any earlier pin), move their track rows now
  // so the page updates immediately, and refresh the original's counters.
  await db.delete(clusterOverrides).where(inArray(clusterOverrides.audioFileId, movingIds));
  await db.insert(clusterOverrides).values(movingIds.map((audioFileId) => ({
    libraryId: input.libraryId,
    audioFileId,
    localAlbumId: created.id,
    createdBy: input.userId,
  })));
  await db.update(localTracks).set({ localAlbumId: created.id }).where(inArray(localTracks.audioFileId, movingIds));
  await db.update(localAlbums).set({
    trackCount: stayingTracks,
    totalDurationMs: durationOf(staying),
    formats: formatsOf(staying),
    updatedAt: new Date(),
  }).where(eq(localAlbums.id, album.id));

  return { newAlbumId: created.id, movedFileIds: movingIds, keptFileIds: staying.map((f) => f.id), dirs };
}

export interface MergeResult {
  originalAlbumId: string;
  fileIds: string[];
  dirs: Array<{ scanRootId: string; dirPath: string }>;
}

/** `albumId` is the split-off album; its files go back to the original. */
export async function mergeSplitAlbum(
  db: Db,
  input: { libraryId: string; albumId: string },
): Promise<MergeResult> {
  const [album] = await db.select().from(localAlbums)
    .where(and(eq(localAlbums.id, input.albumId), eq(localAlbums.libraryId, input.libraryId)));
  if (!album) throw new SplitError(404, 'Album not found');
  const originalId = splitOriginOf(album.clusterKey);
  if (!originalId) throw new SplitError(409, 'This album was not split off from another one');
  const [original] = await db.select({ id: localAlbums.id }).from(localAlbums)
    .where(and(eq(localAlbums.id, originalId), eq(localAlbums.libraryId, input.libraryId)));
  if (!original) throw new SplitError(409, 'The original album no longer exists');

  const pins = await db
    .select({ audioFileId: clusterOverrides.audioFileId, relPath: audioFiles.relPath, scanRootId: audioFiles.scanRootId })
    .from(clusterOverrides)
    .innerJoin(audioFiles, eq(audioFiles.id, clusterOverrides.audioFileId))
    .where(eq(clusterOverrides.localAlbumId, album.id));
  const fileIds = pins.map((p) => p.audioFileId);
  const dirs = [...new Map(pins.map((p) => [`${p.scanRootId}\n${relDirname(p.relPath)}`, { scanRootId: p.scanRootId, dirPath: relDirname(p.relPath) }])).values()];
  if (dirs.length === 0) {
    // No pins left (merged by hand?): re-cluster the folders the original's
    // own files live in — never a guessed root.
    const originalFiles = await db
      .select({ scanRootId: audioFiles.scanRootId, relPath: audioFiles.relPath })
      .from(localTracks)
      .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
      .where(eq(localTracks.localAlbumId, originalId));
    for (const f of originalFiles) {
      const dirPath = relDirname(f.relPath);
      if (!dirs.some((d) => d.scanRootId === f.scanRootId && d.dirPath === dirPath)) dirs.push({ scanRootId: f.scanRootId, dirPath });
    }
  }

  if (fileIds.length) {
    await db.delete(clusterOverrides).where(inArray(clusterOverrides.audioFileId, fileIds));
    await db.update(localTracks).set({ localAlbumId: originalId }).where(inArray(localTracks.audioFileId, fileIds));
  }
  // Anything else still pointing at the split album (manual pins) goes back too.
  await db.update(localTracks).set({ localAlbumId: originalId }).where(eq(localTracks.localAlbumId, album.id));
  await db.delete(localAlbums).where(eq(localAlbums.id, album.id));
  await db.execute(sql`
    update local_albums la set
      track_count = s.n, total_duration_ms = s.dur, formats = s.formats, updated_at = now()
    from (
      select count(*)::int as n, coalesce(sum(af.duration_ms), 0)::int as dur,
             coalesce(array_agg(distinct lower(regexp_replace(af.rel_path, '^.*\\.', ''))) filter (where af.rel_path like '%.%'), '{}') as formats
      from local_tracks lt join audio_files af on af.id = lt.audio_file_id
      where lt.local_album_id = ${originalId}
    ) s
    where la.id = ${originalId}`);

  return { originalAlbumId: originalId, fileIds, dirs };
}
