/**
 * "Treat as one album": several local albums become one without moving a
 * file, and split back again.
 *
 * A compilation whose files were tagged one way or filed across folders
 * ("#/02. Stephane Pompougnac/2008 - Hotel Costes Vol. 11/02 - ….mp3", one
 * folder per track) clusters into one album per file. Merging pins every
 * file of the selection to one album through cluster_overrides (IDN-4), the
 * same mechanism the lossless/lossy split uses, so every later scan keeps
 * the merge. The kept album (the target) keeps its id, page and history; the
 * others are removed once their tracks have moved. The target's cluster key
 * becomes "merge:<its old key>", which marks it as merged and remembers the
 * key to go back to.
 *
 * What the merge changed is kept on the target (local_albums.merged_from,
 * migration 0029): the target's identification before the merge, and per
 * merged album its id, key, identification, files and album-level locks.
 * Album-level locks of the merged albums become per-file locks on their
 * files, so a lock keeps protecting exactly the files it protected.
 *
 * Split back removes the pins, recreates every merged album with its own id,
 * key and identification, moves its files back, turns its per-file locks
 * back into album locks, restores the target's identification (a match made
 * for the merged whole does not fit the part that is left), and re-clusters
 * the folders so the usual rules confirm the result.
 */
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { audioFiles, clusterOverrides, fieldLocks, localAlbums, localTracks } from '@liner/db';
import { VARIOUS_ARTISTS, displayArtistName, isVariousArtists, stripTrackNumberPrefix } from '@liner/shared';
import type { getDb } from '../db.js';
import { SPLIT_KEY_PREFIX } from './splitByFormat.js';

type Db = ReturnType<typeof getDb>;

export const MERGE_KEY_PREFIX = 'merge:';
/** One click never merges a whole shelf by accident. */
export const MERGE_MAX_ALBUMS = 200;

export class MergeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** true when the album was built by mergeAlbums */
export function isMergedKey(clusterKey: string | null | undefined): boolean {
  return !!clusterKey && clusterKey.startsWith(MERGE_KEY_PREFIX);
}

/** the cluster key the album had before it was merged, or null */
export function mergedOriginalKey(clusterKey: string | null | undefined): string | null {
  if (!isMergedKey(clusterKey)) return null;
  const rest = clusterKey!.slice(MERGE_KEY_PREFIX.length);
  return rest || null;
}

/** A Postgres array literal: drizzle would expand a JS array into a record. */
const pgUuidArray = (ids: string[]) => `{${ids.join(',')}}`;

const relDirname = (relPath: string) => {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
};

export interface MergeTrack {
  artist: string | null;
  albumartist?: string | null;
  trackNo?: number | null;
}

/**
 * The album artist a merged album shows: the album artist every file agrees
 * on once a baked-in track number is stripped ("02. Stephane Pompougnac" →
 * "Stephane Pompougnac"), else "Various Artists" when the track artists
 * differ, else the one track artist.
 */
export function mergedArtistGuess(tracks: MergeTrack[], fallback: string | null): string | null {
  const albumArtists = new Set(
    tracks
      .map((t) => (t.albumartist ? stripTrackNumberPrefix(t.albumartist, t.trackNo ?? null) : null))
      .filter((a): a is string => !!a)
      .map((a) => (isVariousArtists(a) ? VARIOUS_ARTISTS : a)),
  );
  if (albumArtists.size === 1) return [...albumArtists][0]!;
  const artists = new Set(tracks.map((t) => t.artist?.trim().toLowerCase()).filter(Boolean));
  if (artists.size > 1 || albumArtists.size > 1) return VARIOUS_ARTISTS;
  const one = tracks.find((t) => t.artist)?.artist ?? null;
  return one ?? displayArtistName(fallback);
}

