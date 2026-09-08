/**
 * tags.preview (spec §9.5 TAG-3): for every file in the plan's scope, compare
 * the tags the scanner read (audio_files.tags_raw.common, mapped to the
 * canonical field set) with the canonical values resolved from the album's
 * matched release, apply the policy, and store one tag_plan_items row per
 * file with its diff. No disk writes. Ends by setting the plan to
 * 'previewed' with the aggregate.
 *
 * Rules that keep the preview honest:
 * - a file whose album is not identified is skipped (nothing canonical to
 *   write), and says so;
 * - a field whose canonical value is unknown is never changed — no policy
 *   blanks a tag because the provider had no data;
 * - arrays compare as sets (genre order or a duplicate is not a change).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  audioFiles,
  localAlbums,
  localTracks,
  releaseGroupArtists,
  scanRoots,
  tagPlanItems,
  tagPlans,
} from '@liner/db';
import { CanonicalField, type TagPlanScope, type TagPolicies, type TagDiffEntry, type TagPlanStats } from '@liner/shared';
import type { WorkerContext } from '../lib/context.js';
import { resolveMetadataForFile } from '../lib/resolvedMetadata.js';

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
    case 'custom':
    default:
      return 'never';
  }
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

/**
 * The file's current tags as canonical fields, from music-metadata's
 * `common` block (what scan.parse stored in tags_raw).
 */
export function currentFieldsFrom(tagsRaw: unknown): Partial<Record<CanonicalField, Value>> {
  const root = (typeof tagsRaw === 'string' ? JSON.parse(tagsRaw) : tagsRaw) as { common?: Record<string, unknown> } | null;
  const c = root?.common ?? {};
  const str = (k: string): string | null => {
    const v = c[k];
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : null;
    if (Array.isArray(v) && v.length && (typeof v[0] === 'string' || typeof v[0] === 'number')) return String(v[0]).trim() || null;
    return null;
  };
  const arr = (k: string): string[] | null => {
    const v = c[k];
    if (Array.isArray(v)) {
      const out = v.map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : '')).filter(Boolean);
      return out.length ? out : null;
    }
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return null;
  };
  const no = (k: string, part: 'no' | 'of'): string | null => {
    const v = c[k] as { no?: unknown; of?: unknown } | undefined;
    const n = v?.[part];
    return typeof n === 'number' && n > 0 ? String(n) : typeof n === 'string' && n.trim() ? n.trim() : null;
  };
  const yearOf = (): string | null => (typeof c['year'] === 'number' && c['year'] > 0 ? String(c['year']) : null);

  const out: Partial<Record<CanonicalField, Value>> = {
    title: str('title'),
    artist: str('artist'),
    artistsort: str('artistsort'),
    album: str('album'),
    albumartist: str('albumartist'),
    albumartistsort: str('albumartistsort'),
    date: str('date') ?? yearOf(),
    originaldate: str('originaldate') ?? str('originalyear'),
    tracknumber: no('track', 'no'),
    totaltracks: no('track', 'of'),
    discnumber: no('disk', 'no'),
    totaldiscs: no('disk', 'of'),
    discsubtitle: str('discsubtitle'),
    genre: arr('genre'),
    compilation: c['compilation'] === true || c['compilation'] === 1 || c['compilation'] === '1' ? '1' : null,
    label: arr('label') ? arr('label')!.join('; ') : null,
    catalognumber: arr('catalognumber') ? arr('catalognumber')!.join('; ') : null,
    barcode: str('barcode'),
    media: str('media'),
    releasecountry: str('releasecountry'),
    releasestatus: str('releasestatus'),
    releasetype: arr('releasetype') ? arr('releasetype')!.join('; ') : null,
    isrc: arr('isrc'),
    musicbrainz_albumid: str('musicbrainz_albumid'),
    musicbrainz_releasegroupid: str('musicbrainz_releasegroupid'),
    musicbrainz_albumartistid: arr('musicbrainz_albumartistid'),
    musicbrainz_artistid: arr('musicbrainz_artistid'),
    musicbrainz_recordingid: str('musicbrainz_recordingid'),
    musicbrainz_releasetrackid: str('musicbrainz_trackid'),
    acoustid_id: str('acoustid_id'),
    discogs_release_id: str('discogs_release_id'),
    discogs_master_id: str('discogs_master_release_id'),
  };
  return out;
}

/** Audio file ids in scope; only present files, and (for albums) only tracks of those albums. */
async function enumerateFilesForScope(ctx: WorkerContext, libraryId: string, scope: TagPlanScope): Promise<string[]> {
  const db = ctx.db;
  if (scope.type === 'library') {
    const files = await db.select({ id: audioFiles.id }).from(audioFiles)
      .where(and(eq(audioFiles.libraryId, libraryId), eq(audioFiles.status, 'present')));
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

export async function tagsPreviewJob(ctx: WorkerContext, planId: string): Promise<void> {
  const db = ctx.db;
  const [plan] = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
  if (!plan) throw new Error(`Tag plan ${planId} not found`);

  const libraryId = plan.libraryId;
  const scope = plan.scope as TagPlanScope;
  const policy = plan.policy as TagPolicies;

  // One row per (plan, file): drop the previous preview's pending rows first.
  await db.delete(tagPlanItems).where(and(eq(tagPlanItems.tagPlanId, planId), inArray(tagPlanItems.status, ['pending', 'applying'])));

  const fileIds = await enumerateFilesForScope(ctx, libraryId, scope);
  const writableRoots = new Set(
    (await db.select({ id: scanRoots.id }).from(scanRoots).where(and(eq(scanRoots.libraryId, libraryId), eq(scanRoots.writable, true)))).map((r) => r.id),
  );

  let filesTouched = 0;
  let fieldsModified = 0;
  let lockedFieldsRespected = 0;
  const filesSkipped: TagPlanStats['filesSkipped'] = [];
  const fields = Object.values(CanonicalField) as CanonicalField[];

  for (const audioFileId of fileIds) {
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
      const resolution = await resolveMetadataForFile(ctx, libraryId, audioFileId);
      if (!resolution.ok) {
        filesSkipped.push({ audioFileId, reason: 'audio_file_error', message: resolution.reason.replaceAll('_', ' ') });
        continue;
      }

      const before = currentFieldsFrom(file.tagsRaw);
      const diffs: TagDiffEntry[] = [];
      const after: Partial<Record<CanonicalField, Value>> = {};
      for (const field of fields) {
        const resolved = resolution.value.resolved[field];
        const canonical: Value = resolved?.value === undefined ? null : resolved.value;
        const locked = resolved?.source === 'lock';
        const current: Value = before[field] ?? null;
        const decision = decideField(fieldPolicyFor(policy, field), current, canonical, locked);
        if (decision.reason === 'locked') {
          // a lock only counts when the policy would otherwise have changed the field
          if (fieldPolicyFor(policy, field) !== 'never' && valueKey(current) !== valueKey(canonical)) lockedFieldsRespected++;
          continue;
        }
        if (decision.reason === 'no-change') continue;
        diffs.push({ field, before: current, after: decision.after, reason: decision.reason });
        after[field] = decision.after;
        fieldsModified++;
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

  const stats: TagPlanStats = { filesTouched, fieldsModified, lockedFieldsRespected, filesSkipped };
  await db.update(tagPlans).set({ status: 'previewed', stats }).where(eq(tagPlans.id, planId));
  ctx.logger.info({ planId, files: fileIds.length, ...stats, filesSkipped: filesSkipped.length }, 'tags.preview done');
}
