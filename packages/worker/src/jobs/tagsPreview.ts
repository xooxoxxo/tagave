/**
 * tags.preview (spec §9.5 TAG-3): for every file in the plan's scope, compare
 * the tags the scanner read (audio_files.tags_raw.common, mapped to the
 * canonical field set) with the canonical values resolved from the album's
 * matched release, apply the policy, and store one tag_plan_items row per
 * file with its diff. No disk writes. Ends by setting the plan to
 * 'previewed' with the aggregate.
 *
 * The manual preset (bulk edit) compares against the values the owner typed
 * (policy.values) instead of a matched release, so it works for identified
 * and unidentified albums alike; locks still win.
 *
 * Rules that keep the preview honest:
 * - a file whose album is not identified is skipped under a canonical
 *   policy (nothing canonical to write), and says so with its album id;
 * - stats say why nothing changed: files already correct, files whose only
 *   changes a lock blocked, files skipped and why;
 * - a field whose canonical value is unknown is never changed — no policy
 *   blanks a tag because the provider had no data;
 * - arrays compare as sets (genre order or a duplicate is not a change).
 */
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  audioFiles,
  fieldLocks,
  localAlbums,
  localTracks,
  releaseGroupArtists,
  scanRoots,
  tagPlanItems,
  tagPlans,
} from '@liner/db';
import {
  CanonicalField, MANUAL_TAG_FIELDS,
  type ManualTagValues, type TagPlanScope, type TagPolicies, type TagDiffEntry, type TagPlanStats,
} from '@liner/shared';
import type { WorkerContext } from '../lib/context.js';
import { resolveMetadataForFile } from '../lib/resolvedMetadata.js';
import { currentFieldsFrom } from '../lib/canonicalTags.js';
import { linkAlbumTracks, ensureTrackMbids } from '../lib/trackLinks.js';
import { reportProgress, type ProgressUpdate } from './progress.js';

export { currentFieldsFrom };

type Value = string | string[] | null;
type FieldPolicy = 'overwrite' | 'fill' | 'never';

const OVERWRITE_IN_CANONICAL_PRESET = new Set<string>([
  'musicbrainz_albumid', 'musicbrainz_releasegroupid', 'musicbrainz_albumartistid', 'musicbrainz_artistid',
  'musicbrainz_recordingid', 'musicbrainz_releasetrackid', 'discogs_release_id', 'discogs_master_id',
  'album', 'albumartist', 'albumartistsort', 'date', 'originaldate',
  'tracknumber', 'totaltracks', 'discnumber', 'totaldiscs',
  'label', 'catalognumber', 'barcode', 'media', 'releasecountry', 'releasestatus', 'releasetype',
]);
const FILL_IN_CANONICAL_PRESET = new Set<string>(['title', 'artist', 'artistsort', 'genre', 'compilation', 'isrc']);

/**
 * Field policy from the preset (M2 plan Q5). Comments, lyrics, ratings and
 * anything outside the canonical set are never touched by any preset.
 */
export function presetPolicy(preset: TagPolicies['preset'], field: string): FieldPolicy {
  switch (preset) {
    case 'canonical_ids_and_fill':
      if (OVERWRITE_IN_CANONICAL_PRESET.has(field)) return 'overwrite';
      if (FILL_IN_CANONICAL_PRESET.has(field)) return 'fill';
      return 'never';
    case 'fill_blanks_only':
      return 'fill';
    case 'overwrite_all':
      return 'overwrite';
    case 'manual':
      // only the fields the owner filled in; see manualCanonical
      return (MANUAL_TAG_FIELDS as readonly string[]).includes(field) ? 'overwrite' : 'never';
    case 'custom':
    default:
      return 'never';
  }
}

/**
 * The "canonical" value per field for a manual plan: exactly what the owner
 * typed, nothing for fields left out (so they are never touched). A
 * compilation flag of '0' means "not a compilation": a file with no flag
 * already says that, so it compares equal to a blank.
 */
