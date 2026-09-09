import { readFile, access } from 'node:fs/promises';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { audioFiles, clusterOverrides, localAlbums, localTracks, scanRoots, sidecarFiles } from '@liner/db';
import { parseCueSheet, type VirtualTrack, type CueSheet } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { expandFilesWithCues } from '../lib/cueExpand.js';
import {
  clusterKey, discDirNumber, discTokenOfFolder, extractYear, extOf,
  filenameDiscPrefix, filenameDiscPrefixesApply, tagDiscsPlausible, normKey,
  relBasename, relDirname, stripDiscTokenFromTitle, titleFromName, trackNoFromName,
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
  // Disc dir ("CD1") → operate on the parent scope.
  const base = relBasename(data.dirPath);
  let scope = data.dirPath !== '' && discDirNumber(base) !== null
    ? relDirname(data.dirPath)
    : data.dirPath;

  // A disc token appended to the album folder itself ("… CD1", "… (Disc 2)")
  // splits one album across sibling folders. When the parent holds two or more
  // such siblings with the same stripped title and different numbers, the
  // scope is the parent and only those siblings are in it — one cluster, one
  // disc per folder. Resolution is a pure function of the stripped title, so
  // every sibling that triggers the job lands on the same scope and key.
  //
  // Only the unambiguous cd/disc/disk spellings merge. "Vol. n" is as often a
  // series as a disc, and merging on it folded whole series into one album on
  // prod ("Guardians of Hellenism, Vol. 2" … "Vol. 14" — ten folders, ten
  // albums, one cluster). A "Vol. n" folder is its own album, and carries no
  // disc number of its own either.
  let siblingDirs: string[] | null = null;
  /** dir → disc number implied by a cd/disc/disk token on the folder name */
  const dirTokenDisc = new Map<string, number>();
  const scopeToken = scope === '' ? null : discTokenOfFolder(relBasename(scope));
  if (scopeToken && scopeToken.kind === 'disc') {
    const parent = relDirname(scope);
    const wanted = normKey(scopeToken.title);
    const group: Array<{ dir: string; disc: number }> = [];
    for (const d of await subdirsOf(ctx, data.scanRootId, parent)) {
      const t = discTokenOfFolder(relBasename(d));
      if (t && t.kind === 'disc' && normKey(t.title) === wanted) group.push({ dir: d, disc: t.disc });
    }
    if (group.length >= 2 && new Set(group.map((g) => g.disc)).size >= 2) {
      scope = parent;
      siblingDirs = group.map((g) => g.dir).sort();
      for (const g of group) dirTokenDisc.set(g.dir, g.disc);
    } else {
      // A lone "… CD2" folder still names its disc (spec: folder token tier).
      dirTokenDisc.set(scope, scopeToken.disc);
    }
  }

  // Files directly in scope + files exactly one level below (disc subdirs);
  // with sibling folders, the same two levels under each sibling.
  const prefix = scope === '' ? '' : scope + '/';
  const pathFilter = siblingDirs
    ? or(...siblingDirs.map((d) => like(audioFiles.relPath, likeEscape(d + '/') + '%')))
    : prefix === '' ? undefined : like(audioFiles.relPath, likeEscape(prefix) + '%');
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
      pathFilter,
    ));

  const sibSet = siblingDirs ? new Set(siblingDirs) : null;
  const inScopeDir = (dir: string): boolean => {
    if (sibSet) {
      return sibSet.has(dir)
        || (sibSet.has(relDirname(dir)) && discDirNumber(relBasename(dir)) !== null);
    }
    return dir === scope
      || (relDirname(dir) === scope && discDirNumber(relBasename(dir)) !== null);
  };

  const inScope: FileRow[] = [];
  for (const r of candidates) {
    if (inScopeDir(relDirname(r.relPath))) inScope.push(toFileRow(r));
  }
  if (inScope.length === 0) return;

  /**
   * Disc number per file (spec: cue sheet > tag disk.no > disc subfolder >
   * folder disc token > "n-tt" filename prefix > unknown). null keeps the
   * existing meaning: "no disc information", read as disc 1 downstream.
   * The weakest tier is gated on the whole cluster looking like a real box
   * set — see filenameDiscPrefixesApply; a 3-CD set whose disc 1 is
   * unprefixed still qualifies on discs 2 and 3.
   */
  const resolveDiscs = (files: FileRow[]): Map<string, number | null> => {
    const prefixApplies = filenameDiscPrefixesApply(files.map((f) => relBasename(f.relPath)));
    // Tags that put each file's track number into disk.no are not discs.
    const tagsPlausible = tagDiscsPlausible(files.map((f) => ({ disc: f.tags.disc, track: f.tags.track })));

    const out = new Map<string, number | null>();
    for (const f of files) {
      const dir = relDirname(f.relPath);
      let disc: number | null = f.virtual?.sheet.discNumber ?? (tagsPlausible ? f.tags.disc : null) ?? null;
      if (disc === null) disc = discDirNumber(relBasename(dir));
      if (disc === null) disc = dirTokenDisc.get(dir) ?? null;
      if (disc === null && prefixApplies) disc = filenameDiscPrefix(relBasename(f.relPath))?.disc ?? null;
      out.set(f.id, disc);
    }
    return out;
  };

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
  // Whenever the scope spans discs, "Liebe ist fur alle da CD1"/"… CD2" album
  // tags name the same album — the disc token comes off the tag too, or the
  // halves group apart and never become one cluster. That is true of sibling
  // folders AND of the plain "Album/CD1", "Album/CD2" layout, where the tags
  // carry the token just as often (prod: "Final Fantasy VI Original Sound
  // Version [Disc 1]" / "… CD2" / "… (Disc 3)" under one album folder, three
  // clusters instead of one).
  //
  // The test is what the in-scope FILES show, never which directory triggered
  // the job: cluster_key is derived from the album key, so the job must reach
  // the same answer whether it was handed "Album", "Album/CD1" or "Album/CD2".
  const spansDiscDirs = inScope.some((f) => {
    const dir = relDirname(f.relPath);
    return dir !== scope && discDirNumber(relBasename(dir)) !== null;
  });
  const scopeSpansDiscs = siblingDirs !== null || spansDiscDirs;
  const stripDiscToken = (title: string): string =>
    scopeSpansDiscs ? stripDiscTokenFromTitle(title) : title;

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
    const albumKey = normKey(stripDiscToken(albumTag));
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
    const discs = resolveDiscs(g.files);
    const discNos = new Set<number>();
    let totalDuration = 0;
    const formats = new Set<string>();
    let trackCount = 0;
    for (const f of g.files) {
      discNos.add(discs.get(f.id) ?? 1);
      totalDuration += f.durationMs ?? 0;
      formats.add(f.format);
      // Track count: sum of virtual tracks per file, or 1 if plain file
      trackCount += f.virtual ? f.virtual.tracks.length : 1;
    }

    const albumValues = {
      titleGuess: sample.tags.album
        ? stripDiscToken(sample.tags.album)
        : sample.virtual?.sheet.title ?? null,
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
      // Postgres' clock, not this worker's. cluster.repairDiscs takes its
      // `since` marker from select now() and then asks which albums were
      // written after it; a worker whose clock trails the database would stamp
      // its own re-clusters as older than the sweep that caused them.
      updatedAt: sql`now()`,
    };

    // Idempotent upsert by (library_id, cluster_key): unchanged clusters keep
    // id/state/history. It is a real ON CONFLICT (migration 0025 owns the
    // unique index) because two sibling folders of the same album can be
    // clustered concurrently — a select-then-insert let both jobs miss and
    // both insert, leaving two rows nothing could reconcile. state is set on
    // insert only; an existing album keeps whatever it reached.
    const ins = await ctx.db
      .insert(localAlbums)
      .values({ libraryId: data.libraryId, clusterKey: ckey, state: 'pending', ...albumValues })
      .onConflictDoUpdate({
        target: [localAlbums.libraryId, localAlbums.clusterKey],
        set: albumValues,
      })
      .returning({ id: localAlbums.id });
    const row = ins[0];
    if (!row) throw new Error('local_albums upsert returned no row');
    const albumId = row.id;

    await replaceTracks(ctx, albumId, g.files, discs);
  }

  // Loose tracks: local_tracks rows with no album (spec LIB-6).
  if (loose.length > 0) await replaceTracks(ctx, null, loose, resolveDiscs(loose));

  // Pinned files keep their override album; refresh their track rows there.
  for (const [fileId, albumId] of pinned) {
    const f = inScope.find((x) => x.id === fileId);
    if (f) await replaceTracks(ctx, albumId ?? null, [f], resolveDiscs([f]));
  }

  // Clusters in scope that lost every track to regrouping are dead weight;
  // only untouched states are safe to reap.
  await ctx.sql`
    delete from local_albums la
    where la.library_id = ${data.libraryId}
      and la.state in ('pending', 'unidentified')
      and ${scope === '' ? ctx.sql`true` : ctx.sql`la.dir_paths && ARRAY[${scope}]::text[]`}
      and not exists (select 1 from local_tracks lt where lt.local_album_id = la.id)`;

  // Merging sibling folders supersedes the per-folder clusters they used to
  // form, and those are exactly the ones the query above cannot reach: a new
  // cluster_key means a new row, the old row keeps whatever state it reached
  // (the two-CD bug left both halves 'matched' against a one-disc release),
  // and its dir_paths name the sibling folder, never the parent scope. So the
  // directories this run actually touched are swept for zero-track clusters in
  // any state — nothing owns those files any more.
  const touchedDirs = new Set<string>([scope, ...(siblingDirs ?? [])]);
  for (const f of inScope) touchedDirs.add(relDirname(f.relPath));
  const superseded = (await ctx.sql`
    delete from local_albums la
    where la.library_id = ${data.libraryId}
      and la.dir_paths && ${[...touchedDirs]}::text[]
      and not exists (select 1 from local_tracks lt where lt.local_album_id = la.id)
    returning la.id, la.state, la.title_guess`) as unknown as Array<{ id: string; state: string; title_guess: string | null }>;
  if (superseded.length > 0) {
    ctx.logger.info({ scope, retired: superseded }, 'retired superseded local albums');
  }

  ctx.logger.debug(
    { scope, siblingDirs, groups: groups.size, loose: loose.length, pinned: pinned.size },
    'clustered directory',
  );
}

