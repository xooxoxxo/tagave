/**
 * The file half of Upgrade to FLAC: stage, publish, catalog, trash, and the
 * put-back. Every file call goes through the file gate (fileGate.ts), flac
 * runs guarded with the root, and the tag writer's sidecar counts against the
 * root. A music folder that goes offline throws FolderOfflineError out of
 * here: the task pauses for the owner's Continue with its swap checkpoint
 * kept (runMaintenance, Decision 2).
 */
import path from 'node:path';
import type { IAudioMetadata } from 'music-metadata';
import { writableRootIds, type FlacUpgradeSource } from '@tagave/db';
import { fileDigest, fileStat, insideRoot, mountIdentity, sameFile } from '../lib/fileRecovery.js';
import { ensureTrashDir, makeDirs, markLibraryDirty } from '../lib/deletions.js';
import { fileGate } from '../lib/fileGate.js';
import { FlacTools } from '../lib/flacTools.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';
import type { WorkerContext } from '../lib/context.js';
import type { MaintenanceRun } from '../lib/maintenance.js';
import { releaseTags, type CanonRow } from './filesSplit.js';
import { TRASH_DIR } from '@tagave/shared';
import { relDirname } from '../lib/helpers.js';

interface SwapFile {
  id: string;
  rel: string;
  replacement: string;
  final: string;
  source: string;
  holding: string;
  staged: string;
  trash: string;
  originalHash: string;
  replacementHash: string;
}

export type UpgradeOriginal = { path: string; hash: string };

export interface UpgradeSwap {
  scanRootId: string;
  root: string;
  mount: string;
  staging: string;
  phase: 'publish' | 'catalog' | 'trash' | 'complete';
  files: SwapFile[];
  scanAt?: number;
  catalogAt?: number;
  replacementAlbumId?: string;
}

const key = (disc: number, track: number) => `${disc}:${track}`;
const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

interface IncomingTrack {
  abs: string;
  digest: string;
  canon: CanonRow;
  title: string;
  lengthMs: number;
  releaseMbid: string | undefined;
}

function matches(track: IncomingTrack, edition: { title: string; lengthMs: number | null }): boolean {
  return !!edition.lengthMs && Math.abs(track.lengthMs - edition.lengthMs) <= 2000 && titleKey(edition.title) === titleKey(track.title);
}