export function manualCanonical(values: ManualTagValues | undefined, field: string, before: Value): Value {
  if (!values) return null;
  const v = (values as Record<string, string | string[] | undefined>)[field];
  if (v === undefined) return null;
  if (field === 'compilation' && v === '0' && (isBlank(before) || before === '0')) return before;
  return v;
}

export function fieldPolicyFor(policy: TagPolicies, field: string): FieldPolicy {
  const override = policy.overrides ? (policy.overrides as Record<string, FieldPolicy | undefined>)[field] : undefined;
  return override ?? presetPolicy(policy.preset, field);
}

const isBlank = (v: Value | undefined): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Comparable form: trimmed strings, arrays as sorted sets, numbers as strings. */
export function valueKey(v: Value | undefined): string {
  if (isBlank(v)) return '';
  if (Array.isArray(v)) return JSON.stringify([...new Set(v.map((x) => String(x).trim()))].sort());
  return String(v).trim();
}

/**
 * Decide the after-value for one field. Returns the reason the diff carries;
 * 'no-change' rows are not stored.
 */
export function decideField(
  policy: FieldPolicy,
  before: Value,
  canonical: Value,
  locked: boolean,
): { after: Value; reason: TagDiffEntry['reason'] } {
  if (locked) return { after: before, reason: 'locked' };
  if (policy === 'never') return { after: before, reason: 'no-change' };
  if (isBlank(canonical)) return { after: before, reason: 'no-change' }; // never blank a tag from missing data
  if (valueKey(before) === valueKey(canonical)) return { after: before, reason: 'no-change' };
  if (policy === 'fill') {
    return isBlank(before) ? { after: canonical, reason: 'policy:fill' } : { after: before, reason: 'no-change' };
  }
  return { after: canonical, reason: 'policy:overwrite' };
}

const likeEscape = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/** Audio file ids in scope; only present files, and (for albums) only tracks of those albums. */
async function enumerateFilesForScope(ctx: WorkerContext, libraryId: string, scope: TagPlanScope): Promise<string[]> {
  const db = ctx.db;
  if (scope.type === 'library') {
    const files = await db.select({ id: audioFiles.id }).from(audioFiles)
      .where(and(eq(audioFiles.libraryId, libraryId), eq(audioFiles.status, 'present')));
    return files.map((f) => f.id);
  }
  if (scope.type === 'folder') {
    // Exactly the files under the folder, loose files included and files of
    // the same albums that live elsewhere left out.
    const dir = scope.dirPath.replace(/\/+$/, '');
    const files = await db.select({ id: audioFiles.id }).from(audioFiles)
      .where(and(
        eq(audioFiles.libraryId, libraryId),
        eq(audioFiles.status, 'present'),
        scope.scanRootId ? eq(audioFiles.scanRootId, scope.scanRootId) : undefined,
        like(audioFiles.relPath, `${likeEscape(dir)}/%`),
      ));
    return files.map((f) => f.id);
  }
  let albumIds: string[] = [];
  if (scope.type === 'albumIds') {
    albumIds = scope.albumIds;
  } else if (scope.type === 'artist') {
    const rows = await db
      .select({ id: localAlbums.id })
      .from(localAlbums)
      .where(and(
        eq(localAlbums.libraryId, libraryId),
        sql`${localAlbums.releaseGroupId} in (select release_group_id from release_group_artists where artist_id = ${scope.artistId})`,
      ));
    albumIds = rows.map((r) => r.id);
  } else {
    // filterQuery: the API resolves it to albumIds when the plan is created
    return [];
  }
  if (albumIds.length === 0) return [];
  const rows = await db
    .select({ audioFileId: localTracks.audioFileId })
    .from(localTracks)
    .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
    .where(and(inArray(localTracks.localAlbumId, albumIds), eq(audioFiles.status, 'present')));
  return [...new Set(rows.map((r) => r.audioFileId))];
}

