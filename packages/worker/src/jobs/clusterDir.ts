import { and, eq, inArray, like, or } from 'drizzle-orm';
import { audioFiles, clusterOverrides, localAlbums, localTracks } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import {
  clusterKey, discDirNumber, extractYear, extOf, normKey,
  relBasename, relDirname, titleFromName, trackNoFromName,
} from '../lib/helpers.js';

export interface ClusterDirJobData {
  libraryId: string;
  scanRootId: string;
  /** NFC rel dir the parse batch touched. */
  dirPath: string;
}

interface FileTags {
  album: string | null;
  albumartist: string | null;
  artist: string | null;
  disc: number | null;
  track: number | null;
  title: string | null;
  year: number | null;
}

interface FileRow {
  id: string;
  relPath: string;
  durationMs: number | null;
  format: string;
  tags: FileTags;
}

function tagsOf(tagsRaw: unknown): FileTags {
  const common = ((tagsRaw as { common?: Record<string, unknown> } | null)?.common ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = common[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
    return null;
  };
  const no = (k: string): number | null => {
    const v = common[k] as { no?: unknown } | undefined;
    const n = typeof v?.no === 'number' ? v.no : typeof v?.no === 'string' ? parseInt(v.no, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const yearV = common['year'];
  return {
    album: str('album'),
    albumartist: str('albumartist'),
    artist: str('artist'),
    disc: no('disk'),
    track: no('track'),
    title: str('title'),
    year: typeof yearV === 'number' && yearV > 1000 ? yearV : extractYear(str('date')),
  };
}

/**
 * spec LIB-6. Clusters the files of one directory scope into local albums.
 * Scope = the directory itself, or — when the directory (or its siblings)
 * are disc dirs ("CD1", "Disc 2") — the common parent, so multi-disc albums
 * become one cluster.
 */
export async function clusterDirJob(ctx: WorkerContext, data: ClusterDirJobData): Promise<void> {
  // Disc dir → operate on the parent scope.
  const base = relBasename(data.dirPath);
  const scope = data.dirPath !== '' && discDirNumber(base) !== null
    ? relDirname(data.dirPath)
    : data.dirPath;

  // Files directly in scope + files exactly one level below (disc subdirs).
  const prefix = scope === '' ? '' : scope + '/';
  const candidates = await ctx.db
    .select({
      id: audioFiles.id,
      relPath: audioFiles.relPath,
      durationMs: audioFiles.durationMs,
      tagsRaw: audioFiles.tagsRaw,
      status: audioFiles.status,
    })
    .from(audioFiles)
    .where(and(
      eq(audioFiles.scanRootId, data.scanRootId),
      or(eq(audioFiles.status, 'present'), eq(audioFiles.status, 'error')),
      prefix === '' ? undefined : like(audioFiles.relPath, prefix.replaceAll('%', '\\%').replaceAll('_', '\\_') + '%'),
    ));

  const inScope: FileRow[] = [];
  for (const r of candidates) {
    const dir = relDirname(r.relPath);
    if (dir === scope) {
      inScope.push(toFileRow(r));
    } else if (relDirname(dir) === scope && discDirNumber(relBasename(dir)) !== null) {
      inScope.push(toFileRow(r));
    }
  }
  if (inScope.length === 0) return;

  // Owner overrides pin files to albums regardless of rules (IDN-4).
  const overrides = await ctx.db
    .select({ audioFileId: clusterOverrides.audioFileId, localAlbumId: clusterOverrides.localAlbumId })
    .from(clusterOverrides)
    .where(inArray(clusterOverrides.audioFileId, inScope.map((f) => f.id)));
  const pinned = new Map(overrides.map((o) => [o.audioFileId, o.localAlbumId]));

  // Group by (albumKey, artistKey); no album tag → loose bucket.
  interface Group { albumKey: string; artistKey: string; files: FileRow[]; dirs: Set<string> }
  const groups = new Map<string, Group>();
  const loose: FileRow[] = [];
  for (const f of inScope) {
    if (pinned.has(f.id)) continue;
    if (!f.tags.album) {
      loose.push(f);
      continue;
    }
    const albumKey = normKey(f.tags.album);
    const artistKey = normKey(f.tags.albumartist ?? f.tags.artist ?? '');
    const key = albumKey + '\n' + artistKey;
    let g = groups.get(key);
    if (!g) {
      g = { albumKey, artistKey, files: [], dirs: new Set() };
      groups.set(key, g);
    }
    g.files.push(f);
    g.dirs.add(relDirname(f.relPath));
  }

  for (const g of groups.values()) {
    const dirPaths = [...g.dirs].sort();
    const ckey = clusterKey(data.libraryId, dirPaths, g.albumKey, g.artistKey);

    const sample = g.files.find((f) => f.tags.album) as FileRow;
    const discNos = new Set<number>();
    let totalDuration = 0;
    const formats = new Set<string>();
    for (const f of g.files) {
      const parentDisc = discDirNumber(relBasename(relDirname(f.relPath)));
      discNos.add(f.tags.disc ?? parentDisc ?? 1);
      totalDuration += f.durationMs ?? 0;
      formats.add(f.format);
    }

    const albumValues = {
      titleGuess: sample.tags.album,
      artistGuess: sample.tags.albumartist ?? sample.tags.artist ?? null,
      yearGuess: g.files.map((f) => f.tags.year).find((y) => y !== null)
        ?? extractYear(relBasename(dirPaths[0] ?? '')) ?? null,
      dirPaths,
      discCount: discNos.size,
      trackCount: g.files.length,
      totalDurationMs: totalDuration,
      formats: [...formats].sort(),
      updatedAt: new Date(),
    };

    // Idempotent upsert by cluster_key: unchanged clusters keep id/state/history.
    const existing = await ctx.db
      .select({ id: localAlbums.id })
      .from(localAlbums)
      .where(and(eq(localAlbums.libraryId, data.libraryId), eq(localAlbums.clusterKey, ckey)))
      .limit(1);
    let albumId: string;
    const existingRow = existing[0];
    if (existingRow) {
      albumId = existingRow.id;
      await ctx.db.update(localAlbums).set(albumValues).where(eq(localAlbums.id, albumId));
    } else {
      const ins = await ctx.db
        .insert(localAlbums)
        .values({ libraryId: data.libraryId, clusterKey: ckey, state: 'pending', ...albumValues })
        .returning({ id: localAlbums.id });
      const row = ins[0];
      if (!row) throw new Error('local_albums insert returned no row');
      albumId = row.id;
    }

    await replaceTracks(ctx, albumId, g.files);
  }

  // Loose tracks: local_tracks rows with no album (spec LIB-6).
  if (loose.length > 0) await replaceTracks(ctx, null, loose);

  // Pinned files keep their override album; refresh their track rows there.
  for (const [fileId, albumId] of pinned) {
    const f = inScope.find((x) => x.id === fileId);
    if (f) await replaceTracks(ctx, albumId ?? null, [f]);
  }

  ctx.logger.debug(
    { scope, groups: groups.size, loose: loose.length, pinned: pinned.size },
    'clustered directory',
  );
}

function toFileRow(r: { id: string; relPath: string; durationMs: number | null; tagsRaw: unknown }): FileRow {
  return {
    id: r.id,
    relPath: r.relPath,
    durationMs: r.durationMs,
    format: extOf(relBasename(r.relPath)).slice(1),
    tags: tagsOf(r.tagsRaw),
  };
}

async function replaceTracks(ctx: WorkerContext, albumId: string | null, files: FileRow[]): Promise<void> {
  await ctx.db.delete(localTracks).where(inArray(localTracks.audioFileId, files.map((f) => f.id)));
  await ctx.db.insert(localTracks).values(
    files.map((f) => {
      const name = relBasename(f.relPath);
      const parentDisc = discDirNumber(relBasename(relDirname(f.relPath)));
      return {
        localAlbumId: albumId,
        audioFileId: f.id,
        discNo: f.tags.disc ?? parentDisc ?? null,
        trackNo: f.tags.track ?? trackNoFromName(name),
        titleGuess: f.tags.title ?? titleFromName(name),
        artistGuess: f.tags.artist ?? f.tags.albumartist ?? null,
        durationMs: f.durationMs,
        state: 'unmatched',
      };
    }),
  );
}