async function verifiedEdition(ctx: WorkerContext, source: FlacUpgradeSource, paths: string[], poolRootId: string): Promise<IncomingTrack[]> {
  const canon = await ctx.sql<CanonRow[]>`
    select id, coalesce(medium_no, 1) as "mediumNo", position, number, title, length_ms as "lengthMs",
      artist_credit as "artistCredit", recording_mbid as "recordingMbid", track_mbid as "trackMbid"
    from canonical_tracks where release_id = ${source.releaseId}
      and not coalesce(is_data_track, false) and not coalesce(is_video, false) order by medium_no, position`;
  if (paths.length !== canon.length || paths.length !== source.files.length || new Set(paths).size !== paths.length) {
    throw new Error('The staged download is incomplete or contains duplicates.');
  }
  const byPosition = new Map(canon.map((t) => [key(t.mediumNo, t.position), t]));
  const found = new Map<string, IncomingTrack>();
  for (const abs of paths) {
    if (!(await fileStat(poolRootId, abs))?.isFile) throw new Error('An imported FLAC file is missing from the drop pool.');
    const digest = await fileDigest(poolRootId, abs);
    const { common, format } = await fileGate().run<IAudioMetadata>(poolRootId, { op: 'parseAudio', path: abs, options: { duration: true, skipCovers: true } });
    if (format.container?.toUpperCase() !== 'FLAC' || format.codec?.toUpperCase() !== 'FLAC') throw new Error('The staged download contains audio that is not FLAC.');
    const position = key(common.disk.no ?? 1, common.track.no ?? 0);
    const expected = byPosition.get(position);
    const track = expected && { abs, digest, canon: expected, title: common.title ?? '', lengthMs: (format.duration ?? 0) * 1000, releaseMbid: common.musicbrainz_albumid };
    if (!track || found.has(position) || !matches(track, expected!)) throw new Error('The staged track titles, numbers, or lengths do not match the owned edition.');
    if (track.releaseMbid && track.releaseMbid !== source.releaseMbid) throw new Error('The staged files are tagged as a different MusicBrainz edition.');
    if (expected!.recordingMbid && common.musicbrainz_recordingid && expected!.recordingMbid !== common.musicbrainz_recordingid) {
      throw new Error('A staged track has a different MusicBrainz recording.');
    }
    if (expected!.trackMbid && common.musicbrainz_trackid && expected!.trackMbid !== common.musicbrainz_trackid) {
      throw new Error('A staged track belongs to a different MusicBrainz edition.');
    }
    found.set(position, track);
  }
  const incoming = [...found.values()];
  if (incoming.some((t) => !t.releaseMbid)) {
    const others = await ctx.sql<{ id: string; disc: number; position: number; title: string; lengthMs: number | null }[]>`
      select r.id, coalesce(t.medium_no, 1) as disc, t.position, t.title, t.length_ms as "lengthMs"
      from releases r join canonical_tracks t on t.release_id = r.id
      where r.release_group_id = (select release_group_id from releases where id = ${source.releaseId})
        and r.id <> ${source.releaseId} and not coalesce(t.is_data_track, false) and not coalesce(t.is_video, false)`;
    const matching = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const other of others) {
      counts.set(other.id, (counts.get(other.id) ?? 0) + 1);
      const track = found.get(key(other.disc, other.position));
      if (track && matches(track, other)) matching.set(other.id, (matching.get(other.id) ?? 0) + 1);
    }
    if ([...matching].some(([id, count]) => count === canon.length && count === counts.get(id))) {
      throw new Error('More than one edition matches the staged tracks. Check the MusicBrainz release tags in the drop pool.');
    }
  }
  return source.files.map((file) => {
    const track = found.get(key(file.disc, file.position));
    if (!track) throw new Error('The owned files do not line up with the matched edition.');
    return track;
  });
}