void releaseGroupArtists; // referenced via raw SQL above; keeps the import meaningful for readers

/**
 * Locked fields for one file under a manual plan: file- and track-level locks
 * and album-level locks of the album the file is in. A manual value never
 * replaces a locked field; the lock's own value is what the owner chose.
 */
async function manualLocksFor(ctx: WorkerContext, libraryId: string, audioFileId: string): Promise<Set<string>> {
  const tracks = await ctx.db
    .select({ id: localTracks.id, localAlbumId: localTracks.localAlbumId })
    .from(localTracks)
    .where(eq(localTracks.audioFileId, audioFileId));
  const trackScopes = [audioFileId, ...tracks.map((t) => t.id)];
  const albumScopes = tracks.flatMap((t) => (t.localAlbumId ? [t.localAlbumId] : []));
  const rows = await ctx.db
    .select({ field: fieldLocks.field, scope: fieldLocks.scope, scopeId: fieldLocks.scopeId })
    .from(fieldLocks)
    .where(and(eq(fieldLocks.libraryId, libraryId), inArray(fieldLocks.scopeId, [...trackScopes, ...albumScopes])));
  return new Set(rows
    .filter((l) => (l.scope === 'track' && trackScopes.includes(l.scopeId)) || (l.scope === 'album' && albumScopes.includes(l.scopeId)))
    .map((l) => l.field));
}

/** How often the preview rewrites its job_runs row while it walks files. */
const PROGRESS_EVERY_MS = 1_000;

/**
 * The preview's row in job_runs, so Settings › Background activity lists it
 * and the plan page can show what it is doing while the owner waits.
 * Best effort: a failed progress write is logged, never fails the preview.
 */
function previewProgress(ctx: WorkerContext, libraryId: string, planId: string, pgbossId: string | undefined) {
  let rowId: string | null = null;
  let lastAt = 0;
  const write = async (u: Pick<ProgressUpdate, 'state' | 'done' | 'total' | 'message' | 'error'>) => {
    try {
      rowId = await reportProgress(ctx, rowId, {
        libraryId, type: 'tags.preview', subjectType: 'tag_plan', subjectId: planId,
        ...(pgbossId ? { pgbossId } : {}),
        ...u,
      });
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message, planId }, 'tags.preview progress write failed');
    }
  };
  const n = (x: number) => x.toLocaleString('en');
  const throttled = async (fn: () => Promise<void>) => {
    const now = Date.now();
    if (now - lastAt < PROGRESS_EVERY_MS) return;
    lastAt = now;
    await fn();
  };
  return {
    step: (message: string) => write({ state: 'running', message }),
    /** Rewrites the row at most once per PROGRESS_EVERY_MS, so a long step still shows movement. */
    albums: (done: number, total: number) => throttled(() =>
      write({ state: 'running', done, total, message: `Checking track links: ${n(done)} of ${n(total)} albums` })),
    /** Rewrites the row at most once per PROGRESS_EVERY_MS. */
    files: (done: number, total: number) => throttled(() =>
      write({ state: 'running', done, total, message: `Comparing tags: ${n(done)} of ${n(total)} files` })),
    done: (total: number) => write({ state: 'completed', done: total, total, message: `Compared ${n(total)} files` }),
    /** The plan changed mid-run; the preview queued by that change replaces this one. */
    superseded: () => write({ state: 'completed', message: 'Stopped early: the plan changed, so a newer check replaces this one' }),
    fail: (err: unknown) => write({ state: 'failed', error: err instanceof Error ? err.message : String(err) }),
  };
}
type PreviewProgress = ReturnType<typeof previewProgress>;