/** Most common non-empty value, first seen wins a tie. */
function mostCommon<T>(values: Array<T | null | undefined>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (v !== null && v !== undefined && v !== '') counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

/** Identification fields a merge may change and split back restores. */
interface IdentState {
  state: string;
  releaseId: string | null;
  releaseGroupId: string | null;
  identifyReason: string | null;
  identifiedAt: string | null;
}

interface MergedSource extends IdentState {
  id: string;
  clusterKey: string;
  titleGuess: string | null;
  artistGuess: string | null;
  yearGuess: number | null;
  preferred: boolean | null;
  createdAt: string;
  fileIds: string[];
  /** album-level locks, as they were */
  locks: Array<{ field: string; value: unknown; reason: string | null; createdBy: string; createdAt: string }>;
}

/** local_albums.merged_from */
export interface MergeRecord {
  version: 1;
  target: IdentState;
  sources: MergedSource[];
  /** the per-file locks the merge created from the sources' album locks */
  fileLockIds: string[];
}

const identOf = (a: { state: string; releaseId: string | null; releaseGroupId: string | null; identifyReason: string | null; identifiedAt: Date | string | null }): IdentState => ({
  state: a.state,
  releaseId: a.releaseId,
  releaseGroupId: a.releaseGroupId,
  identifyReason: a.identifyReason,
  identifiedAt: a.identifiedAt ? new Date(a.identifiedAt).toISOString() : null,
});

const readRecord = (raw: unknown): MergeRecord | null => {
  const r = (typeof raw === 'string' ? JSON.parse(raw) : raw) as MergeRecord | null;
  return r && r.version === 1 && Array.isArray(r.sources) ? r : null;
};

export interface MergeAlbumsResult {
  albumId: string;
  mergedAlbumIds: string[];
  fileIds: string[];
  /** true when the kept album is not identified and should be (re)identified */
  needsIdentify: boolean;
}

/** Pick the album the others merge into: most tracks, then matched, then oldest. */
function pickTarget<T extends { id: string; trackCount: number | null; state: string; createdAt: Date }>(albums: T[]): T {
  return [...albums].sort((a, b) =>
    (b.trackCount ?? 0) - (a.trackCount ?? 0)
    || Number(b.state === 'matched') - Number(a.state === 'matched')
    || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0]!;
}

/** counters and folders of an album from its track rows (mirrors the worker's refreshAlbumCounters) */
export async function refreshAlbumCounters(db: Db, albumId: string): Promise<void> {
  await db.execute(sql`
    update local_albums la set
      track_count = s.n,
      total_duration_ms = s.dur,
      formats = s.formats,
      disc_count = greatest(s.discs, 1),
      dir_paths = s.dirs,
      updated_at = now()
    from (
      select count(*)::int as n,
             coalesce(sum(lt.duration_ms), 0)::int as dur,
             coalesce(array_agg(distinct lower(regexp_replace(af.rel_path, '^.*\\.', ''))) filter (where af.rel_path like '%.%'), '{}') as formats,
             count(distinct coalesce(lt.disc_no, 1))::int as discs,
             array_agg(distinct case when strpos(af.rel_path, '/') = 0 then '' else regexp_replace(af.rel_path, '/[^/]*$', '') end) as dirs
        from local_tracks lt join audio_files af on af.id = lt.audio_file_id
       where lt.local_album_id = ${albumId}
    ) s
    where la.id = ${albumId} and s.n > 0`);
}

export async function mergeAlbums(
  db: Db,
  input: { libraryId: string; albumIds: string[]; userId: string; targetId?: string },
): Promise<MergeAlbumsResult> {
  const ids = [...new Set(input.albumIds)];
  if (input.targetId && !ids.includes(input.targetId)) ids.unshift(input.targetId);
  if (ids.length < 2) throw new MergeError(400, 'Pick at least two albums to treat as one');
  if (ids.length > MERGE_MAX_ALBUMS) throw new MergeError(400, `At most ${MERGE_MAX_ALBUMS} albums can be merged at once`);

  return db.transaction(async (tx) => {
    const albums = await tx.select().from(localAlbums)
      .where(and(eq(localAlbums.libraryId, input.libraryId), inArray(localAlbums.id, ids)))
      .for('update');
    if (albums.length !== ids.length) throw new MergeError(404, 'Some of these albums are not in this library');
    const split = albums.find((a) => a.clusterKey.startsWith(SPLIT_KEY_PREFIX));
    if (split) throw new MergeError(409, `"${split.titleGuess ?? 'An album'}" is a split-off copy; merge it back first`);

    const target = input.targetId ? albums.find((a) => a.id === input.targetId)! : pickTarget(albums);
    const sources = albums.filter((a) => a.id !== target.id);
    const sourceIds = sources.map((a) => a.id);

    // An album that was itself merged from others is split back first: one
    // level of merge keeps split back exact.
    const nested = sources.find((a) => isMergedKey(a.clusterKey));
    if (nested) throw new MergeError(409, `"${nested.titleGuess ?? 'An album'}" was already made from several albums; split it back first, or keep it and merge the others into it`);

    // A source that has a split-off copy would take the copy's "Merge back"
    // target with it when it goes.
    if (sourceIds.length > 0) {
      const [origin] = await tx.select({ id: localAlbums.id, title: localAlbums.titleGuess }).from(localAlbums)
        .where(and(
          eq(localAlbums.libraryId, input.libraryId),
          or(...sourceIds.map((id) => like(localAlbums.clusterKey, `${SPLIT_KEY_PREFIX}${id}:%`))),
        ))
        .limit(1);
      if (origin) throw new MergeError(409, `"${origin.title ?? 'An album'}" was split off one of these albums; merge it back first`);
    }

    // Pieces fit together; two copies of the same tracks are duplicates, and
    // merging them would put two track 1s on one album.
    const clash = (await tx.execute(sql`
      select a.track_no, coalesce(a.disc_no, 1) as disc_no
        from local_tracks a
        join local_tracks b on b.track_no = a.track_no
                           and coalesce(b.disc_no, 1) = coalesce(a.disc_no, 1)
                           and b.local_album_id <> a.local_album_id
       where a.local_album_id = any(${pgUuidArray(ids)}::uuid[])
         and b.local_album_id = any(${pgUuidArray(ids)}::uuid[])
         and a.track_no is not null
       limit 1`)) as unknown as Array<{ track_no: number; disc_no: number }>;
    if (clash[0]) {
      throw new MergeError(409, `Two of these albums both have track ${clash[0].track_no}${clash[0].disc_no > 1 ? ` on disc ${clash[0].disc_no}` : ''}; they look like copies of the same tracks rather than pieces of one album`);
    }

    const rows = await tx
      .select({
        audioFileId: localTracks.audioFileId,
        localAlbumId: localTracks.localAlbumId,
        artist: localTracks.artistGuess,
        trackNo: localTracks.trackNo,
        tagsRaw: audioFiles.tagsRaw,
      })
      .from(localTracks)
      .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
      .where(inArray(localTracks.localAlbumId, ids));
    const fileIds = [...new Set(rows.map((r) => r.audioFileId))];
    if (fileIds.length === 0) throw new MergeError(409, 'These albums have no files left to merge');

    // Pin every file (the target's own too): a rescan of any of these folders
    // then leaves the merged album alone instead of re-forming the old ones.
    await tx.delete(clusterOverrides).where(inArray(clusterOverrides.audioFileId, fileIds));
    for (let i = 0; i < fileIds.length; i += 500) {
      await tx.insert(clusterOverrides).values(fileIds.slice(i, i + 500).map((audioFileId) => ({
        libraryId: input.libraryId,
        audioFileId,
        localAlbumId: target.id,
        createdBy: input.userId,
      })));
    }
    // What split back needs, per source: who it was, its files, its locks.
    const filesBySource = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.localAlbumId || r.localAlbumId === target.id) continue;
      const set = filesBySource.get(r.localAlbumId) ?? new Set<string>();
      set.add(r.audioFileId);
      filesBySource.set(r.localAlbumId, set);
    }
    const sourceLocks = sourceIds.length === 0 ? [] : await tx.select().from(fieldLocks)
      .where(and(eq(fieldLocks.libraryId, input.libraryId), eq(fieldLocks.scope, 'album'), inArray(fieldLocks.scopeId, sourceIds)));
    const previous = readRecord(target.mergedFrom);
    const record: MergeRecord = {
      version: 1,
      // merging more into an album that is already merged keeps the state
      // from before the first merge
      target: previous?.target ?? identOf(target),
      sources: [
        ...(previous?.sources ?? []),
        ...sources.map((a): MergedSource => ({
          id: a.id,
          clusterKey: a.clusterKey,
          titleGuess: a.titleGuess,
          artistGuess: a.artistGuess,
          yearGuess: a.yearGuess,
          preferred: a.preferred,
          createdAt: new Date(a.createdAt).toISOString(),
          ...identOf(a),
          fileIds: [...(filesBySource.get(a.id) ?? [])],
          locks: sourceLocks.filter((l) => l.scopeId === a.id).map((l) => ({
            field: l.field, value: l.value, reason: l.reason, createdBy: l.createdBy, createdAt: new Date(l.createdAt).toISOString(),
          })),
        })),
      ],
      fileLockIds: [...(previous?.fileLockIds ?? [])],
    };

    // An album lock on a piece protected that piece's files: it becomes a
    // lock on each of those files (track scope by audio file id, which
    // survives rescans), never a lock on the whole merged album.
    for (const lock of sourceLocks) {
      for (const audioFileId of filesBySource.get(lock.scopeId) ?? []) {
        const [made] = await tx.insert(fieldLocks).values({
          libraryId: input.libraryId,
          scope: 'track',
          scopeId: audioFileId,
          field: lock.field,
          value: lock.value,
          reason: lock.reason ?? 'kept from an album merged by "Treat as one album"',
          createdBy: lock.createdBy,
        }).returning({ id: fieldLocks.id });
        if (made) record.fileLockIds.push(made.id);
      }
    }
    if (sourceLocks.length > 0) await tx.delete(fieldLocks).where(inArray(fieldLocks.id, sourceLocks.map((l) => l.id)));

    // Tracks move before the source albums go (deleting an album cascades to
    // its track rows). A moved track's link belonged to another album's match.
    if (sourceIds.length > 0) {
      await tx.update(localTracks)
        .set({ localAlbumId: target.id, canonicalTrackId: null, state: 'unmatched' })
        .where(inArray(localTracks.localAlbumId, sourceIds));
      await tx.delete(localAlbums).where(inArray(localAlbums.id, sourceIds));
    }

    const tagOf = (raw: unknown, k: string): string | null => {
      const common = ((typeof raw === 'string' ? JSON.parse(raw) : raw) as { common?: Record<string, unknown> } | null)?.common ?? {};
      const v = common[k];
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    const artistGuess = mergedArtistGuess(
      rows.map((r) => ({ artist: r.artist ?? tagOf(r.tagsRaw, 'artist'), albumartist: tagOf(r.tagsRaw, 'albumartist'), trackNo: r.trackNo })),
      target.artistGuess,
    );
    const titleGuess = target.titleGuess ?? mostCommon(albums.map((a) => a.titleGuess));
    const yearGuess = target.yearGuess ?? mostCommon(albums.map((a) => a.yearGuess));
    const originalKey = mergedOriginalKey(target.clusterKey) ?? target.clusterKey;
    const matched = target.state === 'matched';

    await tx.update(localAlbums).set({
      clusterKey: `${MERGE_KEY_PREFIX}${originalKey}`,
      mergedFrom: record,
      titleGuess,
      artistGuess,
      yearGuess,
      // A matched album keeps its match (strays joined it); its tracks relink.
      // Anything else starts identification over with every track in view.
      ...(matched ? {} : { state: 'pending', identifyReason: null, releaseId: null, releaseGroupId: null }),
      tracksLinkedAt: null,
      updatedAt: new Date(),
    }).where(eq(localAlbums.id, target.id));
    await refreshAlbumCounters(tx as unknown as Db, target.id);

    return { albumId: target.id, mergedAlbumIds: sourceIds, fileIds, needsIdentify: !matched };
  });
}