/** `poolRootId`: the drop pool's music folder, where the imports are (it may be another one than the album's). */
export async function stageUpgrade(ctx: WorkerContext, claim: MaintenanceRun, source: FlacUpgradeSource, originals: UpgradeOriginal[], imports: string[], poolRootId: string = source.scanRootId): Promise<UpgradeSwap> {
  const { root, scanRootId } = source;
  const gate = fileGate();
  const mount = await mountIdentity(scanRootId, root);
  const staging = path.join(root, `.tagave-upgrade-${claim.row.id}`);
  const tracks = await verifiedEdition(ctx, source, imports, poolRootId);
  const tags = await releaseTags(ctx, source.releaseId, tracks.map((track) => track.canon));
  const files: SwapFile[] = [];
  const finals = new Set<string>();
  const tools = new FlacTools().forRoot(scanRootId);
  const writer = new MutagenTagWriter({ rootId: scanRootId });
  try {
    await claim.current();
    await makeDirs(scanRootId, staging);
    if (!(await fileStat(scanRootId, staging))?.isDirectory) throw new Error('The upgrade staging folder changed.');
    for (const [index, file] of source.files.entries()) {
      await claim.current();
      const track = tracks[index]!;
      const expected = originals[index]!;
      const original = expected.path;
      await insideRoot(scanRootId, root, original);
      const parsed = path.parse(file.rel);
      const replacement = path.join(parsed.dir, parsed.name + (parsed.ext.toLowerCase() === '.flac' ? ' (FLAC)' : '') + '.flac');
      const final = path.join(path.dirname(original), path.basename(replacement));
      if (finals.has(final.normalize('NFC')) || await fileStat(scanRootId, final.normalize('NFC')) || await fileStat(scanRootId, final.normalize('NFD'))) throw new Error(`A file is already at ${replacement}.`);
      finals.add(final.normalize('NFC'));
      const staged = path.join(staging, `track-${index}.flac`);
      const holding = path.join(staging, `original-${index}${parsed.ext}`);
      const trash = path.join(TRASH_DIR, `upgrade-${claim.row.id}`, file.rel);
      const originalHash = await fileDigest(scanRootId, original);
      if (originalHash !== expected.hash) throw new Error('An original file changed while Lidarr was downloading.');
      if (await fileStat(scanRootId, holding) || await fileStat(scanRootId, path.join(root, trash))) throw new Error('An upgrade recovery path is already in use.');
      await gate.run(scanRootId, { op: 'rm', path: staged, force: true });
      const incomingHash = track.digest;
      // a copy from the pool into the album's folder: in the helper, under the album's root (the side that is written)
      await gate.run(scanRootId, { op: 'copyFile', from: track.abs, to: staged, exclusive: true });
      if (await fileDigest(scanRootId, staged) !== incomingHash || await fileDigest(poolRootId, track.abs) !== incomingHash) {
        throw new Error('A staged download changed while it was copied.');
      }
      await writer.write(staged, tags.get(track.canon.id)!);
      const tagged = await gate.run<IAudioMetadata>(scanRootId, { op: 'parseAudio', path: staged, options: { skipCovers: true } });
      if (tagged.common.musicbrainz_albumid !== source.releaseMbid || tagged.common.track.no !== track.canon.position ||
          (tagged.common.disk.no ?? 1) !== track.canon.mediumNo || !await tools.decodes(staged)) {
        throw new Error(`Could not verify the tagged FLAC for track ${track.canon.position}.`);
      }
      files.push({ id: file.id, rel: file.rel, replacement, final, source: original, holding, staged, trash,
        originalHash, replacementHash: await fileDigest(scanRootId, staged) });
      await claim.update({ stage: 'Verifying and tagging FLAC tracks', progress: { done: files.length, total: tracks.length } });
    }
  } finally {
    await writer.close();
  }
  return { scanRootId, root, mount, staging, phase: 'publish', files };
}

async function verifyPath(rootId: string, root: string, file: string, digest: string): Promise<void> {
  await insideRoot(rootId, root, file);
  if (await fileDigest(rootId, file) !== digest) throw new Error(`A file changed during the upgrade: ${path.basename(file)}.`);
}

async function linkVerified(rootId: string, from: string, to: string): Promise<void> {
  const existing = await fileStat(rootId, to);
  if (!existing) {
    await fileGate().run(rootId, { op: 'link', from, to });
    return;
  }
  if (!sameFile(existing, await fileStat(rootId, from))) {
    throw new Error(`A different file is already at ${path.basename(to)}.`);
  }
}