/** LIKE is used for path prefixes; the archive has folders with '%' and '_'. */
function likeEscape(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Directories one level under `parent` that hold audio files (directly or in
 * a disc subfolder). Postgres does the distinct, so an artist folder costs one
 * small result set rather than every row under it.
 */
async function subdirsOf(ctx: WorkerContext, scanRootId: string, parent: string): Promise<string[]> {
  const prefix = parent === '' ? '' : parent + '/';
  const rows = (await ctx.sql`
    select distinct case when strpos(rel_path, '/') = 0 then ''
                         else regexp_replace(rel_path, '/[^/]*$', '') end as dir
    from audio_files
    where scan_root_id = ${scanRootId}
      and status in ('present', 'error')
      and rel_path like ${likeEscape(prefix) + '%'}`) as unknown as Array<{ dir: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    let d = r.dir;
    if (parent !== '' && !d.startsWith(prefix)) continue;
    // Walk up to the child of `parent` (a file may sit in "…/Album CD1/CD1").
    while (d !== '' && relDirname(d) !== parent) d = relDirname(d);
    if (d !== '' && relDirname(d) === parent) out.add(d);
  }
  return [...out];
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

async function replaceTracks(
  ctx: WorkerContext,
  albumId: string | null,
  files: FileRow[],
  discs: Map<string, number | null>,
): Promise<void> {
  await ctx.db.delete(localTracks).where(inArray(localTracks.audioFileId, files.map((f) => f.id)));

  // null disc_no keeps meaning "no disc information" for an ordinary
  // single-disc album. Inside a cluster that spans discs the distinction is
  // gone — an unnumbered file is disc 1 of the set (a box set whose disc 1
  // carries no "n-tt" prefix) — so it is written out, and every reader sees a
  // disc number on every track of a multi-disc album.
  const multiDisc = new Set([...discs.values()].map((d) => d ?? 1)).size >= 2;

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
    const discNo = discs.get(f.id) ?? (multiDisc ? 1 : null);

    if (f.virtual) {
      // Virtual tracks: one row per track from the cue sheet
      const vt = f.virtual;
      for (const track of vt.tracks) {
        rows.push({
          localAlbumId: albumId,
          audioFileId: f.id,
          discNo,
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
        discNo,
        trackNo: f.tags.track ?? filenameDiscPrefix(name)?.track ?? trackNoFromName(name),
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