export interface UnmergeResult {
  albumId: string;
  fileIds: string[];
  /** (scanRootId, rel dir) pairs to re-cluster */
  dirs: Array<{ scanRootId: string; dirPath: string }>;
  /** albums recreated with their own ids */
  restoredAlbumIds: string[];
}

/**
 * Undo mergeAlbums: unpin the files, recreate the merged albums as they were
 * (id, key, identification, files, album locks), put the kept album's
 * identification back to what it was before the merge, and hand the folders
 * to the clustering rules to confirm.
 */
export async function unmergeAlbum(db: Db, input: { libraryId: string; albumId: string }): Promise<UnmergeResult> {
  return db.transaction(async (tx) => {
    const [album] = await tx.select().from(localAlbums)
      .where(and(eq(localAlbums.id, input.albumId), eq(localAlbums.libraryId, input.libraryId)))
      .for('update');
    if (!album) throw new MergeError(404, 'Album not found');
    const originalKey = mergedOriginalKey(album.clusterKey);
    if (!originalKey) throw new MergeError(409, 'This album was not merged from others');
    const record = readRecord(album.mergedFrom);

    const files = await tx
      .select({ audioFileId: localTracks.audioFileId, relPath: audioFiles.relPath, scanRootId: audioFiles.scanRootId })
      .from(localTracks)
      .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
      .where(eq(localTracks.localAlbumId, album.id));
    const pins = await tx
      .select({ audioFileId: clusterOverrides.audioFileId, relPath: audioFiles.relPath, scanRootId: audioFiles.scanRootId })
      .from(clusterOverrides)
      .innerJoin(audioFiles, eq(audioFiles.id, clusterOverrides.audioFileId))
      .where(eq(clusterOverrides.localAlbumId, album.id));
    const all = [...files, ...pins];
    const fileIds = [...new Set(all.map((f) => f.audioFileId))];
    const dirs = [...new Map(all.map((f) => [`${f.scanRootId}\n${relDirname(f.relPath)}`, { scanRootId: f.scanRootId, dirPath: relDirname(f.relPath) }])).values()];

    await tx.delete(clusterOverrides).where(eq(clusterOverrides.localAlbumId, album.id));
    // The key goes first so a source that had the same key cannot collide.
    const keyOwner = async (key: string) => (await tx.select({ id: localAlbums.id }).from(localAlbums)
      .where(and(eq(localAlbums.libraryId, input.libraryId), eq(localAlbums.clusterKey, key))))[0];
    await tx.update(localAlbums).set({ clusterKey: `unmerged:${album.id}` }).where(eq(localAlbums.id, album.id));

    const present = new Set(fileIds);
    for (const src of record?.sources ?? []) {
      const moving = src.fileIds.filter((id) => present.has(id));
      if (moving.length === 0) continue; // its files are gone; nothing to give back
      const taken = await keyOwner(src.clusterKey);
      await tx.insert(localAlbums).values({
        id: src.id,
        libraryId: input.libraryId,
        // Should another album hold that key by now, this one gets a key
        // nothing produces; the re-cluster then decides where its files go.
        clusterKey: taken ? `unmerged:${src.id}` : src.clusterKey,
        titleGuess: src.titleGuess,
        artistGuess: src.artistGuess,
        yearGuess: src.yearGuess,
        preferred: src.preferred ?? false,
        state: src.state,
        releaseId: src.releaseId,
        releaseGroupId: src.releaseGroupId,
        identifyReason: src.identifyReason,
        identifiedAt: src.identifiedAt ? new Date(src.identifiedAt) : null,
        createdAt: new Date(src.createdAt),
      }).onConflictDoNothing({ target: localAlbums.id });
      await tx.update(localTracks)
        .set({ localAlbumId: src.id, canonicalTrackId: null, state: 'unmatched' })
        .where(and(eq(localTracks.localAlbumId, album.id), inArray(localTracks.audioFileId, moving)));
      for (const l of src.locks) {
        await tx.insert(fieldLocks).values({
          libraryId: input.libraryId, scope: 'album', scopeId: src.id,
          field: l.field, value: l.value, reason: l.reason, createdBy: l.createdBy, createdAt: new Date(l.createdAt),
        });
      }
      await refreshAlbumCounters(tx as unknown as Db, src.id);
    }
    if (record && record.fileLockIds.length > 0) {
      await tx.delete(fieldLocks).where(inArray(fieldLocks.id, record.fileLockIds));
    }

    // The kept album goes back to its own key and to the identification it
    // had before the merge. Without a record (a merge from before 0029), a
    // match can only belong to the merged whole, so identification restarts.
    const taken = await keyOwner(originalKey);
    const ident: IdentState = record?.target
      ?? (album.state === 'matched'
        ? { state: 'pending', releaseId: null, releaseGroupId: null, identifyReason: null, identifiedAt: null }
        : identOf(album));
    await tx.update(localAlbums).set({
      clusterKey: taken ? `unmerged:${album.id}` : originalKey,
      mergedFrom: null,
      state: ident.state,
      releaseId: ident.releaseId,
      releaseGroupId: ident.releaseGroupId,
      identifyReason: ident.identifyReason,
      identifiedAt: ident.identifiedAt ? new Date(ident.identifiedAt) : null,
      tracksLinkedAt: null,
      updatedAt: new Date(),
    }).where(eq(localAlbums.id, album.id));
    await tx.update(localTracks)
      .set({ canonicalTrackId: null, state: 'unmatched' })
      .where(eq(localTracks.localAlbumId, album.id));
    await refreshAlbumCounters(tx as unknown as Db, album.id);

    return { albumId: album.id, fileIds, dirs, restoredAlbumIds: (record?.sources ?? []).map((s) => s.id) };
  });
}

