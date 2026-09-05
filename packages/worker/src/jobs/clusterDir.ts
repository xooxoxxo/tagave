import { readFile, access } from 'node:fs/promises';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { audioFiles, clusterOverrides, localAlbums, localTracks, scanRoots, sidecarFiles } from '@liner/db';
import { parseCueSheet, type VirtualTrack, type CueSheet } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { expandFilesWithCues } from '../lib/cueExpand.js';
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
  virtual?: {
    tracks: VirtualTrack[];
    cueRelPath: string;
    sheet: CueSheet;
  };
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

  // Load and parse cue files (spec XO-314). Get scan root path for file I/O.
  const roots = await ctx.db
    .select({ id: scanRoots.id, path: scanRoots.path })
    .from(scanRoots)
    .where(eq(scanRoots.id, data.scanRootId));
  const rootPath = roots[0]?.path;

  if (rootPath) {
    const scopeDirs = [...new Set(inScope.map((f) => relDirname(f.relPath)))];
    const prefix = scope === '' ? '' : scope + '/';
    const cueSidecars = await ctx.db
      .select({ relPath: sidecarFiles.relPath })
      .from(sidecarFiles)
      .where(and(
        eq(sidecarFiles.scanRootId, data.scanRootId),
        eq(sidecarFiles.kind, 'cue'),
        prefix === '' ? undefined : like(sidecarFiles.relPath, prefix.replaceAll('%', '\\%').replaceAll('_', '\\_') + '%'),
      ));

    // Parse cues, filtering to scope dirs
    const cueInfos: Array<{ relPath: string; sheet: CueSheet }> = [];
    for (const sc of cueSidecars) {
      const cueDir = relDirname(sc.relPath);
      if (!scopeDirs.includes(cueDir)) continue;

      // Try to read with NFC/NFD variants (like openVariant in artFetch.ts)
      let bytes: Buffer | null = null;
      for (const cand of [sc.relPath, sc.relPath.normalize('NFD'), sc.relPath.normalize('NFC')]) {
        try {
          await access(rootPath + '/' + cand);
          bytes = await readFile(rootPath + '/' + cand);
          break;
        } catch { /* try next */ }
      }

      if (!bytes) {
        ctx.logger.warn({ cue: sc.relPath }, 'cue file not accessible');
        continue;
      }

      try {
        const sheet = parseCueSheet(bytes);
        cueInfos.push({ relPath: sc.relPath, sheet });
      } catch (err) {
        ctx.logger.warn({ cue: sc.relPath, error: String(err) }, 'failed to parse cue sheet');
      }
    }

    // Expand files with cues
    if (cueInfos.length > 0) {
      const expanded = expandFilesWithCues(inScope, cueInfos);
      for (const [fileId, cueData] of expanded) {
        const f = inScope.find((x) => x.id === fileId);
        if (f) {
          f.virtual = cueData;
          ctx.logger.info(
            {
              relPath: f.relPath,
              cue: cueData.cueRelPath,
              tracks: cueData.tracks.length,
            },
            'expanded file with cue sheet',
          );
        }
      }
    }
  }

  // Owner overrides pin files to albums regardless of rules (IDN-4).
  const overrides = await ctx.db
    .select({ audioFileId: clusterOverrides.audioFileId, localAlbumId: clusterOverrides.localAlbumId })
    .from(clusterOverrides)
    .where(inArray(clusterOverrides.audioFileId, inScope.map((f) => f.id)));
  const pinned = new Map(overrides.map((o) => [o.audioFileId, o.localAlbumId]));

  // Group by album tag first; the artist identity of a cluster is decided
  // per album AFTER seeing every member, so VA compilations (per-track
  // artists, no albumartist) stay one cluster instead of one per artist —
  // same >3-distinct-artists rule the 2026-08 archive cleanup validated on
  // this collection (M0 decisions doc).
  // Cue sheet title serves as album when file has no tag (spec XO-314).
  interface Group { albumKey: string; artistKey: string; files: FileRow[]; dirs: Set<string> }
  const byAlbum = new Map<string, FileRow[]>();
  const loose: FileRow[] = [];
  for (const f of inScope) {
    if (pinned.has(f.id)) continue;
    const albumTag = f.tags.album ?? (f.virtual?.sheet.title ?? null);
    if (!albumTag) {
      loose.push(f);
      continue;
    }
    const albumKey = normKey(albumTag);
    const arr = byAlbum.get(albumKey);
    if (arr) arr.push(f);
    else byAlbum.set(albumKey, [f]);
  }
  const groups = new Map<string, Group>();
  for (const [albumKey, files] of byAlbum) {
    const albumartists = new Set(files.map((f) => f.tags.albumartist).filter(Boolean).map((a) => normKey(a as string)));
    const artists = new Set(files.map((f) => f.tags.artist).filter(Boolean).map((a) => normKey(a as string)));
    const assign = (artistKey: string, fs: FileRow[]) => {
      const key = albumKey + '\n' + artistKey;
      let g = groups.get(key);
      if (!g) {
        g = { albumKey, artistKey, files: [], dirs: new Set() };
        groups.set(key, g);
      }
      for (const f of fs) {
        g.files.push(f);
        g.dirs.add(relDirname(f.relPath));
      }
    };
    if (albumartists.size > 0) {
      // Albumartist is authoritative when present; files without it join the
      // sole albumartist cluster rather than splintering.
      if (albumartists.size === 1) {
        assign([...albumartists][0] as string, files);
      } else {
        for (const f of files) {
          assign(normKey(f.tags.albumartist ?? f.tags.artist ?? ''), [f]);
        }
      }
    } else if (artists.size > 3) {
      assign('various artists', files);
    } else {
      for (const f of files) assign(normKey(f.tags.artist ?? ''), [f]);
    }
  }

  for (const g of groups.values()) {
    const dirPaths = [...g.dirs].sort();
    const ckey = clusterKey(data.libraryId, dirPaths, g.albumKey, g.artistKey);

    const sample = g.files.find((f) => f.tags.album) ?? g.files[0]!;
    const discNos = new Set<number>();
    let totalDuration = 0;
    const formats = new Set<string>();
    let trackCount = 0;
    for (const f of g.files) {
      const parentDisc = discDirNumber(relBasename(relDirname(f.relPath)));
      // Disc number: cue sheet > file tag > parent disc dir > 1
      const sheetDisc = f.virtual?.sheet.discNumber ?? null;
      discNos.add(sheetDisc ?? f.tags.disc ?? parentDisc ?? 1);
      totalDuration += f.durationMs ?? 0;
      formats.add(f.format);
      // Track count: sum of virtual tracks per file, or 1 if plain file
      trackCount += f.virtual ? f.virtual.tracks.length : 1;
    }

    const albumValues = {
      titleGuess: sample.tags.album ?? sample.virtual?.sheet.title ?? null,
      artistGuess: g.artistKey === 'various artists' && !sample.tags.albumartist
        ? 'Various Artists'
        : sample.tags.albumartist ?? sample.tags.artist ?? sample.virtual?.sheet.performer ?? null,
      yearGuess: g.files.map((f) => f.tags.year).find((y) => y !== null)
        ?? g.files.map((f) => f.virtual?.sheet.date ?? null).find((y) => y !== null)
        ?? extractYear(relBasename(dirPaths[0] ?? '')) ?? null,
      dirPaths,
      discCount: discNos.size,
      trackCount,
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

  // Clusters in scope that lost every track to regrouping are dead weight;
  // only untouched states are safe to reap.
  await ctx.sql`
    delete from local_albums la
    where la.library_id = ${data.libraryId}
      and la.state in ('pending', 'unidentified')
      and ${scope === '' ? ctx.sql`true` : ctx.sql`la.dir_paths && ARRAY[${scope}]::text[]`}
      and not exists (select 1 from local_tracks lt where lt.local_album_id = la.id)`;

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

  const rows: Array<{
    localAlbumId: string | null;
    audioFileId: string;
    discNo: number | null;
    trackNo: number | null;
    titleGuess: string | null;
    artistGuess: string | null;
    durationMs: number | null;
    state: string;
    origin?: string;
    cueStartMs?: number | null;
    cueRelPath?: string | null;
  }> = [];

  for (const f of files) {
    const name = relBasename(f.relPath);
    const parentDisc = discDirNumber(relBasename(relDirname(f.relPath)));

    if (f.virtual) {
      // Virtual tracks: one row per track from the cue sheet
      const vt = f.virtual;
      for (const track of vt.tracks) {
        rows.push({
          localAlbumId: albumId,
          audioFileId: f.id,
          discNo: vt.sheet.discNumber ?? f.tags.disc ?? parentDisc ?? null,
          trackNo: track.number,
          titleGuess: track.title ?? `Track ${track.number}`,
          artistGuess: track.performer ?? f.tags.artist ?? f.tags.albumartist ?? null,
          durationMs: track.durationMs,
          origin: 'cue',
          cueStartMs: track.startMs,
          cueRelPath: vt.cueRelPath,
          state: 'unmatched',
        });
      }
    } else {
      // Plain file: one row
      rows.push({
        localAlbumId: albumId,
        audioFileId: f.id,
        discNo: f.tags.disc ?? parentDisc ?? null,
        trackNo: f.tags.track ?? trackNoFromName(name),
        titleGuess: f.tags.title ?? titleFromName(name),
        artistGuess: f.tags.artist ?? f.tags.albumartist ?? null,
        durationMs: f.durationMs,
        state: 'unmatched',
      });
    }
  }

  if (rows.length > 0) {
    await ctx.db.insert(localTracks).values(rows);
  }
}