export async function tagsPreviewJob(ctx: WorkerContext, planId: string, opts: { pgbossId?: string } = {}): Promise<void> {
  const [plan] = await ctx.db.select().from(tagPlans).where(eq(tagPlans.id, planId));
  if (!plan) throw new Error(`Tag plan ${planId} not found`);
  const progress = previewProgress(ctx, plan.libraryId, planId, opts.pgbossId);
  try {
    await runPreview(ctx, plan, progress);
  } catch (err) {
    await progress.fail(err);
    throw err;
  }
}

async function runPreview(ctx: WorkerContext, plan: typeof tagPlans.$inferSelect, progress: PreviewProgress): Promise<void> {
  const db = ctx.db;
  const planId = plan.id;
  await progress.step('Finding the files in scope');

  const libraryId = plan.libraryId;
  const scope = plan.scope as TagPlanScope;
  const policy = plan.policy as TagPolicies;

  // A revert plan's items come from the journal of the plan it undoes; a
  // preview has nothing to recompute and must not replace them (a canonical
  // re-preview skipped every unidentified file and left the revert empty).
  if (policy.preset === 'revert') {
    await db.update(tagPlans).set({ status: 'previewed' })
      .where(and(eq(tagPlans.id, planId), eq(tagPlans.status, 'draft')));
    await progress.done(0);
    return;
  }

  // One row per (plan, file): drop the previous preview's pending rows first.
  await db.delete(tagPlanItems).where(and(eq(tagPlanItems.tagPlanId, planId), inArray(tagPlanItems.status, ['pending', 'applying'])));

  const fileIds = await enumerateFilesForScope(ctx, libraryId, scope);
  const writableRoots = new Set(
    (await db.select({ id: scanRoots.id }).from(scanRoots).where(and(eq(scanRoots.libraryId, libraryId), eq(scanRoots.writable, true)))).map((r) => r.id),
  );

  // 0026: before resolving, ensure tracks are linked and track mbids are fresh
  // for the matched albums that hold files in scope, and only those. This
  // used to select every matched album in the library, so a one-album plan
  // walked every matched album and release in turn, a few sequential queries
  // each plus a "tracks already have ids" marker write for most releases.
  // On a large library that alone outlasts the plan page's 30 s wait. One
  // array parameter, not a list, so a whole-library scope stays one query
  // under the bind-parameter limit.
  // A manual plan writes typed values, not canonical ones: nothing to link.
  const albumsInScope = fileIds.length === 0 || policy.preset === 'manual' ? [] : (await ctx.sql`
    select la.id::text as id, la.release_id::text as "releaseId", (la.tracks_linked_at is not null) as linked
      from local_albums la
     where la.library_id = ${libraryId}
       and la.state = 'matched'
       and la.release_id is not null
       and la.id in (select lt.local_album_id from local_tracks lt where lt.audio_file_id = any(${fileIds}::uuid[]))
  `) as unknown as Array<{ id: string; releaseId: string; linked: boolean }>;

  // Link albums that haven't been linked yet
  for (const [i, album] of albumsInScope.entries()) {
    await progress.albums(i, albumsInScope.length);
    if (!album.linked) await linkAlbumTracks(ctx, album.id);
  }

  // Ensure track mbids are fresh for each distinct release
  for (const releaseId of new Set(albumsInScope.map((a) => a.releaseId))) {
    await ensureTrackMbids(ctx, libraryId, releaseId);
  }

  let filesTouched = 0;
  let fieldsModified = 0;
  let lockedFieldsRespected = 0;
  let filesAlreadyCorrect = 0;
  let filesLockedOnly = 0;
  const filesSkipped: TagPlanStats['filesSkipped'] = [];
  const fields = Object.values(CanonicalField) as CanonicalField[];
  const manual = policy.preset === 'manual';

  for (const [i, audioFileId] of fileIds.entries()) {
    await progress.files(i, fileIds.length);
    try {
      const [file] = await db.select().from(audioFiles).where(eq(audioFiles.id, audioFileId));
      if (!file) {
        filesSkipped.push({ audioFileId, reason: 'audio_file_error', message: 'File not found' });
        continue;
      }
      if (!writableRoots.has(file.scanRootId)) {
        filesSkipped.push({ audioFileId, reason: 'scan_root_not_writable' });
        continue;
      }
      const before = currentFieldsFrom(file.tagsRaw);
      /** per field: the value to compare against, and whether a lock holds it */
      let target: (field: CanonicalField, current: Value) => { canonical: Value; locked: boolean };
      if (manual) {
        const locked = await manualLocksFor(ctx, libraryId, audioFileId);
        target = (field, current) => ({ canonical: manualCanonical(policy.values, field, current), locked: locked.has(field) });
      } else {
        const resolution = await resolveMetadataForFile(ctx, libraryId, audioFileId);
        if (!resolution.ok) {
          filesSkipped.push({
            audioFileId,
            reason: resolution.reason,
            message: resolution.reason.replaceAll('_', ' '),
            ...(resolution.localAlbumId ? { localAlbumId: resolution.localAlbumId } : {}),
          });
          continue;
        }
        const resolved = resolution.value.resolved;
        target = (field) => {
          const r = resolved[field];
          return { canonical: r?.value === undefined ? null : r.value, locked: r?.source === 'lock' };
        };
      }

      const diffs: TagDiffEntry[] = [];
      const after: Partial<Record<CanonicalField, Value>> = {};
      let blockedByLock = 0;
      for (const field of fields) {
        const current: Value = before[field] ?? null;
        const { canonical, locked } = target(field, current);
        const fieldPolicy = fieldPolicyFor(policy, field);
        const decision = decideField(fieldPolicy, current, canonical, locked);
        if (decision.reason === 'locked') {
          // a lock only counts when the policy would otherwise have changed the field
          if (fieldPolicy !== 'never' && !isBlank(canonical) && valueKey(current) !== valueKey(canonical)) {
            lockedFieldsRespected++;
            blockedByLock++;
          }
          continue;
        }
        if (decision.reason === 'no-change') continue;
        diffs.push({ field, before: current, after: decision.after, reason: decision.reason });
        after[field] = decision.after;
        fieldsModified++;
      }

      if (diffs.length === 0) {
        if (blockedByLock > 0) filesLockedOnly++;
        else filesAlreadyCorrect++;
      }
      if (diffs.length === 0) continue;
      filesTouched++;
      await db.insert(tagPlanItems).values({
        tagPlanId: planId,
        audioFileId,
        before,
        after,
        diff: diffs,
        status: 'pending',
      });
    } catch (err) {
      filesSkipped.push({ audioFileId, reason: 'audio_file_error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const stats: TagPlanStats = {
    filesTouched, fieldsModified, lockedFieldsRespected, filesSkipped,
    filesInScope: fileIds.length, filesAlreadyCorrect, filesLockedOnly,
  };
  // Only mark the plan previewed if its scope is still the one this run read
  // (albums added mid-run would otherwise look previewed when they are not)
  // and nothing has moved it past preview. The request that changed the
  // scope queued the preview that replaces this one.
  const scopeJson = typeof plan.scope === 'string' ? plan.scope : JSON.stringify(plan.scope);
  const marked = await db
    .update(tagPlans)
    .set({ status: 'previewed', stats })
    .where(and(
      eq(tagPlans.id, planId),
      inArray(tagPlans.status, ['draft', 'previewed']),
      sql`${tagPlans.scope} = ${scopeJson}::jsonb`,
    ))
    .returning({ id: tagPlans.id });
  if (marked.length === 0) {
    ctx.logger.info({ planId }, 'tags.preview superseded: the plan changed while it ran');
    await progress.superseded();
    return;
  }
  await progress.done(fileIds.length);
  ctx.logger.info({ planId, files: fileIds.length, ...stats, filesSkipped: filesSkipped.length }, 'tags.preview done');
}