export async function continueSwap(ctx: WorkerContext, claim: MaintenanceRun, swap: UpgradeSwap, releaseId: string, userId: string) {
  const { root, mount, staging, files, scanRootId } = swap;
  const gate = fileGate();
  const save = (stage: string) => claim.update({ stage, checkpoint: { swap }, progress: null });
  const [configured] = await ctx.sql<{ path: string }[]>`select path from scan_roots where id = ${scanRootId}`;
  // an offline folder throws FolderOfflineError here (the task pauses), never this error
  if (configured?.path !== root || await mountIdentity(scanRootId, root) !== mount ||
      !(await writableRootIds(ctx.sql, claim.row.library_id)).has(scanRootId)) {
    throw new Error('The original music mount is unavailable or read-only.');
  }

  if (swap.phase === 'publish') {
    if (!(await fileStat(scanRootId, staging))?.isDirectory) throw new Error('The verified upgrade staging folder is missing.');
    await save('Keeping a recoverable copy of the original');
    for (const file of files) {
      await verifyPath(scanRootId, root, file.staged, file.replacementHash);
      await claim.current();
      if (await fileStat(scanRootId, file.source)) {
        await verifyPath(scanRootId, root, file.source, file.originalHash);
        await linkVerified(scanRootId, file.source, file.holding);
      }
      await verifyPath(scanRootId, root, file.holding, file.originalHash);
    }
    await save('Publishing verified FLAC tracks');
    for (const file of files) {
      await claim.current();
      const final = file.final;
      await insideRoot(scanRootId, root, final);
      await linkVerified(scanRootId, file.staged, final);
      await verifyPath(scanRootId, root, final, file.replacementHash);
    }
    await claim.current();
    await ctx.sql.begin(async (tx) => {
      for (const file of files) {
        await tx`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, trash_rel_path, trash_mount, created_by)
          values (${file.id}, ${claim.row.library_id}, ${scanRootId}, 'trash', 'holding', ${file.rel}, ${file.trash}, ${mount}, ${userId})
          on conflict (file_id) do nothing`;
        const [held] = await tx`select file_id from file_deletions
          where file_id = ${file.id} and state = 'holding' and trash_rel_path = ${file.trash} for update`;
        if (!held) throw new Error('The original album was changed by another operation.');
      }
    });
    for (const file of files) {
      await claim.current();
      if (!(await fileStat(scanRootId, file.source))) continue;
      await verifyPath(scanRootId, root, file.source, file.originalHash);
      await verifyPath(scanRootId, root, file.holding, file.originalHash);
      await gate.run(scanRootId, { op: 'unlink', path: file.source });
    }
    swap.phase = 'catalog';
    swap.catalogAt = Date.now();
    await save('Waiting for the catalog to index the FLAC files');
  }

  if (swap.phase === 'catalog') {
    const paths = files.map((f) => f.replacement);
    for (const file of files) await verifyPath(scanRootId, root, file.final, file.replacementHash);
    const rows = await ctx.sql<{ path: string; albumId: string; releaseId: string | null; codec: string | null; trackCount: number }[]>`
      select distinct f.rel_path as path, la.id as "albumId", la.release_id as "releaseId", coalesce(f.codec, f.container) as codec, la.track_count as "trackCount"
      from files f join local_tracks lt on lt.audio_file_id = f.id join local_albums la on la.id = lt.local_album_id
      where f.scan_root_id = ${scanRootId} and f.status = 'present' and f.rel_path = any(${paths}::text[])
    `;
    const catalogued = rows.length === files.length && new Set(rows.map((r) => r.path)).size === files.length &&
      new Set(rows.map((r) => r.albumId)).size === 1 && rows.every((r) => r.trackCount === files.length && r.releaseId === releaseId && r.codec?.toLowerCase() === 'flac');
    if (!catalogued) {
      if (swap.catalogAt && Date.now() - swap.catalogAt > 30 * 60_000) {
        return { state: 'review' as const, stage: 'Catalog confirmation needed', error: 'The new FLAC files did not form the expected album in the catalog.' };
      }
      if (!swap.scanAt || Date.now() - swap.scanAt > 120_000) {
        for (const dirPath of new Set(paths.map(relDirname))) {
          await ctx.boss.send('scan.dir', { scanRootId, dirPath, reason: 'flac-upgrade' }, { singletonKey: `scan.dir:${scanRootId}:${dirPath}` });
        }
        swap.scanAt = Date.now();
      }
      return { stage: 'Waiting for the catalog to index the FLAC files', checkpoint: { swap }, pollAfterMs: 20_000, error: null };
    }
    swap.replacementAlbumId = rows[0]!.albumId;
    swap.phase = 'trash';
    await save('Moving the original into Trash');
  }

  if (swap.phase === 'trash') {
    await claim.current();
    await ensureTrashDir(scanRootId, root);
    for (const file of files) {
      await claim.current();
      await verifyPath(scanRootId, root, file.final, file.replacementHash);
      await verifyPath(scanRootId, root, file.holding, file.originalHash);
      const dest = path.join(root, file.trash);
      await insideRoot(scanRootId, path.join(root, TRASH_DIR), dest);
      await makeDirs(scanRootId, path.dirname(dest));
      await linkVerified(scanRootId, file.holding, dest);
      await verifyPath(scanRootId, root, dest, file.originalHash);
    }
    await claim.current();
    await ctx.sql.begin(async (tx) => {
      const finalized = await tx`update maintenance_tasks
        set checkpoint = ${JSON.stringify({ swap: { ...swap, phase: 'complete' } })}::text::jsonb,
            subject_id = coalesce(${swap.replacementAlbumId ?? null}::uuid, subject_id)
        where id = ${claim.row.id} and attempt_id = ${claim.row.attempt_id} and state = 'running'
          and checkpoint->'swap'->>'phase' = 'trash'`;
      if (!finalized.count) throw new Error('The upgrade task changed before Trash was recorded.');
      await tx`update file_deletions set state = 'trashed', trashed_at = now()
        where file_id = any(${files.map((f) => f.id)}::uuid[]) and state = 'holding'`;
      await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
        select library_id, ${userId}, 'album.flac-upgrade', 'local_album', subject_id,
          jsonb_build_object('taskId', id, 'files', ${files.length}::int, 'originalAlbumId', input->>'albumId')
        from maintenance_tasks where id = ${claim.row.id}`;
    });
  }

  await claim.current();
  if ((await fileStat(scanRootId, staging))?.isDirectory) await gate.run(scanRootId, { op: 'rm', path: staging, recursive: true });
  await markLibraryDirty(ctx, claim.row.library_id);
  return { state: 'done' as const, stage: 'FLAC upgrade complete. Original in Trash', checkpoint: null,
    progress: { done: files.length, total: files.length }, error: null };
}

/** Put every original back before removing any published replacement. */
export async function restoreUpgrade(ctx: WorkerContext, claim: MaintenanceRun, swap: UpgradeSwap) {
  const { root, mount, scanRootId, staging, files } = swap;
  const gate = fileGate();
  if (await mountIdentity(scanRootId, root) !== mount || !(await writableRootIds(ctx.sql, claim.row.library_id)).has(scanRootId)) {
    throw new Error('The original music mount is unavailable or read-only.');
  }
  await claim.update({ stage: 'Restoring the original album' });
  for (const file of files) {
    await claim.current();
    await insideRoot(scanRootId, root, file.source);
    if (!await fileStat(scanRootId, file.source)) {
      await verifyPath(scanRootId, root, file.holding, file.originalHash);
      await linkVerified(scanRootId, file.holding, file.source);
    }
    await verifyPath(scanRootId, root, file.source, file.originalHash);
  }
  for (const file of files) {
    await claim.current();
    const final = file.final;
    await insideRoot(scanRootId, root, final);
    const [published, staged] = await Promise.all([fileStat(scanRootId, final), fileStat(scanRootId, file.staged)]);
    if (sameFile(published, staged)) {
      await verifyPath(scanRootId, root, final, file.replacementHash);
      await gate.run(scanRootId, { op: 'unlink', path: final });
    }
  }
  await ctx.sql`delete from file_deletions where file_id = any(${files.map((f) => f.id)}::uuid[])
    and state = 'holding' and trash_rel_path = any(${files.map((f) => f.trash)}::text[])`;
  for (const dirPath of new Set(files.map((file) => relDirname(file.rel)))) {
    await ctx.boss.send('scan.dir', { scanRootId, dirPath, reason: 'flac-upgrade-restore' }, { singletonKey: `scan.dir:${scanRootId}:${dirPath}` });
  }
  await markLibraryDirty(ctx, claim.row.library_id);
  if ((await fileStat(scanRootId, staging))?.isDirectory) await gate.run(scanRootId, { op: 'rm', path: staging, recursive: true });
  return { state: 'cancelled' as const, stage: 'Original album restored', checkpoint: null, progress: null, error: null };
}
