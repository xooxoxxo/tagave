import path from 'node:path';
import { access } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import { eq, inArray } from 'drizzle-orm';
import { audioFiles, scanRoots } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { relDirname, tagsDigest } from '../lib/helpers.js';
import { tagSnapshotOf } from '../lib/tagSnapshot.js';

export interface ScanParseJobData {
  audioFileIds: string[];
}

/**
 * The stored rel_path is NFC, but the bytes on disk may be NFD (or the exact
 * NFC). Try the stored spelling, then both normalization forms — the same
 * discipline the archive-cleaning tooling needed (decisions doc gotcha #1).
 */
async function openablePath(rootPath: string, relPath: string): Promise<string | null> {
  const candidates = [relPath, relPath.normalize('NFD'), relPath.normalize('NFC')];
  for (const cand of candidates) {
    const abs = path.join(rootPath, cand);
    try {
      await access(abs);
      return abs;
    } catch {
      /* try next spelling */
    }
  }
  return null;
}

/** spec LIB-2: extract audio properties + full tag snapshot; errors are
 * per-file, never batch-fatal. */
export async function scanParseJob(ctx: WorkerContext, data: ScanParseJobData): Promise<void> {
  if (!data.audioFileIds || data.audioFileIds.length === 0) return;

  const rows = await ctx.db
    .select({
      id: audioFiles.id,
      relPath: audioFiles.relPath,
      scanRootId: audioFiles.scanRootId,
      libraryId: audioFiles.libraryId,
    })
    .from(audioFiles)
    .where(inArray(audioFiles.id, data.audioFileIds));
  if (rows.length === 0) return;

  const rootIds = [...new Set(rows.map((r) => r.scanRootId))];
  const roots = await ctx.db
    .select({ id: scanRoots.id, path: scanRoots.path })
    .from(scanRoots)
    .where(inArray(scanRoots.id, rootIds));
  const rootPathById = new Map(roots.map((r) => [r.id, r.path]));

  const dirsTouched = new Map<string, { libraryId: string; scanRootId: string }>();

  for (const row of rows) {
    const rootPath = rootPathById.get(row.scanRootId);
    if (!rootPath) continue;

    const abs = await openablePath(rootPath, row.relPath);
    if (!abs) {
      await ctx.db
        .update(audioFiles)
        .set({ status: 'error', parseError: 'file not reachable under any normalization form' })
        .where(eq(audioFiles.id, row.id));
      continue;
    }

    try {
      const meta = await parseFile(abs, { duration: true });
      const fmt = meta.format;
      const tagsRaw = tagSnapshotOf(meta);

      await ctx.db
        .update(audioFiles)
        .set({
          container: fmt.container ?? null,
          codec: fmt.codec ?? null,
          lossless: fmt.lossless ?? null,
          durationMs: fmt.duration ? Math.round(fmt.duration * 1000) : null,
          sampleRate: fmt.sampleRate ?? null,
          bitDepth: fmt.bitsPerSample ?? null,
          channels: fmt.numberOfChannels ?? null,
          bitrateKbps: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null,
          hasEmbeddedArt: (meta.common.picture?.length ?? 0) > 0,
          tagsRaw,
          tagsDigest: tagsDigest(tagsRaw),
          tagsReadAt: new Date(),
          status: 'present',
          parseError: null,
        })
        .where(eq(audioFiles.id, row.id));
    } catch (err) {
      await ctx.db
        .update(audioFiles)
        .set({
          status: 'error',
          parseError: `${(err as Error).name ?? 'Error'}: ${(err as Error).message}`.slice(0, 2000),
        })
        .where(eq(audioFiles.id, row.id));
    }

    const dir = relDirname(row.relPath);
    dirsTouched.set(`${row.scanRootId}\n${dir}`, {
      libraryId: row.libraryId,
      scanRootId: row.scanRootId,
    });
  }

  // Debounced re-cluster of every touched directory (singleton per dir).
  for (const [key, info] of dirsTouched) {
    const dirPath = key.split('\n')[1] ?? '';
    await ctx.boss.send(
      'cluster.dir',
      { libraryId: info.libraryId, scanRootId: info.scanRootId, dirPath },
      {
        singletonKey: `cluster:${info.scanRootId}:${dirPath}`,
        singletonSeconds: 30,
        startAfter: 30,
      },
    );
  }
}