export interface MergeCandidate {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  trackCount: number | null;
  state: string;
  dirPaths: string[];
}

/**
 * Albums that look like more pieces of this one: the same title (and year,
 * when both have one), no track number in common with it (pieces fit
 * together; a second copy of the same album overlaps and is a duplicate, not
 * a piece), and either the same shown artist or one side tiny (a track or
 * three: one folder per track). "Greatest Hits" by two bands does not qualify.
 */
export async function findMergeCandidates(db: Db, input: { libraryId: string; albumId: string; limit?: number }): Promise<MergeCandidate[]> {
  const [album] = await db.select().from(localAlbums)
    .where(and(eq(localAlbums.id, input.albumId), eq(localAlbums.libraryId, input.libraryId)));
  if (!album || !album.titleGuess) return [];
  const small = (album.trackCount ?? 0) <= 3;
  const rows = (await db.execute(sql`
    select la.id, la.title_guess, la.artist_guess, la.year_guess, la.track_count, la.state, la.dir_paths
      from local_albums la
     where la.library_id = ${input.libraryId}
       and la.id <> ${album.id}
       and la.cluster_key not like 'split:%'
       and la.cluster_key not like 'merge:%'
       and not exists (select 1 from local_albums s
                        where s.library_id = la.library_id and s.cluster_key like 'split:' || la.id::text || ':%')
       and lower(btrim(la.title_guess)) = lower(btrim(${album.titleGuess}))
       and (la.year_guess is null or ${album.yearGuess}::int is null or la.year_guess = ${album.yearGuess}::int)
       and (
         liner_display_artist(la.artist_guess) is not distinct from liner_display_artist(${album.artistGuess}::text)
         or ${small}::boolean
         or coalesce(la.track_count, 0) <= 3
       )
       and not exists (
         select 1 from local_tracks a
           join local_tracks b on b.local_album_id = ${album.id}
                              and b.track_no = a.track_no
                              and coalesce(b.disc_no, 1) = coalesce(a.disc_no, 1)
          where a.local_album_id = la.id and a.track_no is not null)
     order by la.dir_paths
     limit ${input.limit ?? 100}`)) as unknown as Array<{
    id: string; title_guess: string | null; artist_guess: string | null; year_guess: number | null;
    track_count: number | null; state: string; dir_paths: string[] | string | null;
  }>;
  // Candidates must also fit one another: the merge refuses two albums that
  // share a track number, so a second copy among them is left out (first
  // come by folder order wins, the album itself always does).
  const numbers = rows.length === 0 ? [] : (await db.execute(sql`
    select local_album_id::text as id, coalesce(disc_no, 1) as disc, track_no as track
      from local_tracks
     where local_album_id = any(${pgUuidArray([album.id, ...rows.map((r) => r.id)])}::uuid[]) and track_no is not null`)) as unknown as Array<{ id: string; disc: number; track: number }>;
  const byAlbum = new Map<string, string[]>();
  for (const n of numbers) {
    const list = byAlbum.get(n.id) ?? [];
    list.push(`${n.disc}:${n.track}`);
    byAlbum.set(n.id, list);
  }
  const taken = new Set(byAlbum.get(album.id) ?? []);
  const fitting = rows.filter((r) => {
    const mine = byAlbum.get(r.id) ?? [];
    if (mine.some((k) => taken.has(k))) return false;
    for (const k of mine) taken.add(k);
    return true;
  });
  return fitting.map((r) => ({
    id: r.id,
    title: r.title_guess,
    artist: displayArtistName(r.artist_guess),
    year: r.year_guess,
    trackCount: r.track_count,
    state: r.state,
    dirPaths: Array.isArray(r.dir_paths) ? r.dir_paths : [],
  }));
}
